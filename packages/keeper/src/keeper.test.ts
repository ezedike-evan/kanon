import { describe, expect, it } from 'vitest';
import { loadConfig, type KeeperConfig } from './config';
import { ChainMismatchError, createKeeper, passOk, revertName } from './keeper';
import type { LogRecord } from './log';
import type { ChainPort, ContractCall } from './port';
import type { AccountSource } from './source';

const MARGIN = '0x1111111111111111111111111111111111111111' as const;
const SERIES = '0x5555555555555555555555555555555555555555' as const;
const SERIES2 = '0x6666666666666666666666666666666666666666' as const;
const KEY = `0x${'ab'.repeat(32)}` as const;
const acct = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;

const E18 = 10n ** 18n;
const ADL = 12n * 10n ** 17n; // 1.2
const LIQ = E18;
const HEALTHY = 3n * E18;
const IN_ADL = 11n * 10n ** 17n; // 1.1
const UNDERWATER = 5n * 10n ** 17n; // 0.5

const cfg = (env: Record<string, string> = {}, opts?: { dryRun?: boolean }): KeeperConfig =>
  loadConfig(
    { RPC_URL: 'http://rpc.example', MARGIN_ACCOUNT_ADDRESS: MARGIN, KEEPER_BROADCAST: 'true', PRIVATE_KEY: KEY, ...env },
    opts,
  );

interface Pos {
  series: `0x${string}`;
  size: bigint;
  open: boolean;
}
interface Acct {
  positions: Pos[];
  /** What healthFactor returns next. A function lets a fake model state changes. */
  health: bigint | 'unpriced' | 'rpc-error';
}

const revert = (name: string) =>
  Object.assign(new Error(`The contract function reverted with the following signature: ${name}()`), {
    shortMessage: `reverted: ${name}`,
  });

/** Default state transition: a liquidation closes the position, a deleverage restores health. */
function defaultAfter(c: ContractCall, accounts: Record<string, Acct>) {
  const acc = accounts[String(c.args?.[0]).toLowerCase()];
  if (!acc) return;
  if (c.functionName === 'liquidate') {
    const p = acc.positions[Number(c.args![1])];
    if (p) p.open = false;
  }
  if (c.functionName === 'deleverage') acc.health = HEALTHY;
}

/** A MarginAccount stand-in. Its state moves when `send` is called, like the real one. */
function fakeChain(
  accounts: Record<string, Acct>,
  over: {
    chainId?: number;
    gas?: bigint;
    gasPrice?: bigint;
    /** Return an error to make the simulation of this call revert. */
    simulate?: (c: ContractCall) => Error | undefined;
    send?: (c: ContractCall) => { success: boolean } | Error;
    /** State transition applied after a successful send. */
    after?: (c: ContractCall, accounts: Record<string, Acct>) => void;
  } = {},
) {
  const calls = { read: [] as ContractCall[], simulate: [] as ContractCall[], send: [] as ContractCall[] };
  const sampled = new Set<string>();
  const port: ChainPort = {
    async chainId() {
      return over.chainId ?? 143;
    },
    async blockNumber() {
      return 1000n;
    },
    async gasPrice() {
      return over.gasPrice ?? 100n;
    },
    async getLogs() {
      return [];
    },
    async read(c) {
      calls.read.push(c);
      const a = String(c.args?.[0]).toLowerCase();
      switch (c.functionName) {
        case 'adlHealthThreshold':
          return ADL;
        case 'LIQUIDATION_THRESHOLD':
          return LIQ;
        case 'openPositionCount':
          return BigInt(accounts[a]?.positions.filter((p) => p.open).length ?? 0);
        case 'positionCount':
          return BigInt(accounts[a]?.positions.length ?? 0);
        case 'positionOf': {
          const p = accounts[a]?.positions[Number(c.args?.[1])];
          if (!p) throw revert('PositionNotFound');
          return [p.series, true, p.size, 1n, p.open];
        }
        case 'healthFactor': {
          const acc = accounts[a];
          if (!acc) throw new Error('unknown account');
          if (acc.health === 'rpc-error') throw new Error('HTTP request failed: 502');
          if (acc.health === 'unpriced') {
            const series = acc.positions.filter((p) => p.open).map((p) => p.series);
            if (!series.every((s) => sampled.has(s))) throw revert('NoRecentPrice');
            return HEALTHY;
          }
          return acc.health;
        }
      }
      throw new Error(`unexpected read ${c.functionName}`);
    },
    async simulate(c) {
      calls.simulate.push(c);
      const err = over.simulate?.(c);
      if (err) throw err;
      return { gas: over.gas ?? 200_000n };
    },
    async send(c) {
      calls.send.push(c);
      const r = over.send?.(c) ?? { success: true };
      if (r instanceof Error) throw r;
      if (r.success) {
        if (c.functionName === 'recordSample') sampled.add(c.address);
        if (over.after) over.after(c, accounts);
        else defaultAfter(c, accounts);
      }
      return { hash: `0x${String(calls.send.length).padStart(64, '0')}`, success: r.success };
    },
  };
  return { port, calls };
}

const sourceOf = (...list: `0x${string}`[]): AccountSource => ({ poll: async () => ({ accounts: list }) });

const fns = (cs: ContractCall[]) => cs.map((c) => c.functionName);

describe('healthy accounts', () => {
  it('are skipped without a simulation or a transaction', async () => {
    const { port, calls } = fakeChain({ [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: HEALTHY } });
    const k = createKeeper(cfg(), { port, source: sourceOf(acct(1)) });
    const r = await k.runPass();
    expect(r.accounts[0]).toMatchObject({ account: acct(1), outcome: 'healthy', actions: [], health: HEALTHY.toString() });
    expect(calls.simulate).toHaveLength(0);
    expect(calls.send).toHaveLength(0);
  });

  it('are skipped when health sits exactly on the ADL threshold (the band is half-open)', async () => {
    const { port, calls } = fakeChain({ [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: ADL } });
    const r = await createKeeper(cfg(), { port, source: sourceOf(acct(1)) }).runPass();
    expect(r.accounts[0]?.outcome).toBe('healthy');
    expect(calls.send).toHaveLength(0);
  });

  it('take their bands from the contract, not from constants in the keeper', async () => {
    const { port, calls } = fakeChain({ [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: HEALTHY } });
    await createKeeper(cfg(), { port, source: sourceOf(acct(1)) }).runPass();
    const names = fns(calls.read);
    expect(names).toContain('adlHealthThreshold');
    expect(names).toContain('LIQUIDATION_THRESHOLD');
    expect(names).toContain('healthFactor');
  });

  it('a flat account is reported and dropped from the tracked set', async () => {
    const { port } = fakeChain({ [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: false }], health: HEALTHY } });
    const k = createKeeper(cfg(), { port, source: sourceOf(acct(1)) });
    expect((await k.runPass()).accounts[0]?.outcome).toBe('flat');
    expect(k.tracked()).toEqual([]);
  });
});

describe('ADL band', () => {
  it('calls deleverage, and only deleverage, repeating until the contract says healthy', async () => {
    const accounts: Record<string, Acct> = {
      [acct(1)]: { positions: [{ series: SERIES, size: 100n, open: true }], health: IN_ADL },
    };
    let n = 0;
    const { port, calls } = fakeChain(accounts, {
      after: (c, s) => {
        if (c.functionName === 'deleverage') s[acct(1)]!.health = ++n >= 2 ? 15n * 10n ** 17n : 115n * 10n ** 16n;
      },
    });
    const r = await createKeeper(cfg(), { port, source: sourceOf(acct(1)) }).runPass();
    expect(fns(calls.send)).toEqual(['deleverage', 'deleverage']);
    expect(calls.send[0]?.args).toEqual([acct(1)]);
    expect(r.accounts[0]).toMatchObject({ outcome: 'recovered', health: IN_ADL.toString() });
    expect(r.txsUsed).toBe(2);
  });

  it('escalates to liquidation if the market keeps moving and health drops below 1.0 mid-pass', async () => {
    const accounts: Record<string, Acct> = {
      [acct(1)]: { positions: [{ series: SERIES, size: 100n, open: true }], health: IN_ADL },
    };
    const { port, calls } = fakeChain(accounts, {
      after: (c, s) => {
        if (c.functionName === 'deleverage') s[acct(1)]!.health = UNDERWATER;
        if (c.functionName === 'liquidate') s[acct(1)]!.positions[0]!.open = false;
      },
    });
    const r = await createKeeper(cfg(), { port, source: sourceOf(acct(1)) }).runPass();
    expect(fns(calls.send)).toEqual(['deleverage', 'liquidate']);
    expect(r.accounts[0]?.outcome).toBe('closed');
  });

  it('is bounded by MAX_ACTIONS_PER_ACCOUNT when the account never recovers', async () => {
    const { port, calls } = fakeChain(
      { [acct(1)]: { positions: [{ series: SERIES, size: 100n, open: true }], health: IN_ADL } },
      { after: () => {} }, // each deleverage succeeds but the market keeps the account in the band
    );
    const r = await createKeeper(cfg({ MAX_ACTIONS_PER_ACCOUNT: '3' }), { port, source: sourceOf(acct(1)) }).runPass();
    expect(calls.send).toHaveLength(3);
    expect(r.accounts[0]?.outcome).toBe('action_limit');
  });
});

describe('liquidation', () => {
  it('liquidates the largest open position when health is below 1.0', async () => {
    const accounts: Record<string, Acct> = {
      [acct(1)]: {
        positions: [
          { series: SERIES, size: 50n, open: true },
          { series: SERIES, size: 900n, open: true },
          { series: SERIES, size: 10n, open: false },
          { series: SERIES, size: 300n, open: true },
        ],
        health: UNDERWATER,
      },
    };
    const { port, calls } = fakeChain(accounts, {
      after: (c, s) => {
        if (c.functionName === 'liquidate') {
          s[acct(1)]!.positions[Number(c.args![1])]!.open = false;
          // After the biggest is gone the rest is fine.
          s[acct(1)]!.health = HEALTHY;
        }
      },
    });
    const r = await createKeeper(cfg(), { port, source: sourceOf(acct(1)) }).runPass();
    expect(calls.send).toHaveLength(1);
    expect(calls.send[0]).toMatchObject({ address: MARGIN, functionName: 'liquidate', args: [acct(1), 1n] });
    expect(r.accounts[0]).toMatchObject({ outcome: 'recovered' });
    expect(r.accounts[0]?.actions[0]).toMatchObject({ action: 'liquidate', outcome: 'sent', positionId: '1' });
  });

  it('keeps liquidating until nothing is left open', async () => {
    const accounts: Record<string, Acct> = {
      [acct(1)]: {
        positions: [
          { series: SERIES, size: 10n, open: true },
          { series: SERIES, size: 20n, open: true },
        ],
        health: UNDERWATER,
      },
    };
    const { port, calls } = fakeChain(accounts, {
      after: (c, s) => {
        if (c.functionName === 'liquidate') s[acct(1)]!.positions[Number(c.args![1])]!.open = false;
      },
    });
    const r = await createKeeper(cfg(), { port, source: sourceOf(acct(1)) }).runPass();
    expect(calls.send.map((c) => c.args)).toEqual([
      [acct(1), 1n],
      [acct(1), 0n],
    ]);
    expect(r.accounts[0]?.outcome).toBe('closed');
  });

  it('handles several accounts in one pass, choosing the action per account', async () => {
    const accounts: Record<string, Acct> = {
      [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: HEALTHY },
      [acct(2)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: IN_ADL },
      [acct(3)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: UNDERWATER },
    };
    const { port, calls } = fakeChain(accounts, {
      after: (c, s) => {
        const who = String(c.args![0]);
        if (c.functionName === 'deleverage') s[who]!.health = HEALTHY;
        if (c.functionName === 'liquidate') s[who]!.positions[0]!.open = false;
      },
    });
    const r = await createKeeper(cfg(), { port, source: sourceOf(acct(1), acct(2), acct(3)) }).runPass();
    expect(r.accounts.map((a) => a.outcome)).toEqual(['healthy', 'recovered', 'closed']);
    expect(calls.send.map((c) => [c.functionName, c.args?.[0]])).toEqual([
      ['deleverage', acct(2)],
      ['liquidate', acct(3)],
    ]);
  });
});

describe('races, reverts and outages never crash the loop', () => {
  const underwater = (): Record<string, Acct> => ({
    [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: UNDERWATER },
    [acct(2)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: UNDERWATER },
  });

  it.each(['NotLiquidatable', 'NotDeleverageable', 'NothingToDeleverage', 'PositionNotOpen'])(
    'a %s revert at simulation is a race: reported, nothing sent, next account still handled',
    async (name) => {
      const { port, calls } = fakeChain(underwater(), {
        simulate: (c) => (c.args?.[0] === acct(1) ? revert(name) : undefined),
      });
      const r = await createKeeper(cfg(), { port, source: sourceOf(acct(1), acct(2)) }).runPass();
      expect(r.accounts[0]).toMatchObject({ outcome: 'raced' });
      expect(r.accounts[0]?.actions[0]?.detail).toBe(name);
      expect(calls.send).toHaveLength(1);
      expect(calls.send[0]?.args?.[0]).toBe(acct(2));
      expect(passOk(r)).toBe(true);
    },
  );

  it('recognises a revert name buried in a viem-style cause chain', () => {
    const inner = Object.assign(new Error('boom'), { data: { errorName: 'NotLiquidatable' } });
    const outer = Object.assign(new Error('Execution reverted'), { cause: { cause: inner } });
    expect(revertName(outer)).toBe('NotLiquidatable');
    expect(revertName(new Error('out of gas'))).toBeUndefined();
  });

  it('a transaction that mines and reverts is reported, and the loop continues', async () => {
    const { port, calls } = fakeChain(underwater(), {
      send: (c) => ({ success: c.args?.[0] !== acct(1) }),
    });
    const r = await createKeeper(cfg(), { port, source: sourceOf(acct(1), acct(2)) }).runPass();
    expect(r.accounts[0]).toMatchObject({ outcome: 'reverted' });
    expect(r.accounts[0]?.actions[0]?.txHash).toBeDefined();
    expect(calls.send).toHaveLength(2);
    expect(passOk(r)).toBe(false);
  });

  it('a send that throws (RPC error, nonce, timeout) is reported, and the loop continues', async () => {
    const { port, calls } = fakeChain(underwater(), {
      send: (c) => (c.args?.[0] === acct(1) ? new Error('nonce too low') : { success: true }),
    });
    const r = await createKeeper(cfg(), { port, source: sourceOf(acct(1), acct(2)) }).runPass();
    expect(r.accounts[0]).toMatchObject({ outcome: 'failed' });
    expect(r.accounts[0]?.actions[0]?.detail).toContain('nonce too low');
    expect(calls.send).toHaveLength(2);
  });

  it('a simulation failure that is not a known race is a failure, not a send', async () => {
    const { port, calls } = fakeChain(underwater(), { simulate: () => new Error('execution reverted: something else') });
    const r = await createKeeper(cfg(), { port, source: sourceOf(acct(1), acct(2)) }).runPass();
    expect(r.accounts.map((a) => a.outcome)).toEqual(['failed', 'failed']);
    expect(calls.send).toHaveLength(0);
  });

  it('a failing health read on one account does not stop the others', async () => {
    const accounts = underwater();
    accounts[acct(1)]!.health = 'rpc-error';
    const { port, calls } = fakeChain(accounts);
    const r = await createKeeper(cfg(), { port, source: sourceOf(acct(1), acct(2)) }).runPass();
    expect(r.accounts[0]).toMatchObject({ outcome: 'failed' });
    expect(r.accounts[1]?.actions[0]?.outcome).toBe('sent');
    expect(calls.send).toHaveLength(1);
  });

  it('an unexpected throw inside one account is contained', async () => {
    const accounts = underwater();
    const { port } = fakeChain(accounts);
    const realRead = port.read;
    port.read = async (c) => {
      if (c.functionName === 'openPositionCount' && c.args?.[0] === acct(1)) throw new Error('socket hang up');
      return realRead(c);
    };
    const r = await createKeeper(cfg(), { port, source: sourceOf(acct(1), acct(2)) }).runPass();
    expect(r.accounts[0]).toMatchObject({ outcome: 'failed', detail: 'socket hang up' });
    expect(r.accounts[1]?.actions[0]?.outcome).toBe('sent');
  });

  it('a discovery outage falls back to the accounts already tracked', async () => {
    const { port, calls } = fakeChain(underwater());
    let fail = false;
    const source: AccountSource = {
      poll: async () => {
        if (fail) throw new Error('getLogs: 429');
        return { accounts: [acct(1)] };
      },
    };
    const logs: LogRecord[] = [];
    const k = createKeeper(cfg(), { port, source, log: (e) => logs.push(e) });
    await k.runPass();
    fail = true;
    const r = await k.runPass();
    expect(r.discovery.error).toContain('429');
    expect(r.accounts.map((a) => a.account)).toContain(acct(1));
    expect(logs.some((l) => l.event === 'discovery_failed')).toBe(true);
    expect(calls.send.length).toBeGreaterThan(0);
  });

  it('is idempotent: a second pass over the settled state does nothing', async () => {
    const accounts = underwater();
    const { port, calls } = fakeChain(accounts, {
      after: (c, s) => {
        s[String(c.args![0])]!.positions[0]!.open = false;
      },
    });
    const k = createKeeper(cfg(), { port, source: sourceOf(acct(1), acct(2)) });
    await k.runPass();
    const sent = calls.send.length;
    const r = await k.runPass();
    expect(calls.send).toHaveLength(sent);
    expect(r.accounts.every((a) => a.actions.length === 0)).toBe(true);
    expect(k.tracked()).toEqual([]);
  });
});

describe('dry run', () => {
  it('simulates and reports would_send, but never calls send', async () => {
    const { port, calls } = fakeChain({
      [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: UNDERWATER },
      [acct(2)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: IN_ADL },
    });
    const c = cfg({}, { dryRun: true });
    expect(c.broadcast).toBe(false);
    const r = await createKeeper(c, { port, source: sourceOf(acct(1), acct(2)) }).runPass();
    expect(r.broadcast).toBe(false);
    expect(r.accounts.map((a) => a.outcome)).toEqual(['would_send', 'would_send']);
    expect(fns(calls.simulate)).toEqual(['liquidate', 'deleverage']);
    expect(calls.send).toHaveLength(0);
  });

  it('is also the default when the env flag is absent', async () => {
    const { port, calls } = fakeChain({ [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: UNDERWATER } });
    const c = loadConfig({ RPC_URL: 'http://rpc.example', MARGIN_ACCOUNT_ADDRESS: MARGIN });
    await createKeeper(c, { port, source: sourceOf(acct(1)) }).runPass();
    expect(calls.send).toHaveLength(0);
  });

  it('does not record samples either', async () => {
    const { port, calls } = fakeChain({ [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: 'unpriced' } });
    const r = await createKeeper(cfg({}, { dryRun: true }), { port, source: sourceOf(acct(1)) }).runPass();
    expect(r.accounts[0]?.outcome).toBe('unpriced');
    expect(r.accounts[0]?.actions[0]).toMatchObject({ action: 'record_sample', outcome: 'would_send' });
    expect(calls.send).toHaveLength(0);
  });
});

describe('unpriced accounts (no sample in the current bucket)', () => {
  it('records a sample on each series involved, then evaluates the account', async () => {
    const accounts: Record<string, Acct> = {
      [acct(1)]: {
        positions: [
          { series: SERIES, size: 10n, open: true },
          { series: SERIES2, size: 10n, open: true },
          { series: SERIES, size: 10n, open: true },
        ],
        health: 'unpriced',
      },
    };
    const { port, calls } = fakeChain(accounts);
    const r = await createKeeper(cfg(), { port, source: sourceOf(acct(1)) }).runPass();
    expect(calls.send.map((c) => [c.functionName, c.address]).sort()).toEqual(
      [
        ['recordSample', SERIES],
        ['recordSample', SERIES2],
      ].sort(),
    );
    expect(r.accounts[0]?.outcome).toBe('healthy');
  });

  it('records a shared series once per pass, however many accounts trade it', async () => {
    const accounts: Record<string, Acct> = {
      [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: 'unpriced' },
      [acct(2)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: 'unpriced' },
    };
    const { port, calls } = fakeChain(accounts);
    await createKeeper(cfg(), { port, source: sourceOf(acct(1), acct(2)) }).runPass();
    expect(calls.send.filter((c) => c.functionName === 'recordSample')).toHaveLength(1);
  });

  it('reports unpriced, without sending, when RECORD_SAMPLES=false', async () => {
    const { port, calls } = fakeChain({ [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: 'unpriced' } });
    const r = await createKeeper(cfg({ RECORD_SAMPLES: 'false' }), { port, source: sourceOf(acct(1)) }).runPass();
    expect(r.accounts[0]?.outcome).toBe('unpriced');
    expect(calls.send).toHaveLength(0);
  });

  it('reports unpriced when the sample itself cannot be recorded', async () => {
    const { port } = fakeChain(
      { [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: 'unpriced' } },
      { simulate: (c) => (c.functionName === 'recordSample' ? new Error('execution reverted: cadence') : undefined) },
    );
    const r = await createKeeper(cfg(), { port, source: sourceOf(acct(1)) }).runPass();
    expect(r.accounts[0]?.outcome).toBe('unpriced');
    expect(r.accounts[0]?.actions[0]).toMatchObject({ action: 'record_sample', outcome: 'failed' });
  });
});

describe('caps', () => {
  const one = (): Record<string, Acct> => ({
    [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: UNDERWATER },
  });

  it('refuses to send when the gas estimate is above MAX_GAS_PER_TX', async () => {
    const { port, calls } = fakeChain(one(), { gas: 900_000n });
    const r = await createKeeper(cfg({ MAX_GAS_PER_TX: '500000' }), { port, source: sourceOf(acct(1)) }).runPass();
    expect(r.accounts[0]?.outcome).toBe('over_gas_cap');
    expect(calls.send).toHaveLength(0);
  });

  it('refuses to send when the network gas price is above MAX_GAS_PRICE_WEI', async () => {
    const { port, calls } = fakeChain(one(), { gasPrice: 5_000n });
    const r = await createKeeper(cfg({ MAX_GAS_PRICE_WEI: '1000' }), { port, source: sourceOf(acct(1)) }).runPass();
    expect(r.accounts[0]?.outcome).toBe('over_fee_cap');
    expect(calls.send).toHaveLength(0);
  });

  it('sends with a padded gas limit that never exceeds the cap, and a hard fee ceiling', async () => {
    const seen: { gas: bigint; maxFeePerGas: bigint }[] = [];
    const { port } = fakeChain(one(), { gas: 400_000n });
    const realSend = port.send;
    port.send = async (c, o) => {
      seen.push(o);
      return realSend(c, o);
    };
    await createKeeper(cfg({ MAX_GAS_PER_TX: '450000', MAX_GAS_PRICE_WEI: '777', MAX_ACTIONS_PER_ACCOUNT: '1' }), {
      port,
      source: sourceOf(acct(1)),
    }).runPass();
    expect(seen[0]).toEqual({ gas: 450_000n, maxFeePerGas: 777n }); // 400k * 1.2 = 480k, clamped to the cap
  });

  it('stops spending at MAX_TXS_PER_PASS', async () => {
    const accounts: Record<string, Acct> = {};
    for (let i = 1; i <= 4; i++) accounts[acct(i)] = { positions: [{ series: SERIES, size: 10n, open: true }], health: UNDERWATER };
    const { port, calls } = fakeChain(accounts, {
      after: (c, s) => {
        s[String(c.args![0])]!.positions[0]!.open = false;
      },
    });
    const r = await createKeeper(cfg({ MAX_TXS_PER_PASS: '2' }), { port, source: sourceOf(acct(1), acct(2), acct(3), acct(4)) }).runPass();
    expect(calls.send).toHaveLength(2);
    expect(r.accounts.map((a) => a.outcome)).toEqual(['closed', 'closed', 'budget_exhausted', 'budget_exhausted']);
    expect(r.txsUsed).toBe(2);
  });
});

describe('chain check', () => {
  it('refuses to do anything when the RPC is on another chain', async () => {
    const { port, calls } = fakeChain(
      { [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: UNDERWATER } },
      { chainId: 1 },
    );
    await expect(createKeeper(cfg(), { port, source: sourceOf(acct(1)) }).runPass()).rejects.toBeInstanceOf(ChainMismatchError);
    expect(calls.read).toHaveLength(0);
    expect(calls.simulate).toHaveLength(0);
    expect(calls.send).toHaveLength(0);
  });
});

describe('structured logging', () => {
  it('emits JSON-serialisable records for the pass, each account and each action', async () => {
    const { port } = fakeChain({ [acct(1)]: { positions: [{ series: SERIES, size: 10n, open: true }], health: UNDERWATER } });
    const logs: LogRecord[] = [];
    await createKeeper(cfg({ MAX_ACTIONS_PER_ACCOUNT: '1' }), { port, source: sourceOf(acct(1)), log: (e) => logs.push(e) }).runPass();
    expect(logs.map((l) => l.event)).toEqual(['pass_start', 'action', 'account', 'pass_end']);
    expect(() => JSON.stringify(logs, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toThrow();
    expect(logs.find((l) => l.event === 'action')).toMatchObject({ action: 'liquidate', outcome: 'sent' });
  });
});
