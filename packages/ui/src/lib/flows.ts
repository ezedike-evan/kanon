/**
 * The orchestration of the two flows that touch the chain, as plain async
 * functions over injected dependencies.
 *
 * They live outside the hook so their ordering guarantees can be tested with
 * fakes rather than trusted:
 *
 *   - nothing is sent to the chain before the user has confirmed they read the
 *     spec, and nothing is sent at all where pinning is unavailable
 *   - a rule without a stop and a target the user stated is neither pinned
 *     nor changed: it is refused before anything is saved or sent
 *   - the chain is written first, and the row is saved only after the chain
 *     accepted it, so a stored `pinned` always has a transaction behind it
 *   - a pin the chain accepted whose row failed to save is retried, never sent
 *     twice (a second pin would post a second bond)
 *   - the hash that is signed is the hash of the spec that is saved
 *   - a row counts as saved only when the server answers `ok: true`. It reads
 *     the transaction from the chain itself, and when it will not save it says
 *     why in a sentence: that sentence is what the user is shown. A refused pin
 *     is kept and retried exactly as one whose save threw
 *   - the first pin from a wallet the server has not linked asks that wallet
 *     for one signature of the server's own link message, and records the same
 *     pin once more with it. Nothing is sent to the chain for that
 *   - a change the registry took whose row was not saved says so, and names
 *     the transaction
 */

import {
  exitsSentence,
  isSpecOnchainTightening,
  missingExits,
  planAmendment,
  toPredicateDefinitions,
  type StrategySpec,
} from '@kanon/spec';
import type { AmendOutcome, PinOutcome } from './flow-types';
import type { LiveActions } from './live';
import { PinError, buildPinTarget, type PinClient, type PinReceipt, type PinTarget } from './pin';
import { recordWithWalletLink, replyFailed } from './wallet-link';

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

/** Whether the server said it saved the row. Only a plain `ok: true` counts: anything else did not save. */
const replySaved = (reply: unknown): boolean =>
  typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === true;

/** The server's own sentence for a row it would not save, when it sent one. */
const refusalText = (reply: unknown): string | undefined =>
  replyFailed(reply) && typeof reply.message === 'string' && reply.message ? reply.message : undefined;

const unsavedPinText = (txHash: string) =>
  `The registry accepted the pin (${txHash}) but saving it here failed. Try again; it will not be sent twice.`;

/** A tighten, a proposal or a finalize is already on-chain when its row fails to save: say so, and why. */
const unsavedChangeText = (txHash: string, why: string | undefined) =>
  `The registry accepted the change (${txHash}) but saving it here failed${why ? `: ${why}` : '.'}`;

export interface UnsavedPin {
  current: { hash: string; receipt: PinReceipt } | null;
}

export interface PinFlowInput {
  userId: string | undefined;
  spec: StrategySpec | null;
  draft: { _id: string; specHash: string } | undefined;
  acknowledged: boolean;
  pinClient: PinClient;
  actions: Pick<LiveActions, 'saveDraft' | 'pinStrategy' | 'walletLinkMessage'>;
  unsaved: UnsavedPin;
}

export async function runPinFlow(i: PinFlowInput): Promise<PinOutcome> {
  const { userId, spec, draft, pinClient, actions, unsaved } = i;
  if (!userId || !spec || !draft) {
    return { ok: false, reason: 'no_draft', message: 'There is no reviewed draft to pin.' };
  }
  const missing = missingExits(spec);
  if (missing.length > 0) {
    return { ok: false, reason: 'needs_exits', message: exitsSentence(missing) };
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

  // The pin of this spec the chain holds, whether it was sent now or on an earlier try.
  let accepted: PinReceipt | undefined;
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

    accepted = unsaved.current?.hash === hash ? unsaved.current.receipt : undefined;
    if (!accepted) {
      accepted = await pinClient.pin(target);
      unsaved.current = { hash, receipt: accepted };
    }
    const receipt = accepted;
    // The server reads the pin from the chain before it marks the rule pinned. A wallet it has not
    // linked yet signs the link message once, and the same pin is recorded again with that signature.
    const reply = await recordWithWalletLink(
      (extra) =>
        actions.pinStrategy({
          strategyId: draft._id,
          specHash: hash,
          predicatesCommitment: receipt.predicatesCommitment,
          series: receipt.series,
          bondAtoms: receipt.bond,
          txHash: receipt.txHash,
          chainId: receipt.chainId,
          registryAddress: receipt.registryAddress,
          chainStrategyId: receipt.chainStrategyId,
          ...extra,
        }),
      { walletLinkMessage: actions.walletLinkMessage, signMessage: pinClient.signMessage?.bind(pinClient) },
    );
    if (!replySaved(reply)) {
      // Not saved, so the pin stays in `unsaved`: the next try records this one and sends no other.
      return { ok: false, reason: 'failed', message: refusalText(reply) ?? unsavedPinText(receipt.txHash) };
    }
    unsaved.current = null;
    return { ok: true, txHash: receipt.txHash };
  } catch (err) {
    // Before the chain holds the pin, a PinError is the wallet's or the registry's own answer. After
    // it (the link signature was declined) the pin exists and is not saved, which is what is said.
    if (err instanceof PinError && !accepted) return { ok: false, reason: err.code, message: err.message };
    if (unsaved.current) {
      return { ok: false, reason: 'failed', message: unsavedPinText(unsaved.current.receipt.txHash) };
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
  // A rule pinned before targets existed is changed only by a change that states one.
  const missing = missingExits(staged);
  if (missing.length > 0) return { ok: false, message: exitsSentence(missing) };
  if (!strategy.chainStrategyId) {
    return { ok: false, message: 'This rule has no registry entry to amend.' };
  }
  const availability = pinClient.availability();
  if (availability.state !== 'ready') return { ok: false, message: availability.message };

  // The transaction of a change the registry has taken. A failure after it is a failure to save.
  let sent: string | undefined;
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

    // The registry only accepts `tighten` when the decoded predicates prove it; anything else waits.
    if (plan.kind === 'immediate' && isSpecOnchainTightening(current, staged)) {
      const { txHash } = await pinClient.tighten(strategy.chainStrategyId, target, {
        old: toPredicateDefinitions(current),
        next: toPredicateDefinitions(staged),
      });
      sent = txHash;
      const reply = await actions.amendStrategy({
        strategyId: strategy._id,
        nextSpec: staged,
        predicatesCommitment: target.predicatesCommitment,
        series: target.series,
        txHash,
      });
      if (!replySaved(reply)) return { ok: false, message: unsavedChangeText(txHash, refusalText(reply)) };
      return { ok: true, kind: 'immediate' };
    }
    const { txHash, cooldownEndsAtMs } = await pinClient.proposeLoosening(
      strategy.chainStrategyId,
      target,
    );
    sent = txHash;
    const reply = await actions.amendStrategy({
      strategyId: strategy._id,
      nextSpec: staged,
      predicatesCommitment: target.predicatesCommitment,
      series: target.series,
      txHash,
      ...(cooldownEndsAtMs !== null ? { chainCooldownEndsAt: cooldownEndsAtMs } : {}),
    });
    if (!replySaved(reply)) return { ok: false, message: unsavedChangeText(txHash, refusalText(reply)) };
    return { ok: true, kind: 'cooling_off' };
  } catch (err) {
    if (sent) return { ok: false, message: unsavedChangeText(sent, errorText(err, '')) };
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
  /** The spec in force on-chain: a withdrawal re-asserts exactly its predicates. */
  activeSpec?: StrategySpec | null | undefined;
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
  // The transaction of a finalize the registry has taken. A failure after it is a failure to save.
  let sent: string | undefined;
  try {
    const { txHash } = await pinClient.finalizeLoosening(strategy!.chainStrategyId!);
    sent = txHash;
    const reply = await actions.finalizeAmendment({ strategyId: strategy!._id, txHash });
    if (!replySaved(reply)) return { ok: false, message: unsavedChangeText(txHash, refusalText(reply)) };
    return { ok: true, kind: 'cooling_off' };
  } catch (err) {
    if (sent) return { ok: false, message: unsavedChangeText(sent, errorText(err, '')) };
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
  if (!i.activeSpec) {
    return { ok: false, message: 'This rule has no on-chain record to return to.' };
  }
  const active: PinTarget = {
    specHash: strategy!.specHash,
    predicatesCommitment: strategy!.predicatesCommitment,
    series: strategy!.seriesAddress,
  };
  try {
    // Old and new are the same predicates: equal is a valid tightening and clears the pending change.
    const defs = toPredicateDefinitions(i.activeSpec);
    const { txHash } = await pinClient.tighten(strategy!.chainStrategyId!, active, { old: defs, next: defs });
    await actions.withdrawAmendment({ strategyId: strategy!._id, txHash });
    return { ok: true, kind: 'immediate' };
  } catch (err) {
    return { ok: false, message: errorText(err, 'The change could not be withdrawn.') };
  }
}
