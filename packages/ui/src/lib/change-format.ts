import { formatBps, type ChangeKind } from '@kanon/spec';

/** Parameters the spec holds as integer basis points and every screen writes as a percentage. */
const BPS_LEAVES = new Set(['min_gap_size', 'risk_per_trade', 'stop_distance']);

/**
 * One side of a spec diff row, in the units the review screen writes it in.
 * A parameter added or removed has no value on the other side: that is `—`, not `0`.
 */
export function formatChangeValue(path: string, value: string | null): string {
  if (value === null) return '—';
  const leaf = path.split('.').pop() ?? path;
  if (BPS_LEAVES.has(leaf) && /^-?\d+$/.test(value)) return formatBps(Number(value));
  if (leaf === 'swing_lookback' && /^\d+$/.test(value)) return `${value} candles`;
  return value;
}

export const CHANGE_TAG: Record<ChangeKind, string> = {
  tighten: 'TIGHTENS',
  loosen: 'LOOSENS',
  add: 'ADDED',
  remove: 'REMOVED',
};
