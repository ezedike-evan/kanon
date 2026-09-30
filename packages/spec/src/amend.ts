/**
 * What happens when a pinned rule is changed.
 *
 * Tightening is immediate. Loosening waits out the cooling-off period. There is
 * no override, so the plan is computed here, in one pure place, and every
 * caller (the review screen, the Convex mutation, the on-chain call) reads the
 * same answer.
 *
 * `diffSpec` orders only the parameters it knows how to order. A change it does
 * not cover — a different direction, a different series, a predicate flipped
 * long to short — would otherwise read as "no change" and slip through
 * immediately. Any difference that is not provably a tightening therefore
 * waits.
 */

import { COOLING_OFF_SECONDS, diffSpec } from './diff';
import type { SpecDiff } from './diff';
import { canonicalizeSpec } from './hash';
import { isSpecOnchainTightening, toPredicateDefinitions } from './onchain';
import type { StrategySpec } from './spec';
import { predicateSymbol } from './spec';

export type AmendmentPlan =
  | { kind: 'none' }
  /** Applies at once. Every change is a tightening or a cosmetic rename. */
  | { kind: 'immediate'; diff: SpecDiff }
  /** Waits `cooldownSeconds` before it applies. The old spec stays enforced. */
  | { kind: 'cooling_off'; diff: SpecDiff; cooldownSeconds: number };

/**
 * The parts of a spec that decide what it admits, other than the parameters
 * `diffSpec` orders. A predicate added or removed is ordered by `diffSpec`
 * (adding tightens, removing loosens); what it cannot order is a shared
 * predicate whose direction changed, or a different direction, series or
 * version for the spec as a whole.
 */
function unorderable(current: StrategySpec, next: StrategySpec): boolean {
  const whole = (s: StrategySpec) => JSON.stringify([s.version, s.direction, s.series]);
  if (whole(current) !== whole(next)) return true;
  const directions = new Map(current.predicates.map((p) => [predicateSymbol(p), p.direction]));
  return next.predicates.some((p) => {
    const before = directions.get(predicateSymbol(p));
    return before !== undefined && before !== p.direction;
  });
}

/**
 * The registry pins a series address next to the spec hash. Two specs can be
 * identical field for field and still point the gate at a different tape, so
 * the on-chain address is part of what an amendment changes.
 */
export interface AmendmentChain {
  /** The series address currently pinned on-chain. */
  currentSeries?: string | undefined;
  /** The series address the amended spec would pin. */
  nextSeries?: string | undefined;
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function encodable(s: StrategySpec): boolean {
  try {
    toPredicateDefinitions(s);
    return true;
  } catch {
    return false;
  }
}

function acceptedByChainTighten(current: StrategySpec, next: StrategySpec): boolean {
  // A spec the gate cannot encode is refused long before the chain; keep diffSpec's answer.
  if (!encodable(current) || !encodable(next)) return true;
  return isSpecOnchainTightening(current, next);
}

export function planAmendment(
  current: StrategySpec,
  next: StrategySpec,
  chain: AmendmentChain = {},
): AmendmentPlan {
  const seriesMoved =
    chain.currentSeries !== undefined &&
    chain.nextSeries !== undefined &&
    !sameAddress(chain.currentSeries, chain.nextSeries);

  if (!seriesMoved && canonicalizeSpec(current) === canonicalizeSpec(next)) return { kind: 'none' };

  const diff = diffSpec(current, next);
  // A different series address cannot be ordered, so it waits like any loosening.
  // The registry's own `tighten` accepts a narrower set than `diffSpec` orders (a longer
  // swing lookback reads as tighter here, but the chain treats any lookback change as a
  // loosening). When both specs encode for the gate, the chain's rule is the final word.
  const cannotOrder = seriesMoved || unorderable(current, next) || !acceptedByChainTighten(current, next);

  if (diff.requiresCoolingOff || cannotOrder) {
    return {
      kind: 'cooling_off',
      diff: { ...diff, requiresCoolingOff: true },
      cooldownSeconds: COOLING_OFF_SECONDS,
    };
  }
  return { kind: 'immediate', diff };
}

/** When a loosening requested at `requestedAtMs` may apply. */
export function cooldownEndsAt(requestedAtMs: number, cooldownSeconds = COOLING_OFF_SECONDS): number {
  return requestedAtMs + cooldownSeconds * 1000;
}

/** Milliseconds left. Never negative, and never more than the hold itself. */
export function cooldownRemainingMs(endsAtMs: number, nowMs: number): number {
  return Math.max(0, endsAtMs - nowMs);
}

export function cooldownElapsed(endsAtMs: number, nowMs: number): boolean {
  return nowMs >= endsAtMs;
}
