/**
 * Spec diffing, and the tighten/loosen classification the cooling-off period
 * hangs off.
 *
 * Tightening a rule takes effect immediately. Loosening one waits. There is no
 * override and no admin path, so the classification has to be conservative:
 * anything that is not provably a tightening is treated as a loosening. A
 * change that cannot be ordered — swapping a timeframe, changing the reference
 * extreme — widens what the spec might admit, and waits.
 */

import type { Param, StrategySpec } from './spec';
import { predicateSymbol } from './spec';

export type ChangeKind = 'tighten' | 'loosen' | 'add' | 'remove';

export interface SpecChange {
  /** The parameter name as it appears in the parametric view. */
  path: string;
  before: string | null;
  after: string | null;
  kind: ChangeKind;
}

export interface SpecDiff {
  changes: SpecChange[];
  /** True if any change loosens the rule. Drives the cooling-off period. */
  requiresCoolingOff: boolean;
}

/** Windows ordered shortest to longest. A longer window admits more setups. */
const LOOKBACK_ORDER = ['15m', '1h', '4h', '1D', '1W'] as const;

/**
 * For each numeric parameter: does a larger value make the rule stricter?
 * A longer swing lookback reaches a further extreme, so it is harder to break.
 * A larger minimum gap is harder to clear. More risk and a wider stop are not.
 */
const LARGER_IS_TIGHTER: Record<string, boolean> = {
  swing_lookback: true,
  min_gap_size: true,
  risk_per_trade: false,
  stop_distance: false,
};

function classifyNumeric(path: string, before: number, after: number): ChangeKind {
  const tighterWhenLarger = LARGER_IS_TIGHTER[path] ?? false;
  const grew = after > before;
  return grew === tighterWhenLarger ? 'tighten' : 'loosen';
}

function classifyLookback(before: string, after: string): ChangeKind {
  const b = LOOKBACK_ORDER.indexOf(before as (typeof LOOKBACK_ORDER)[number]);
  const a = LOOKBACK_ORDER.indexOf(after as (typeof LOOKBACK_ORDER)[number]);
  if (b === -1 || a === -1) return 'loosen';
  return a < b ? 'tighten' : 'loosen';
}

/** Flattens a spec to `path -> value` so two versions can be compared field by field. */
function flatten(spec: StrategySpec): Map<string, string> {
  const out = new Map<string, string>();
  const put = (path: string, p: Param<unknown>) => out.set(path, String(p.value));
  for (const p of spec.predicates) {
    const ns = predicateSymbol(p);
    out.set(`${ns}`, 'required');
    switch (p.kind) {
      case 'break_of_structure':
        put(`${ns}.swing_lookback`, p.swingLookbackCandles);
        put(`${ns}.timeframe`, p.timeframe);
        break;
      case 'fair_value_gap':
        put(`${ns}.min_gap_size`, p.minGapBps);
        put(`${ns}.timeframe`, p.timeframe);
        break;
      case 'liquidity_sweep':
        put(`${ns}.sweep_lookback`, p.lookback);
        put(`${ns}.timeframe`, p.timeframe);
        break;
    }
  }
  put('risk_per_trade', spec.risk.riskPerTradeBps);
  put('stop_distance', spec.risk.stopDistanceBps);
  return out;
}

export function diffSpec(before: StrategySpec, after: StrategySpec): SpecDiff {
  const a = flatten(before);
  const b = flatten(after);
  const changes: SpecChange[] = [];

  /** True when the whole predicate went away, so its parameters need no row. */
  const orphaned = (path: string) => {
    const ns = path.includes('.') ? path.slice(0, path.indexOf('.')) : null;
    return ns !== null && a.has(ns) && !b.has(ns);
  };

  for (const [path, from] of a) {
    const to = b.get(path);
    if (to === undefined) {
      // A dropped predicate. Its parameters vanish with it; one row is enough.
      if (!orphaned(path)) {
        changes.push({ path, before: from, after: null, kind: 'remove' });
      }
      continue;
    }
    if (to === from) continue;
    const leaf = path.split('.').pop() ?? path;
    const bothNumeric = /^-?\d+$/.test(from) && /^-?\d+$/.test(to);
    let kind: ChangeKind;
    if (leaf === 'sweep_lookback') kind = classifyLookback(from, to);
    else if (bothNumeric) kind = classifyNumeric(leaf, Number(from), Number(to));
    else kind = 'loosen'; // unorderable: wait it out
    changes.push({ path, before: from, after: to, kind });
  }

  /** Mirror of `orphaned` for a predicate that is entirely new. */
  const fresh = (path: string) => {
    const ns = path.includes('.') ? path.slice(0, path.indexOf('.')) : null;
    return ns !== null && b.has(ns) && !a.has(ns);
  };

  for (const [path, to] of b) {
    if (a.has(path) || fresh(path)) continue;
    changes.push({ path, before: null, after: to, kind: 'add' });
  }

  return {
    changes,
    // Removing a predicate loosens the rule. Adding one tightens it.
    requiresCoolingOff: changes.some((c) => c.kind === 'loosen' || c.kind === 'remove'),
  };
}

/** How long a loosening waits before it applies. Not configurable by design. */
export const COOLING_OFF_SECONDS = 24 * 60 * 60;
