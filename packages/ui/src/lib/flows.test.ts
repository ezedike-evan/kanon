import { createElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  BOS20_15M_NO_TARGET,
  RULE_04,
  RULE_04_NO_TARGET,
  applyParamEdit,
  dec,
  predicatesCommitment,
  specHash,
  stated,
  toPredicateDefinitions,
  type StrategySpec,
} from '@kanon/spec';
import { useConvexKanonSource } from './convex-source';
import { KanonDataProvider, useKanonData, type KanonDataSource } from './data';
import { createFakeConvex } from './fake-convex.test-util';
import {
  runAmendFlow,
  runFinalizeFlow,
  runPinFlow,
  runWithdrawFlow,
  type UnsavedPin,
} from './flows';
import type { LiveActions } from './live';
import { PinError, type PinClient, type PinReceipt, type PinTarget } from './pin';
import { createHarness, settle } from './render-harness';

const TX = `0x${'cd'.repeat(32)}`;
// The server's own sentences, as `strategies.ts` words them. The flows show them as they are.
const NOT_CONFIRMED = 'The transaction is not confirmed yet. Try again in a moment; nothing needs to be sent twice.';
const NOT_LINKED = 'Sign the link message with your wallet, so the pin can be checked against it.';
const BAD_SIGNATURE = 'That signature is not from a wallet. Sign the link message again.';
const LINK_MESSAGE = 'Link this wallet to Kanon account did:privy:abc';
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
const tightenCalls: Array<{ old: unknown; next: unknown }> = [];

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
    tighten: async (id, target, preds) => {
      log.push(`chain.tighten:${id}:${target.specHash}:${target.predicatesCommitment}:${target.series}`);
      tightenCalls.push(preds);
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
    pinStrategy: vi.fn<LiveActions['pinStrategy']>(async () => {
      log.push('convex.pinStrategy');
      return { ok: true, specHash: hash };
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

  it('will not pin a rule without a stated target: nothing is saved or sent', async () => {
    const t = await pinInput({ spec: RULE_04_NO_TARGET });
    const out = await runPinFlow(t.input);
    expect(out).toEqual({
      ok: false,
      reason: 'needs_exits',
      message: 'This rule has no stated target. A rule is pinned and tested only with a stop and a target you set.',
    });
    expect(t.chainLog).toEqual([]);
    expect(t.log).toEqual([]);
  });

  it('will not pin a rule whose stop the compiler chose', async () => {
    const chosen = { ...RULE_04, risk: { ...RULE_04.risk, stopDistanceBps: { value: 50, inferred: true } } };
    const t = await pinInput({ spec: chosen });
    expect(await runPinFlow(t.input)).toMatchObject({ ok: false, reason: 'needs_exits' });
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
      return { ok: true, specHash: t.hash };
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

describe('runPinFlow: what the server answers', () => {
  it('a pin the server will not save is reported in its words, kept, and never sent twice', async () => {
    const t = await pinInput();
    const refusal = { ok: false, reason: 'not_confirmed', message: NOT_CONFIRMED } as const;
    t.actions.pinStrategy.mockResolvedValueOnce(refusal).mockResolvedValueOnce(refusal);
    const state = unsaved();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await runPinFlow({ ...t.input, unsaved: state })).toEqual({
        ok: false,
        reason: 'failed',
        message: NOT_CONFIRMED,
      });
      expect(state.current).toEqual({ hash: t.hash, receipt: RECEIPT });
    }

    expect(await runPinFlow({ ...t.input, unsaved: state })).toEqual({ ok: true, txHash: TX });
    expect(t.chainLog).toHaveLength(1); // one pin, one bond, however many tries it took to save
    expect(t.actions.pinStrategy).toHaveBeenCalledTimes(3);
    // Every try records the same pin.
    const calls = t.actions.pinStrategy.mock.calls.map(([args]) => args);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]).toEqual(calls[0]);
    expect(state.current).toBeNull();
  });

  it('a reply that does not say ok is not a save', async () => {
    const t = await pinInput();
    t.actions.pinStrategy.mockResolvedValueOnce({} as never);
    const state = unsaved();
    const out = await runPinFlow({ ...t.input, unsaved: state });
    expect(out).toMatchObject({ ok: false, reason: 'failed' });
    expect(out.ok === false && out.message).toContain(TX);
    expect(state.current).not.toBeNull();
  });

  /** A wallet that can sign, a server that hands out its link message, and a pin recorded through both. */
  async function linking(over: Partial<PinClient> = {}) {
    const sign = vi.fn(async (_message: string) => '0xsig');
    const link = vi.fn(async () => ({ message: LINK_MESSAGE }));
    const { client, log: chainLog } = fakeClient({ signMessage: sign, ...over });
    const t = await pinInput({ pinClient: client });
    const state = unsaved();
    const notLinked = { ok: false, reason: 'wallet_not_linked', message: NOT_LINKED } as const;
    return {
      sign,
      link,
      chainLog,
      state,
      notLinked,
      pinStrategy: t.actions.pinStrategy,
      input: { ...t.input, actions: { ...t.actions, walletLinkMessage: link }, unsaved: state },
    };
  }

  it('a wallet the server has not linked signs the link message once, and the same pin is recorded with it', async () => {
    const t = await linking();
    t.pinStrategy.mockResolvedValueOnce(t.notLinked);

    expect(await runPinFlow(t.input)).toEqual({ ok: true, txHash: TX });
    expect(t.link).toHaveBeenCalledTimes(1);
    expect(t.sign).toHaveBeenCalledTimes(1);
    expect(t.sign).toHaveBeenCalledWith(LINK_MESSAGE);
    expect(t.pinStrategy).toHaveBeenCalledTimes(2);
    const [first, second] = t.pinStrategy.mock.calls.map(([args]) => args);
    expect(first).not.toHaveProperty('walletSignature');
    expect(second).toEqual({ ...first, walletSignature: '0xsig' });
    expect(t.chainLog).toHaveLength(1); // linking sends nothing to the chain
    expect(t.state.current).toBeNull();
  });

  it('a wallet the server already knows is never asked to sign', async () => {
    const t = await linking();
    expect(await runPinFlow(t.input)).toEqual({ ok: true, txHash: TX });
    expect(t.link).not.toHaveBeenCalled();
    expect(t.sign).not.toHaveBeenCalled();
    expect(t.pinStrategy).toHaveBeenCalledTimes(1);
  });

  it('retries once: a signature the server refuses is its failure, and the pin is kept', async () => {
    const t = await linking();
    t.pinStrategy
      .mockResolvedValueOnce(t.notLinked)
      .mockResolvedValueOnce({ ok: false, reason: 'bad_signature', message: BAD_SIGNATURE });

    expect(await runPinFlow(t.input)).toEqual({ ok: false, reason: 'failed', message: BAD_SIGNATURE });
    expect(t.sign).toHaveBeenCalledTimes(1);
    expect(t.pinStrategy).toHaveBeenCalledTimes(2);
    expect(t.chainLog).toHaveLength(1);
    expect(t.state.current).not.toBeNull();
  });

  it('a client that cannot sign returns the server failure, and keeps the pin for the next try', async () => {
    const { client, log: chainLog } = fakeClient(); // no `signMessage`
    const t = await linking();
    t.pinStrategy.mockResolvedValue(t.notLinked);

    const input = { ...t.input, pinClient: client };
    expect(await runPinFlow(input)).toEqual({ ok: false, reason: 'failed', message: NOT_LINKED });
    expect(t.link).not.toHaveBeenCalled();
    expect(t.pinStrategy).toHaveBeenCalledTimes(1);
    expect(t.state.current).not.toBeNull();

    // The next try records the pin already made. It does not post a second bond.
    expect(await runPinFlow(input)).toEqual({ ok: false, reason: 'failed', message: NOT_LINKED });
    expect(chainLog).toHaveLength(1);
    expect(t.pinStrategy).toHaveBeenCalledTimes(2);
  });

  it('a source with no link message to hand out returns the server failure too', async () => {
    const t = await linking();
    t.pinStrategy.mockResolvedValue(t.notLinked);
    const { walletLinkMessage: _none, ...actions } = t.input.actions;

    expect(await runPinFlow({ ...t.input, actions })).toEqual({ ok: false, reason: 'failed', message: NOT_LINKED });
    expect(t.sign).not.toHaveBeenCalled();
    expect(t.pinStrategy).toHaveBeenCalledTimes(1);
  });

  it('a declined link signature does not say nothing was pinned: the pin is kept and recorded on the next try', async () => {
    const t = await linking();
    t.pinStrategy.mockResolvedValueOnce(t.notLinked).mockResolvedValueOnce(t.notLinked);
    t.sign.mockRejectedValueOnce(new PinError('rejected', 'The signature was declined. Nothing was pinned.'));

    const first = await runPinFlow(t.input);
    expect(first).toMatchObject({ ok: false, reason: 'failed' });
    expect(first.ok === false && first.message).toContain(TX);
    expect(first.ok === false && first.message).not.toMatch(/nothing was pinned/i);
    expect(t.state.current).not.toBeNull();

    expect(await runPinFlow(t.input)).toEqual({ ok: true, txHash: TX });
    expect(t.chainLog).toHaveLength(1);
    expect(t.pinStrategy).toHaveBeenLastCalledWith(expect.objectContaining({ walletSignature: '0xsig' }));
    expect(t.state.current).toBeNull();
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
    const actions = {
      amendStrategy: vi.fn<LiveActions['amendStrategy']>(async () => ({
        ok: true,
        kind: 'immediate',
        specHash: '0xnext',
      })),
    };
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

  it('tighten carries the pinned predicates and the new ones', async () => {
    tightenCalls.length = 0;
    const next = edit(RULE_04, 'p2.minGapBps', 500);
    const t = await setup(next);
    expect(await runAmendFlow(t.input)).toEqual({ ok: true, kind: 'immediate' });
    expect(tightenCalls).toEqual([
      { old: toPredicateDefinitions(RULE_04), next: toPredicateDefinitions(next) },
    ]);
  });

  it('a change the chain would not take as a tightening goes to proposeLoosening, never tighten', async () => {
    const t = await setup(edit(RULE_04, 'p1.swingLookbackCandles', 9));
    expect(await runAmendFlow(t.input)).toEqual({ ok: true, kind: 'cooling_off' });
    expect(t.log).toHaveLength(1);
    expect(t.log[0]).toMatch(/^chain\.proposeLoosening:/);
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

  it('stating a target on a rule pinned without one goes on-chain as tighten, and applies now', async () => {
    const t = await setup(edit(BOS20_15M_NO_TARGET, 'risk.targetDistanceBps', 400), { current: BOS20_15M_NO_TARGET });
    expect(await runAmendFlow(t.input)).toEqual({ ok: true, kind: 'immediate' });
    expect(t.log).toHaveLength(1);
    expect(t.log[0]).toMatch(/^chain\.tighten:7:/);
  });

  it('will not send a change that leaves the rule without a stated target', async () => {
    const t = await setup(edit(BOS20_15M_NO_TARGET, 'risk.riskPerTradeBps', 50), { current: BOS20_15M_NO_TARGET });
    expect(await runAmendFlow(t.input)).toEqual({
      ok: false,
      message: 'This rule has no stated target. A rule is pinned and tested only with a stop and a target you set.',
    });
    expect(t.log).toEqual([]);
    expect(t.actions.amendStrategy).not.toHaveBeenCalled();
  });

  it('moving a target waits: it goes on-chain as proposeLoosening', async () => {
    const t = await setup(edit(RULE_04, 'risk.targetDistanceBps', 150));
    expect(await runAmendFlow(t.input)).toEqual({ ok: true, kind: 'cooling_off' });
    expect(t.log[0]).toMatch(/^chain\.proposeLoosening:/);
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
    // Nothing reached the registry, so nothing claims it did.
    expect(await runAmendFlow(t.input)).toEqual({
      ok: false,
      message: 'The signature was declined. Nothing was pinned.',
    });
    expect(t.actions.amendStrategy).not.toHaveBeenCalled();
  });

  it('a tightening the registry took and the server will not save says so, with the transaction', async () => {
    const t = await setup(edit(RULE_04, 'risk.riskPerTradeBps', 25));
    t.actions.amendStrategy.mockResolvedValueOnce({ ok: false, reason: 'not_confirmed', message: NOT_CONFIRMED });
    expect(await runAmendFlow(t.input)).toEqual({
      ok: false,
      message: `The registry accepted the change (${TX}) but saving it here failed: ${NOT_CONFIRMED}`,
    });
    expect(t.log).toHaveLength(1);
    expect(t.log[0]).toMatch(/^chain\.tighten:/);
  });

  it('a loosening the registry took and the server will not save says so, with the transaction', async () => {
    const t = await setup(edit(RULE_04, 'risk.stopDistanceBps', 90));
    t.actions.amendStrategy.mockResolvedValueOnce({ ok: false, reason: 'not_confirmed', message: NOT_CONFIRMED });
    expect(await runAmendFlow(t.input)).toEqual({
      ok: false,
      message: `The registry accepted the change (${TX}) but saving it here failed: ${NOT_CONFIRMED}`,
    });
    expect(t.log).toHaveLength(1);
    expect(t.log[0]).toMatch(/^chain\.proposeLoosening:/);
  });

  it('a save that throws after the registry took the change says so too', async () => {
    const t = await setup(edit(RULE_04, 'risk.riskPerTradeBps', 25));
    t.actions.amendStrategy.mockRejectedValueOnce(new Error('network'));
    expect(await runAmendFlow(t.input)).toEqual({
      ok: false,
      message: `The registry accepted the change (${TX}) but saving it here failed: network`,
    });
  });

  it('a reply that does not say ok is not a save', async () => {
    const t = await setup(edit(RULE_04, 'risk.riskPerTradeBps', 25));
    t.actions.amendStrategy.mockResolvedValueOnce({ kind: 'immediate' } as never);
    expect(await runAmendFlow(t.input)).toEqual({
      ok: false,
      message: `The registry accepted the change (${TX}) but saving it here failed.`,
    });
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
      finalizeAmendment: vi.fn<LiveActions['finalizeAmendment']>(async () => ({ ok: true, specHash: '0xnext' })),
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

  it('a finalize the registry took and the server will not save says so, with the transaction', async () => {
    const t = setup();
    t.actions.finalizeAmendment.mockResolvedValueOnce({ ok: false, reason: 'not_confirmed', message: NOT_CONFIRMED });
    expect(await runFinalizeFlow(t.input)).toEqual({
      ok: false,
      message: `The registry accepted the change (${TX}) but saving it here failed: ${NOT_CONFIRMED}`,
    });
    expect(t.log).toEqual(['chain.finalizeLoosening:7']);
  });

  it('a finalize whose save throws after the registry took it says so too', async () => {
    const t = setup();
    t.actions.finalizeAmendment.mockRejectedValueOnce(new Error('nothing is cooling off'));
    expect(await runFinalizeFlow(t.input)).toEqual({
      ok: false,
      message: `The registry accepted the change (${TX}) but saving it here failed: nothing is cooling off`,
    });
  });

  it('withdraw is a tighten to exactly what is in force: hash, commitment and series as recorded', async () => {
    tightenCalls.length = 0;
    const t = setup({ activeSpec: RULE_04 });
    expect(await runWithdrawFlow(t.input)).toEqual({ ok: true, kind: 'immediate' });
    expect(t.log).toEqual([`chain.tighten:7:0xcurrent:${COMMIT}:${SERIES_BTC}`]);
    const defs = toPredicateDefinitions(RULE_04);
    expect(tightenCalls).toEqual([{ old: defs, next: defs }]);
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

describe('the pin, through the data source', () => {
  it('records through actions, and links the wallet with the message the server hands out', async () => {
    const hash = await specHash(RULE_04);
    const sign = vi.fn(async (_message: string) => '0xsig');
    const { client, log: chainLog } = fakeClient({ signMessage: sign });
    const fake = createFakeConvex();
    // Which hook each function was bound with: the server refuses a call made as the wrong kind.
    const bound: Record<string, string> = {};
    const hooks = {
      useQuery: fake.hooks.useQuery,
      useMutation: (ref: any) => {
        bound[ref.__name] = 'mutation';
        return fake.hooks.useMutation(ref);
      },
      useAction: (ref: any) => {
        bound[ref.__name] = 'action';
        return fake.hooks.useAction(ref);
      },
    };

    const seen: { source: KanonDataSource | null } = { source: null };
    function Reader(): null {
      seen.source = useKanonData();
      return null;
    }
    const screens = [createElement(Reader, { key: 'reader' })];
    function Bridge(): ReactElement {
      const source = useConvexKanonSource({
        hooks,
        api: fake.api,
        session: { pending: false, signedIn: true },
        pinClient: client,
        hasWallet: true,
      });
      return createElement(KanonDataProvider, { source, children: screens });
    }
    const h = createHarness();
    await h.render(createElement(Bridge));
    fake.emit('users.me', { _id: 'u1', username: 'x', name: 'X' });
    fake.emit('strategies.listStrategiesByOwner', [
      { _id: 'd1', _creationTime: 1, status: 'draft', pendingSpec: RULE_04, specHash: hash },
    ]);
    await settle();

    expect(bound).toMatchObject({
      'strategies.pinStrategy': 'action',
      'strategies.amendStrategy': 'action',
      'strategies.finalizeAmendment': 'action',
      'strategies.withdrawAmendment': 'mutation',
      'users.walletLinkChallenge': 'action',
    });

    const replies: unknown[] = [
      { ok: false, reason: 'wallet_not_linked', message: NOT_LINKED },
      { ok: true, specHash: hash },
    ];
    fake.onAction('strategies.pinStrategy', () => replies.shift());
    fake.onAction('users.walletLinkChallenge', () => ({ message: LINK_MESSAGE }));

    seen.source!.acknowledgeReview(true);
    await settle();
    expect(await seen.source!.pinStrategy()).toEqual({ ok: true, txHash: TX });

    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith(LINK_MESSAGE);
    const recorded = fake.actionArgs.filter((c) => c.name === 'strategies.pinStrategy').map((c) => c.args);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({ strategyId: 'd1', specHash: hash, txHash: TX });
    expect(recorded[1]).toEqual({ ...(recorded[0] as object), walletSignature: '0xsig' });
    expect(chainLog).toHaveLength(1);
    await h.unmount();
  });
});

describe('the compiler, through the data source', () => {
  it('a question for a missing target joins the conversation, drafts nothing, and the answer is sent with wire names', async () => {
    const hash = await specHash(RULE_04);
    const { client } = fakeClient();
    const fake = createFakeConvex();
    const QUESTION = 'Where is your target? Give it as a distance from entry, for example 4%.';
    const answers: unknown[] = [
      { status: 'needs_input', reply: QUESTION, missing: ['target_distance'] },
      { status: 'compiled', spec: RULE_04, reply: 'Compiled.', specHash: hash },
    ];
    fake.onAction('compiler.compileStrategy', () => answers.shift());
    fake.onMutation('strategies.saveDraft', () => ({ strategyId: 'd1', specHash: hash }));

    const seen: { source: KanonDataSource | null } = { source: null };
    function Reader(): null {
      seen.source = useKanonData();
      return null;
    }
    const screens = [createElement(Reader, { key: 'reader' })];
    function Bridge(): ReactElement {
      const source = useConvexKanonSource({
        hooks: fake.hooks,
        api: fake.api,
        session: { pending: false, signedIn: true },
        pinClient: client,
        hasWallet: true,
      });
      return createElement(KanonDataProvider, { source, children: screens });
    }
    const h = createHarness();
    await h.render(createElement(Bridge));
    fake.emit('users.me', { _id: 'u1', username: 'x', name: 'X' });
    fake.emit('strategies.listStrategiesByOwner', []);
    await settle();

    await seen.source!.sendCompilerMessage('BOS 20, risk 1%, stop 2%');
    await settle();
    expect(seen.source!.compiler.status).toBe('idle');
    expect(seen.source!.compiler.error).toBeUndefined();
    expect(seen.source!.compiler.transcript.map((t) => [t.from, t.text])).toEqual([
      ['YOU', 'BOS 20, risk 1%, stop 2%'],
      ['KANON', QUESTION],
    ]);
    expect(seen.source!.hasDraft).toBe(false);
    expect(fake.mutationCalls.filter((c) => c.name === 'strategies.saveDraft')).toEqual([]);

    await seen.source!.sendCompilerMessage('target 4%');
    await settle();
    const calls = fake.actionArgs.filter((c) => c.name === 'compiler.compileStrategy').map((c) => c.args);
    expect(calls).toHaveLength(2);
    // The compiler's validator takes `user` and `assistant`, never the transcript's YOU and KANON.
    expect(calls[1]).toMatchObject({
      prompt: 'target 4%',
      conversationHistory: [
        { from: 'user', text: 'BOS 20, risk 1%, stop 2%' },
        { from: 'assistant', text: QUESTION },
      ],
    });
    expect(fake.mutationCalls.filter((c) => c.name === 'strategies.saveDraft')).toHaveLength(1);
    await h.unmount();
  });
});
