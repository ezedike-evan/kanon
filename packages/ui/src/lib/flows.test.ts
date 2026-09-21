import { describe, expect, it, vi } from 'vitest';
import {
  RULE_04,
  applyParamEdit,
  dec,
  predicatesCommitment,
  specHash,
  stated,
  type StrategySpec,
} from '@kanon/spec';
import {
  runAmendFlow,
  runFinalizeFlow,
  runPinFlow,
  runWithdrawFlow,
  type UnsavedPin,
} from './flows';
import { PinError, type PinClient, type PinReceipt, type PinTarget } from './pin';

const TX = `0x${'cd'.repeat(32)}`;
const SERIES_BTC = '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9';
const SERIES_OTHER = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707';
const RECEIPT: PinReceipt = {
  txHash: TX,
  chainStrategyId: '7',
  bond: dec('250000000000000000', 18),
  chainId: 143,
  registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
  predicatesCommitment: predicatesCommitment(RULE_04),
  series: SERIES_BTC,
};

function edit(spec: StrategySpec, key: string, value: number): StrategySpec {
  const r = applyParamEdit(spec, key, value);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

/** A pin client that records its calls and can be told to fail. */
function fakeClient(over: Partial<PinClient> = {}, ready = true) {
  const log: string[] = [];
  const client: PinClient = {
    chainId: 143,
    registryAddress: RECEIPT.registryAddress,
    nativeSymbol: 'MON',
    availability: () =>
      ready ? { state: 'ready' } : { state: 'not_deployed', message: 'The registry is not deployed.' },
    series: { 'BTC/USD': { address: SERIES_BTC } },
    readMinBond: async () => RECEIPT.bond,
    pin: async (target: PinTarget) => {
      log.push(`chain.pin:${target.specHash}:${target.predicatesCommitment}:${target.series}`);
      return RECEIPT;
    },
    tighten: async (id, target) => {
      log.push(`chain.tighten:${id}:${target.specHash}:${target.predicatesCommitment}:${target.series}`);
      return { txHash: TX };
    },
    proposeLoosening: async (id, target) => {
      log.push(
        `chain.proposeLoosening:${id}:${target.specHash}:${target.predicatesCommitment}:${target.series}`,
      );
      return { txHash: TX, cooldownEndsAtMs: 1_800_086_400_000 };
    },
    finalizeLoosening: async (id) => {
      log.push(`chain.finalizeLoosening:${id}`);
      return { txHash: TX };
    },
    ...over,
  };
  return { client, log };
}

const unsaved = (): UnsavedPin => ({ current: null });

async function pinInput(over: Record<string, unknown> = {}) {
  const hash = await specHash(RULE_04);
  const log: string[] = [];
  const { client, log: chainLog } = fakeClient();
  const actions = {
    saveDraft: vi.fn(async () => {
      log.push('convex.saveDraft');
      return { strategyId: 'd1', specHash: hash };
    }),
    pinStrategy: vi.fn(async () => {
      log.push('convex.pinStrategy');
      return {};
    }),
  };
  return {
    hash,
    log,
    chainLog,
    actions,
    input: {
      userId: 'u1',
      spec: RULE_04,
      draft: { _id: 'd1', specHash: hash },
      acknowledged: true,
      pinClient: client,
      actions,
      unsaved: unsaved(),
      ...over,
    },
  };
}

describe('runPinFlow', () => {
  it('will not pin without a reviewed draft', async () => {
    const t = await pinInput({ draft: undefined });
    expect(await runPinFlow(t.input)).toMatchObject({ ok: false, reason: 'no_draft' });
    expect(t.chainLog).toEqual([]);
  });

  it('will not touch the chain until the user has confirmed they read the spec', async () => {
    const t = await pinInput({ acknowledged: false });
    expect(await runPinFlow(t.input)).toMatchObject({ ok: false, reason: 'not_reviewed' });
    expect(t.chainLog).toEqual([]);
    expect(t.actions.pinStrategy).not.toHaveBeenCalled();
  });

  it('says not deployed, sends nothing, and saves no pin', async () => {
    const { client, log } = fakeClient({}, false);
    const t = await pinInput({ pinClient: client });
    const out = await runPinFlow(t.input);
    expect(out).toMatchObject({ ok: false, reason: 'not_deployed' });
    expect(out.ok === false && out.message).toMatch(/not deployed/i);
    expect(log).toEqual([]);
    expect(t.actions.pinStrategy).not.toHaveBeenCalled();
  });

  it('writes the chain first and saves the row only after the chain accepted it', async () => {
    const t = await pinInput();
    const order: string[] = [];
    t.actions.pinStrategy.mockImplementation(async () => {
      order.push(...t.chainLog, 'convex.pinStrategy');
      return {};
    });
    const out = await runPinFlow(t.input);
    expect(out).toEqual({ ok: true, txHash: TX });
    expect(order).toEqual([
      `chain.pin:${t.hash}:${predicatesCommitment(RULE_04)}:${SERIES_BTC}`,
      'convex.pinStrategy',
    ]);
    expect(t.actions.pinStrategy).toHaveBeenCalledWith({
      strategyId: 'd1',
      specHash: t.hash,
      predicatesCommitment: predicatesCommitment(RULE_04),
      series: SERIES_BTC,
      bondAtoms: RECEIPT.bond,
      txHash: TX,
      chainId: 143,
      registryAddress: RECEIPT.registryAddress,
      chainStrategyId: '7',
    });
  });

  it('re-saves the draft first when the stored one is not the spec whose hash is signed', async () => {
    const t = await pinInput({ draft: { _id: 'd1', specHash: '0xstale' } });
    await runPinFlow(t.input);
    expect(t.actions.saveDraft).toHaveBeenCalledWith({ strategyId: 'd1', spec: RULE_04 });
    expect(t.log[0]).toBe('convex.saveDraft');
  });

  it('a declined signature saves nothing', async () => {
    const { client } = fakeClient({
      pin: async () => {
        throw new PinError('rejected', 'The signature was declined. Nothing was pinned.');
      },
    });
    const t = await pinInput({ pinClient: client });
    expect(await runPinFlow(t.input)).toMatchObject({ ok: false, reason: 'rejected' });
    expect(t.actions.pinStrategy).not.toHaveBeenCalled();
  });

  it('a pin the chain accepted but the row missed is retried, never sent twice', async () => {
    const t = await pinInput();
    t.actions.pinStrategy.mockRejectedValueOnce(new Error('network'));
    const state = unsaved();

    const first = await runPinFlow({ ...t.input, unsaved: state });
    expect(first).toMatchObject({ ok: false, reason: 'failed' });
    expect(first.ok === false && first.message).toContain(TX);
    expect(t.chainLog).toHaveLength(1);

    const second = await runPinFlow({ ...t.input, unsaved: state });
    expect(second).toEqual({ ok: true, txHash: TX });
    expect(t.chainLog).toHaveLength(1); // no second bond
    expect(t.actions.pinStrategy).toHaveBeenCalledTimes(2);
    expect(state.current).toBeNull();
  });
});

describe('runPinFlow: what the pin carries', () => {
  it('says not deployed, and sends nothing, when the spec asset has no deployed series', async () => {
    const { client, log } = fakeClient({ series: {} });
    const t = await pinInput({ pinClient: client });
    const out = await runPinFlow(t.input);
    expect(out).toMatchObject({ ok: false, reason: 'not_deployed' });
    expect(out.ok === false && out.message).toMatch(/no canonical series is deployed/i);
    expect(log).toEqual([]);
    expect(t.actions.pinStrategy).not.toHaveBeenCalled();
  });

  it('refuses a spec the gate cannot encode, and sends nothing', async () => {
    const mixed: StrategySpec = {
      ...RULE_04,
      predicates: [
        { ...RULE_04.predicates[0]!, timeframe: stated('1h') } as StrategySpec['predicates'][number],
        ...RULE_04.predicates.slice(1),
      ],
    };
    const hash = await specHash(mixed);
    const t = await pinInput({ spec: mixed, draft: { _id: 'd1', specHash: hash } });
    const out = await runPinFlow(t.input);
    expect(out).toMatchObject({ ok: false, reason: 'failed' });
    expect(out.ok === false && out.message).toMatch(/series bucket/);
    expect(t.chainLog).toEqual([]);
  });

  it('saves the commitment and series the registry recorded, not the ones it computed', async () => {
    const recorded = { ...RECEIPT, series: SERIES_OTHER };
    const { client } = fakeClient({ pin: async () => recorded });
    const t = await pinInput({ pinClient: client });
    await runPinFlow(t.input);
    expect(t.actions.pinStrategy).toHaveBeenCalledWith(expect.objectContaining({ series: SERIES_OTHER }));
  });
});

describe('runAmendFlow', () => {
  const strategy = { _id: 's1', chainStrategyId: '7', seriesAddress: SERIES_BTC };

  async function setup(staged: StrategySpec | null, over: Record<string, unknown> = {}) {
    const { client, log } = fakeClient();
    const actions = { amendStrategy: vi.fn(async () => ({ kind: 'immediate' as const })) };
    return {
      log,
      actions,
      hash: staged ? await specHash(staged) : '',
      input: {
        userId: 'u1',
        strategy,
        current: RULE_04,
        staged,
        pinClient: client,
        actions,
        ...over,
      },
    };
  }

  it('a tightening goes on-chain as tighten, and applies now', async () => {
    const t = await setup(edit(RULE_04, 'risk.riskPerTradeBps', 25));
    expect(await runAmendFlow(t.input)).toEqual({ ok: true, kind: 'immediate' });
    const next = edit(RULE_04, 'risk.riskPerTradeBps', 25);
    expect(t.log).toEqual([`chain.tighten:7:${t.hash}:${predicatesCommitment(next)}:${SERIES_BTC}`]);
    expect(t.actions.amendStrategy).toHaveBeenCalledWith({
      strategyId: 's1',
      nextSpec: expect.anything(),
      predicatesCommitment: predicatesCommitment(next),
      series: SERIES_BTC,
      txHash: TX,
    });
  });

  it('a loosening goes on-chain as proposeLoosening, carrying the registry cooldown', async () => {
    const t = await setup(edit(RULE_04, 'risk.stopDistanceBps', 90));
    expect(await runAmendFlow(t.input)).toEqual({ ok: true, kind: 'cooling_off' });
    const next = edit(RULE_04, 'risk.stopDistanceBps', 90);
    expect(t.log).toEqual([
      `chain.proposeLoosening:7:${t.hash}:${predicatesCommitment(next)}:${SERIES_BTC}`,
    ]);
    expect(t.actions.amendStrategy).toHaveBeenCalledWith(
      expect.objectContaining({
        chainCooldownEndsAt: 1_800_086_400_000,
        txHash: TX,
        predicatesCommitment: predicatesCommitment(next),
        series: SERIES_BTC,
      }),
    );
    // A loosening never reaches `tighten`.
    expect(t.log.some((l) => l.startsWith('chain.tighten'))).toBe(false);
  });

  it('a tightening that would also move the pinned series address waits, and never reaches tighten', async () => {
    const t = await setup(edit(RULE_04, 'risk.riskPerTradeBps', 25), {
      strategy: { ...strategy, seriesAddress: SERIES_OTHER },
    });
    expect(await runAmendFlow(t.input)).toEqual({ ok: true, kind: 'cooling_off' });
    expect(t.log).toHaveLength(1);
    expect(t.log[0]).toMatch(/^chain\.proposeLoosening:/);
  });

  it('will not amend a rule whose asset has no deployed series', async () => {
    const { client, log } = fakeClient({ series: {} });
    const t = await setup(edit(RULE_04, 'risk.riskPerTradeBps', 25), { pinClient: client });
    expect(await runAmendFlow(t.input)).toMatchObject({ ok: false });
    expect(log).toEqual([]);
    expect(t.actions.amendStrategy).not.toHaveBeenCalled();
  });

  it('does nothing when nothing changed', async () => {
    const t = await setup(RULE_04);
    expect(await runAmendFlow(t.input)).toEqual({ ok: false, message: 'Nothing has changed.' });
    expect(t.log).toEqual([]);
  });

  it('cannot amend a rule that has no registry entry', async () => {
    const t = await setup(edit(RULE_04, 'risk.riskPerTradeBps', 25), { strategy: { _id: 's1' } });
    expect(await runAmendFlow(t.input)).toMatchObject({ ok: false });
    expect(t.log).toEqual([]);
  });

  it('does not save a change the chain did not take', async () => {
    const { client } = fakeClient({
      tighten: async () => {
        throw new PinError('rejected', 'The signature was declined. Nothing was pinned.');
      },
    });
    const t = await setup(edit(RULE_04, 'risk.riskPerTradeBps', 25), { pinClient: client });
    expect(await runAmendFlow(t.input)).toMatchObject({ ok: false });
    expect(t.actions.amendStrategy).not.toHaveBeenCalled();
  });
});

describe('cooling-off flows', () => {
  const COMMIT = `0x${'ee'.repeat(32)}`;
  const cooling = {
    _id: 's1',
    status: 'cooling_off',
    chainStrategyId: '7',
    specHash: '0xcurrent',
    predicatesCommitment: COMMIT,
    seriesAddress: SERIES_BTC,
  };

  function setup(over: Record<string, unknown> = {}) {
    const { client, log } = fakeClient();
    const actions = {
      finalizeAmendment: vi.fn(async () => ({})),
      withdrawAmendment: vi.fn(async () => ({})),
    };
    return { log, actions, input: { userId: 'u1', strategy: cooling, pinClient: client, actions, ...over } };
  }

  it('finalize asks the registry first, and saves only what it accepted', async () => {
    const t = setup();
    expect(await runFinalizeFlow(t.input)).toEqual({ ok: true, kind: 'cooling_off' });
    expect(t.log).toEqual(['chain.finalizeLoosening:7']);
    expect(t.actions.finalizeAmendment).toHaveBeenCalledWith({ strategyId: 's1', txHash: TX });
  });

  it('a registry that refuses early keeps the old rule and saves nothing', async () => {
    const { client } = fakeClient({
      finalizeLoosening: async () => {
        throw new PinError('failed', 'CoolingOff');
      },
    });
    const t = setup({ pinClient: client });
    expect(await runFinalizeFlow(t.input)).toEqual({ ok: false, message: 'CoolingOff' });
    expect(t.actions.finalizeAmendment).not.toHaveBeenCalled();
  });

  it('withdraw is a tighten to exactly what is in force: hash, commitment and series as recorded', async () => {
    const t = setup();
    expect(await runWithdrawFlow(t.input)).toEqual({ ok: true, kind: 'immediate' });
    expect(t.log).toEqual([`chain.tighten:7:0xcurrent:${COMMIT}:${SERIES_BTC}`]);
    expect(t.actions.withdrawAmendment).toHaveBeenCalled();
  });

  it('withdraw with no recorded on-chain state sends nothing', async () => {
    const t = setup({ strategy: { ...cooling, predicatesCommitment: undefined } });
    expect(await runWithdrawFlow(t.input)).toEqual({
      ok: false,
      message: 'This rule has no on-chain record to return to.',
    });
    expect(t.log).toEqual([]);
    expect(t.actions.withdrawAmendment).not.toHaveBeenCalled();
  });

  it('both refuse when nothing is cooling off', async () => {
    const t = setup({ strategy: { ...cooling, status: 'pinned' } });
    expect(await runFinalizeFlow(t.input)).toEqual({ ok: false, message: 'Nothing is cooling off.' });
    expect(await runWithdrawFlow(t.input)).toEqual({ ok: false, message: 'Nothing is cooling off.' });
    expect(t.log).toEqual([]);
  });
});
