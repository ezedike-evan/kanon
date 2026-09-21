import { describe, expect, it, vi } from 'vitest';
import { PYTH_FEEDS } from '@kanon/spec';
import { loadConfig, type RelayerConfig } from './config';
import { relayOnce, reportOk } from './relay';
import type { ChainPort, ContractCall } from './port';

const BTC_SERIES = '0x1111111111111111111111111111111111111111' as const;
const ETH_SERIES = '0x2222222222222222222222222222222222222222' as const;
const PYTH = '0x2880aB155794e7179c9eE2e38200202908C17B43' as const;
const KEY = `0x${'ab'.repeat(32)}` as const;
const NOW = 1_760_000_000n;

const BTC = PYTH_FEEDS['BTC/USD']!;
const ETH = PYTH_FEEDS['ETH/USD']!;

const baseEnv = {
  RPC_URL: 'https://rpc.example',
  SERIES_ADDRESSES: `BTC/USD=${BTC_SERIES},ETH/USD=${ETH_SERIES}`,
};
const cfg = (env: Record<string, string> = {}, opts?: { dryRun?: boolean }): RelayerConfig =>
  loadConfig({ ...baseEnv, ...env }, opts);

interface SeriesState {
  feedId: string;
  cadence: bigint;
  last: bigint;
}

function fakePort(
  series: Record<string, SeriesState>,
  over: { chainId?: number; fee?: bigint; simulateFails?: (c: ContractCall) => string | undefined; sendSucceeds?: boolean } = {},
) {
  const calls = { read: [] as ContractCall[], simulate: [] as ContractCall[], send: [] as ContractCall[] };
  const port: ChainPort = {
    async chainId() {
      return over.chainId ?? 143;
    },
    async latestBlockTimestamp() {
      return NOW;
    },
    async read(c) {
      calls.read.push(c);
      if (c.functionName === 'getUpdateFee') return over.fee ?? 1n;
      const s = series[c.address];
      if (!s) throw new Error('no such contract');
      if (c.functionName === 'feedId') return s.feedId;
      if (c.functionName === 'cadenceSeconds') return s.cadence;
      if (c.functionName === 'lastSampleTimestamp') return s.last;
      throw new Error(`unexpected read ${c.functionName}`);
    },
    async simulate(c) {
      calls.simulate.push(c);
      const why = over.simulateFails?.(c);
      if (why) throw new Error(why);
    },
    async send(c) {
      calls.send.push(c);
      return { hash: `0x${String(calls.send.length).padStart(64, '0')}`, success: over.sendSucceeds ?? true };
    },
  };
  return { port, calls };
}

const due = (): Record<string, SeriesState> => ({
  [BTC_SERIES]: { feedId: BTC, cadence: 60n, last: 0n },
  [ETH_SERIES]: { feedId: ETH, cadence: 60n, last: NOW - 120n },
});

function hermesFetch(
  feeds: { id: string; price: string; time: number }[] = [
    { id: BTC, price: '6841234000000', time: 1_759_999_990 },
    { id: ETH, price: '350012000000', time: 1_759_999_991 },
  ],
  status = 200,
) {
  const fn = vi.fn(async () =>
    new Response(
      JSON.stringify({
        binary: { encoding: 'hex', data: ['deadbeef'] },
        parsed: feeds.map((f) => ({
          id: f.id.slice(2),
          price: { price: f.price, conf: '1', expo: -8, publish_time: f.time },
        })),
      }),
      { status },
    ),
  );
  return fn as unknown as typeof fetch & typeof fn;
}

describe('relayOnce, dry run (the default)', () => {
  it('never sends, and reports what it would record', async () => {
    const { port, calls } = fakePort(due());
    const report = await relayOnce(cfg(), { port, fetchFn: hermesFetch() });
    expect(calls.send).toEqual([]);
    expect(report.broadcast).toBe(false);
    expect(report.update).toMatchObject({ status: 'simulated', feeWei: '1' });
    expect(report.series.map((s) => [s.symbol, s.state])).toEqual([
      ['BTC/USD', 'would-record'],
      ['ETH/USD', 'would-record'],
    ]);
    expect(report.series[0]!.hermesPublishTime).toBe(1_759_999_990);
    expect(reportOk(report)).toBe(true);
  });

  it('is still a dry run when a key is present but the broadcast flag is unset', async () => {
    const { port, calls } = fakePort(due());
    await relayOnce(cfg({ PRIVATE_KEY: KEY }), { port, fetchFn: hermesFetch() });
    expect(calls.send).toEqual([]);
  });

  it('is a dry run when the env flag is true but --dry-run was passed', async () => {
    const c = cfg({ RELAYER_BROADCAST: 'true', PRIVATE_KEY: KEY }, { dryRun: true });
    expect(c.broadcast).toBe(false);
    const { port, calls } = fakePort(due());
    await relayOnce(c, { port, fetchFn: hermesFetch() });
    expect(calls.send).toEqual([]);
  });

  it('keeps simulating recordSample when the update simulation fails, and says so', async () => {
    const { port, calls } = fakePort(due(), {
      simulateFails: (c) => (c.functionName === 'updatePriceFeeds' ? 'insufficient funds' : undefined),
    });
    const report = await relayOnce(cfg(), { port, fetchFn: hermesFetch() });
    expect(calls.send).toEqual([]);
    expect(report.update.status).toBe('failed');
    expect(report.update.detail).toContain('insufficient funds');
    expect(report.series.every((s) => s.state === 'would-record')).toBe(true);
    expect(reportOk(report)).toBe(false);
  });
});

describe('relayOnce, broadcasting', () => {
  const live = () => cfg({ RELAYER_BROADCAST: 'true', PRIVATE_KEY: KEY });

  it('updates Pyth with the fee attached, then records each due series in order', async () => {
    const { port, calls } = fakePort(due(), { fee: 7n });
    const report = await relayOnce(live(), { port, fetchFn: hermesFetch() });

    expect(calls.send.map((c) => [c.address, c.functionName])).toEqual([
      [PYTH, 'updatePriceFeeds'],
      [BTC_SERIES, 'recordSample'],
      [ETH_SERIES, 'recordSample'],
    ]);
    const update = calls.send[0]!;
    expect(update.value).toBe(7n);
    expect(update.args).toEqual([['0xdeadbeef']]);
    expect(report.update).toMatchObject({ status: 'sent', feeWei: '7' });
    expect(report.series.map((s) => s.state)).toEqual(['recorded', 'recorded']);
    expect(reportOk(report)).toBe(true);
  });

  it('skips a series whose cadence has not elapsed and asks Hermes only for the due feed', async () => {
    const state = due();
    state[BTC_SERIES] = { feedId: BTC, cadence: 900n, last: NOW - 100n };
    const { port, calls } = fakePort(state);
    const fetchFn = hermesFetch();
    const report = await relayOnce(live(), { port, fetchFn });

    expect(report.series[0]).toMatchObject({ state: 'not-due', nextAllowedAt: Number(NOW - 100n + 900n) });
    expect(calls.send.map((c) => c.address)).toEqual([PYTH, ETH_SERIES]);
    const url = (fetchFn.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain(ETH);
    expect(url).not.toContain(BTC);
  });

  it('treats the exact cadence boundary as due', async () => {
    const state = due();
    state[BTC_SERIES] = { feedId: BTC, cadence: 60n, last: NOW - 60n };
    const { port } = fakePort(state);
    const report = await relayOnce(live(), { port, fetchFn: hermesFetch() });
    expect(report.series[0]!.state).toBe('recorded');
  });

  it('does nothing, and does not call Hermes, when no series is due', async () => {
    const state = { [BTC_SERIES]: { feedId: BTC, cadence: 900n, last: NOW - 1n }, [ETH_SERIES]: { feedId: ETH, cadence: 900n, last: NOW - 1n } };
    const { port, calls } = fakePort(state);
    const fetchFn = hermesFetch();
    const report = await relayOnce(live(), { port, fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(calls.send).toEqual([]);
    expect(report.update.status).toBe('skipped');
    expect(reportOk(report)).toBe(true);
  });

  it('refuses to pay a fee above the cap, and sends nothing', async () => {
    const { port, calls } = fakePort(due(), { fee: 10n ** 16n });
    const report = await relayOnce(live(), { port, fetchFn: hermesFetch() });
    expect(calls.send).toEqual([]);
    expect(report.update.status).toBe('failed');
    expect(report.update.detail).toContain('MAX_UPDATE_FEE_WEI');
    expect(report.series.every((s) => s.state === 'failed')).toBe(true);
  });

  it('pays a fee exactly at the cap', async () => {
    const { port, calls } = fakePort(due(), { fee: 1_000_000_000_000_000n });
    await relayOnce(live(), { port, fetchFn: hermesFetch() });
    expect(calls.send[0]!.functionName).toBe('updatePriceFeeds');
  });

  it('stops before recordSample when the update transaction reverts', async () => {
    const { port, calls } = fakePort(due(), { sendSucceeds: false });
    const report = await relayOnce(live(), { port, fetchFn: hermesFetch() });
    expect(calls.send).toHaveLength(1);
    expect(report.update.status).toBe('failed');
    expect(reportOk(report)).toBe(false);
  });

  it('does not send when the update would revert in simulation', async () => {
    const { port, calls } = fakePort(due(), {
      simulateFails: (c) => (c.functionName === 'updatePriceFeeds' ? 'bad update data' : undefined),
    });
    const report = await relayOnce(live(), { port, fetchFn: hermesFetch() });
    expect(calls.send).toEqual([]);
    expect(report.update.detail).toContain('bad update data');
  });

  it('does not send recordSample for a series whose simulation reverts, but sends the others', async () => {
    const { port, calls } = fakePort(due(), {
      simulateFails: (c) => (c.address === BTC_SERIES && c.functionName === 'recordSample' ? 'CadenceNotElapsed' : undefined),
    });
    const report = await relayOnce(live(), { port, fetchFn: hermesFetch() });
    expect(calls.send.map((c) => c.address)).toEqual([PYTH, ETH_SERIES]);
    expect(report.series.map((s) => s.state)).toEqual(['failed', 'recorded']);
  });

  it('will not record a feed Hermes did not price', async () => {
    const { port, calls } = fakePort(due());
    const report = await relayOnce(live(), { port, fetchFn: hermesFetch([{ id: ETH, price: '350012000000', time: 1 }]) });
    expect(report.series[0]).toMatchObject({ state: 'failed', detail: 'hermes returned no price for this feed' });
    expect(calls.send.map((c) => c.address)).toEqual([PYTH, ETH_SERIES]);
  });
});

describe('relayOnce, guards', () => {
  it('aborts on the wrong chain before reading anything else', async () => {
    const { port, calls } = fakePort(due(), { chainId: 10143 });
    await expect(relayOnce(cfg(), { port, fetchFn: hermesFetch() })).rejects.toThrow(/chain 10143/);
    expect(calls.read).toEqual([]);
    expect(calls.send).toEqual([]);
  });

  it('will not touch a series pinned to a different feed than the config expects', async () => {
    const state = due();
    state[BTC_SERIES] = { feedId: ETH, cadence: 60n, last: 0n };
    const { port, calls } = fakePort(state);
    const report = await relayOnce(cfg(), { port, fetchFn: hermesFetch() });
    expect(report.series[0]).toMatchObject({ state: 'failed' });
    expect(report.series[0]!.detail).toContain('pinned to feed');
    expect(calls.simulate.some((c) => c.address === BTC_SERIES)).toBe(false);
  });

  it('reports a Hermes failure (for instance a 401) without sending', async () => {
    const { port, calls } = fakePort(due());
    const report = await relayOnce(cfg(), { port, fetchFn: hermesFetch([], 401) });
    expect(calls.send).toEqual([]);
    expect(report.update.status).toBe('failed');
    expect(report.update.detail).toContain('401');
    expect(reportOk(report)).toBe(false);
  });
});
