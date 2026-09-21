/**
 * The orchestration of the two flows that touch the chain, as plain async
 * functions over injected dependencies.
 *
 * They live outside the hook so their ordering guarantees can be tested with
 * fakes rather than trusted:
 *
 *   - nothing is sent to the chain before the user has confirmed they read the
 *     spec, and nothing is sent at all where pinning is unavailable
 *   - the chain is written first, and the row is saved only after the chain
 *     accepted it, so a stored `pinned` always has a transaction behind it
 *   - a pin the chain accepted whose row failed to save is retried, never sent
 *     twice (a second pin would post a second bond)
 *   - the hash that is signed is the hash of the spec that is saved
 */

import { planAmendment, type StrategySpec } from '@kanon/spec';
import type { AmendOutcome, PinOutcome } from './flow-types';
import type { LiveActions } from './live';
import { PinError, buildPinTarget, type PinClient, type PinReceipt, type PinTarget } from './pin';

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export interface UnsavedPin {
  current: { hash: string; receipt: PinReceipt } | null;
}

export interface PinFlowInput {
  userId: string | undefined;
  spec: StrategySpec | null;
  draft: { _id: string; specHash: string } | undefined;
  acknowledged: boolean;
  pinClient: PinClient;
  actions: Pick<LiveActions, 'saveDraft' | 'pinStrategy'>;
  unsaved: UnsavedPin;
}

export async function runPinFlow(i: PinFlowInput): Promise<PinOutcome> {
  const { userId, spec, draft, pinClient, actions, unsaved } = i;
  if (!userId || !spec || !draft) {
    return { ok: false, reason: 'no_draft', message: 'There is no reviewed draft to pin.' };
  }
  if (!i.acknowledged) {
    return {
      ok: false,
      reason: 'not_reviewed',
      message: 'Read the spec, and confirm you have, before it is pinned.',
    };
  }
  const availability = pinClient.availability();
  if (availability.state !== 'ready') {
    return {
      ok: false,
      reason: availability.state === 'no_wallet' ? 'no_wallet' : 'not_deployed',
      message: availability.message,
    };
  }

  try {
    // The hash, the predicates commitment and the series address, all derived from the spec.
    // A rule with no deployed series, or one the gate cannot encode, is not sent anywhere.
    const built = await buildPinTarget(spec, pinClient.series);
    if (!built.ok) {
      return {
        ok: false,
        reason: built.reason === 'series_not_deployed' ? 'not_deployed' : 'failed',
        message: built.message,
      };
    }
    const { target } = built;
    const hash = target.specHash;
    // The row that gets pinned must be the spec whose hash is signed.
    if (draft.specHash !== hash) {
      await actions.saveDraft({ strategyId: draft._id, spec });
    }

    let receipt = unsaved.current?.hash === hash ? unsaved.current.receipt : undefined;
    if (!receipt) {
      receipt = await pinClient.pin(target);
      unsaved.current = { hash, receipt };
    }
    await actions.pinStrategy({
      strategyId: draft._id,
      specHash: hash,
      predicatesCommitment: receipt.predicatesCommitment,
      series: receipt.series,
      bondAtoms: receipt.bond,
      txHash: receipt.txHash,
      chainId: receipt.chainId,
      registryAddress: receipt.registryAddress,
      chainStrategyId: receipt.chainStrategyId,
    });
    unsaved.current = null;
    return { ok: true, txHash: receipt.txHash };
  } catch (err) {
    if (err instanceof PinError) return { ok: false, reason: err.code, message: err.message };
    if (unsaved.current) {
      return {
        ok: false,
        reason: 'failed',
        message: `The registry accepted the pin (${unsaved.current.receipt.txHash}) but saving it here failed. Try again; it will not be sent twice.`,
      };
    }
    return { ok: false, reason: 'failed', message: errorText(err, 'The pin did not complete.') };
  }
}

export interface AmendFlowInput {
  userId: string | undefined;
  strategy:
    | { _id: string; chainStrategyId?: string | undefined; seriesAddress?: string | undefined }
    | undefined;
  current: StrategySpec | null;
  staged: StrategySpec | null;
  pinClient: PinClient;
  actions: Pick<LiveActions, 'amendStrategy'>;
}

/** Sends a staged change: `tighten` when it can apply now, `proposeLoosening` when it must wait. */
export async function runAmendFlow(i: AmendFlowInput): Promise<AmendOutcome> {
  const { userId, strategy, current, staged, pinClient, actions } = i;
  if (!userId || !strategy || !current || !staged) {
    return { ok: false, message: 'There is no staged change to send.' };
  }
  if (!strategy.chainStrategyId) {
    return { ok: false, message: 'This rule has no registry entry to amend.' };
  }
  const availability = pinClient.availability();
  if (availability.state !== 'ready') return { ok: false, message: availability.message };

  try {
    const built = await buildPinTarget(staged, pinClient.series);
    if (!built.ok) return { ok: false, message: built.message };
    const { target } = built;

    // A change that moves the pinned series address cannot be ordered: it waits, however small it looks.
    const plan = planAmendment(current, staged, {
      currentSeries: strategy.seriesAddress,
      nextSeries: target.series,
    });
    if (plan.kind === 'none') return { ok: false, message: 'Nothing has changed.' };

    if (plan.kind === 'immediate') {
      const { txHash } = await pinClient.tighten(strategy.chainStrategyId, target);
      await actions.amendStrategy({
        strategyId: strategy._id,
        nextSpec: staged,
        predicatesCommitment: target.predicatesCommitment,
        series: target.series,
        txHash,
      });
      return { ok: true, kind: 'immediate' };
    }
    const { txHash, cooldownEndsAtMs } = await pinClient.proposeLoosening(
      strategy.chainStrategyId,
      target,
    );
    await actions.amendStrategy({
      strategyId: strategy._id,
      nextSpec: staged,
      predicatesCommitment: target.predicatesCommitment,
      series: target.series,
      txHash,
      ...(cooldownEndsAtMs !== null ? { chainCooldownEndsAt: cooldownEndsAtMs } : {}),
    });
    return { ok: true, kind: 'cooling_off' };
  } catch (err) {
    return { ok: false, message: errorText(err, 'The change could not be sent.') };
  }
}

export interface PendingFlowInput {
  userId: string | undefined;
  strategy:
    | {
        _id: string;
        status: string;
        chainStrategyId?: string | undefined;
        specHash: string;
        /** What is active on-chain: a withdrawal re-asserts exactly this. */
        predicatesCommitment?: string | undefined;
        seriesAddress?: string | undefined;
      }
    | undefined;
  pinClient: PinClient;
  actions: Pick<LiveActions, 'finalizeAmendment' | 'withdrawAmendment'>;
}

function pendingGuard(i: PendingFlowInput): AmendOutcome | null {
  if (!i.userId || !i.strategy || i.strategy.status !== 'cooling_off' || !i.strategy.chainStrategyId) {
    return { ok: false, message: 'Nothing is cooling off.' };
  }
  const availability = i.pinClient.availability();
  return availability.state === 'ready' ? null : { ok: false, message: availability.message };
}

/** Applies a loosening whose hold has run: the registry first (it refuses early), then the row. */
export async function runFinalizeFlow(i: PendingFlowInput): Promise<AmendOutcome> {
  const blocked = pendingGuard(i);
  if (blocked) return blocked;
  const { strategy, pinClient, actions } = i;
  try {
    const { txHash } = await pinClient.finalizeLoosening(strategy!.chainStrategyId!);
    await actions.finalizeAmendment({ strategyId: strategy!._id, txHash });
    return { ok: true, kind: 'cooling_off' };
  } catch (err) {
    return { ok: false, message: errorText(err, 'The change could not be applied yet.') };
  }
}

/**
 * Drops a pending loosening. On-chain that is a `tighten` to the hash already in
 * force, which clears the pending change; the current rule never stopped
 * being enforced.
 */
export async function runWithdrawFlow(i: PendingFlowInput): Promise<AmendOutcome> {
  const blocked = pendingGuard(i);
  if (blocked) return blocked;
  const { strategy, pinClient, actions } = i;
  // Withdrawing is a `tighten` to what is already in force: hash, commitment and series, as recorded.
  if (!strategy!.predicatesCommitment || !strategy!.seriesAddress) {
    return { ok: false, message: 'This rule has no on-chain record to return to.' };
  }
  const active: PinTarget = {
    specHash: strategy!.specHash,
    predicatesCommitment: strategy!.predicatesCommitment,
    series: strategy!.seriesAddress,
  };
  try {
    const { txHash } = await pinClient.tighten(strategy!.chainStrategyId!, active);
    await actions.withdrawAmendment({ strategyId: strategy!._id, txHash });
    return { ok: true, kind: 'immediate' };
  } catch (err) {
    return { ok: false, message: errorText(err, 'The change could not be withdrawn.') };
  }
}
