/**
 * The on-chain form of a spec's predicates.
 *
 * `StrategyRegistry` pins `predicatesCommitment = keccak256(abi.encode(
 * RefusalGate.PredicateDefinition[]))` next to the spec hash. The spec hash is
 * SHA-256 over canonical JSON, which the chain cannot recompute; this
 * commitment is the part it CAN check — `RefusalGate.evaluateOnChain` hashes
 * the predicates a proposer supplies and reverts unless they equal the pinned
 * commitment. So this encoder must produce exactly the bytes Solidity's
 * `abi.encode(predicates)` produces. `onchain.test.ts` pins a vector generated
 * with `cast abi-encode`, and `packages/contracts/test/RefusalGate.t.sol`
 * asserts the same vector, so TypeScript and Solidity cannot drift apart.
 *
 * The struct (order matters, it is part of the encoding):
 *
 *   struct PredicateDefinition {
 *     PredicateKind kind;            // uint8: 0 BOS, 1 FVG, 2 sweep
 *     bytes32 symbol;                // predicateSymbol(p), right-padded ASCII
 *     Direction direction;           // uint8: 0 long, 1 short
 *     uint256 swingLookbackCandles;  // BOS only, else 0
 *     uint256 minGapBps;             // FVG only, else 0
 *     ReferenceExtreme referenceExtreme; // uint8, sweep only, else 0
 *     Lookback lookback;             // uint8, sweep only, else 0
 *     uint256 timeframeSeconds;      // must equal the series' bucket size
 *   }
 *
 * TRADE SIDE. `RefusalGate.evaluateOnChain(strategyId, isLong, predicates)`
 * approves only the side every predicate authorizes: BOS and FVG follow their
 * `direction`; a liquidity sweep's side is fixed by its reference extreme (a
 * wick below a LOW reference is a long setup, above a HIGH reference a short
 * one). A rule that mixes sides, or a sweep whose `direction` contradicts its
 * reference, reverts on-chain — so this encoder refuses to produce one, and
 * also refuses a rule whose predicates disagree with `spec.direction`.
 *
 * There is deliberately NO scan window: the contract derives it from the
 * series' latest bucket and the predicate's own lookback.
 */

import { encodeAbiParameters, keccak256, stringToHex, type Hex } from 'viem';
import type { Predicate, StrategySpec } from './spec';
import { Lookback, ReferenceExtreme, predicateSymbol } from './spec';

/** Seconds per spec timeframe. Must match the series' `bucketSeconds`. */
export const ONCHAIN_TIMEFRAME_SECONDS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
} as const;

const KIND_INDEX = { break_of_structure: 0, fair_value_gap: 1, liquidity_sweep: 2 } as const;
const DIRECTION_INDEX = { long: 0, short: 1 } as const;

/** The ABI type of `RefusalGate.PredicateDefinition[]`. */
export const PREDICATE_DEFINITIONS_ABI = [
  {
    type: 'tuple[]',
    components: [
      { name: 'kind', type: 'uint8' },
      { name: 'symbol', type: 'bytes32' },
      { name: 'direction', type: 'uint8' },
      { name: 'swingLookbackCandles', type: 'uint256' },
      { name: 'minGapBps', type: 'uint256' },
      { name: 'referenceExtreme', type: 'uint8' },
      { name: 'lookback', type: 'uint8' },
      { name: 'timeframeSeconds', type: 'uint256' },
    ],
  },
] as const;

export interface PredicateDefinition {
  kind: number;
  symbol: Hex;
  direction: number;
  swingLookbackCandles: bigint;
  minGapBps: bigint;
  referenceExtreme: number;
  lookback: number;
  timeframeSeconds: bigint;
}

/** The side a predicate authorizes; mirrors `TradeSide.predicateSide`. */
export function predicateSide(p: Predicate): 'long' | 'short' {
  if (p.kind !== 'liquidity_sweep') return p.direction;
  const low = p.referenceExtreme.value.endsWith('_low');
  return low ? 'long' : 'short';
}

function toDefinition(p: Predicate, bucketSeconds: number): PredicateDefinition {
  const timeframeSeconds = ONCHAIN_TIMEFRAME_SECONDS[p.timeframe.value];
  if (timeframeSeconds !== bucketSeconds) {
    throw new Error(
      `predicate ${p.id}: timeframe ${p.timeframe.value} (${timeframeSeconds}s) does not match the series bucket (${bucketSeconds}s)`,
    );
  }
  if (p.kind === 'liquidity_sweep' && predicateSide(p) !== p.direction) {
    throw new Error(
      `predicate ${p.id}: a sweep of ${p.referenceExtreme.value} is a ${predicateSide(p)} setup, but its direction is ${p.direction}`,
    );
  }
  const base: PredicateDefinition = {
    kind: KIND_INDEX[p.kind],
    symbol: stringToHex(predicateSymbol(p), { size: 32 }),
    direction: DIRECTION_INDEX[p.direction],
    swingLookbackCandles: 0n,
    minGapBps: 0n,
    referenceExtreme: 0,
    lookback: 0,
    timeframeSeconds: BigInt(timeframeSeconds),
  };
  switch (p.kind) {
    case 'break_of_structure':
      return { ...base, swingLookbackCandles: BigInt(p.swingLookbackCandles.value) };
    case 'fair_value_gap':
      return { ...base, minGapBps: BigInt(p.minGapBps.value) };
    case 'liquidity_sweep':
      return {
        ...base,
        referenceExtreme: ReferenceExtreme.options.indexOf(p.referenceExtreme.value),
        lookback: Lookback.options.indexOf(p.lookback.value),
      };
  }
}

/** The predicates as `RefusalGate.PredicateDefinition[]`, in spec order. */
export function toPredicateDefinitions(spec: StrategySpec): PredicateDefinition[] {
  for (const p of spec.predicates) {
    if (predicateSide(p) !== spec.direction) {
      throw new Error(
        `predicate ${p.id} authorizes ${predicateSide(p)} trades but the spec's direction is ${spec.direction}; the gate rejects mixed rules`,
      );
    }
  }
  return spec.predicates.map((p) => toDefinition(p, spec.series.bucketSeconds));
}

/** Exactly the bytes `abi.encode(PredicateDefinition[])` produces on-chain. */
export function encodePredicates(spec: StrategySpec): Hex {
  return encodeAbiParameters(PREDICATE_DEFINITIONS_ABI, [toPredicateDefinitions(spec)]);
}

/**
 * `keccak256(encodePredicates(spec))` — the value passed to
 * `StrategyRegistry.pinStrategy` / `tighten` / `proposeLoosening`.
 */
export function predicatesCommitment(spec: StrategySpec): Hex {
  return keccak256(encodePredicates(spec));
}

/**
 * Mirror of `StrategyRegistry._requireTightening`, rule for rule. `tighten`
 * is accepted on-chain only if the new predicates keep every old predicate
 * identical (same index, same fields) except `minGapBps`, which may stay equal
 * or grow, and may append further predicates. Removal, reordering, a lower
 * gap, or any changed lookback/timeframe/symbol is a loosening as far as the
 * chain is concerned and must go through `proposeLoosening`.
 */
export function isOnchainTightening(
  oldDefs: readonly PredicateDefinition[],
  newDefs: readonly PredicateDefinition[],
): boolean {
  if (newDefs.length < oldDefs.length) return false;
  return oldDefs.every((a, i) => {
    const b = newDefs[i]!;
    return (
      a.kind === b.kind &&
      a.symbol === b.symbol &&
      a.direction === b.direction &&
      a.swingLookbackCandles === b.swingLookbackCandles &&
      a.referenceExtreme === b.referenceExtreme &&
      a.lookback === b.lookback &&
      a.timeframeSeconds === b.timeframeSeconds &&
      b.minGapBps >= a.minGapBps
    );
  });
}

/**
 * Whether `next` can be applied with the registry's `tighten`. False when the
 * predicates are not provably stricter, or when either spec cannot be encoded
 * for the gate (the chain could never have accepted it).
 */
export function isSpecOnchainTightening(current: StrategySpec, next: StrategySpec): boolean {
  try {
    return isOnchainTightening(toPredicateDefinitions(current), toPredicateDefinitions(next));
  } catch {
    return false;
  }
}
