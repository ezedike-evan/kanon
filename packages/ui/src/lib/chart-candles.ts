/**
 * Diffing and patching compact candle arrays. Kept free of imports beyond a
 * type so the chart runtime, which is bundled for the WebView, can use it
 * without pulling in the spec package.
 */
import type { Candle5 } from './chart-protocol';

export type SeriesDiff =
  | { kind: 'reset' }
  | { kind: 'noop' }
  /** Only the tail changed: upsert these, in order. */
  | { kind: 'patch'; candles: Candle5[] };

const sameRow = (a: Candle5, b: Candle5): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4];

/**
 * What the chart needs to go from `prev` to `next`.
 *
 * A live series changes only at its tail (the forming candle moves, a new one
 * opens) and may drop its oldest candles as the read window slides. That is a
 * patch, not a `setData`: re-uploading 2000 candles per tick is the cost this
 * exists to avoid. lightweight-charts can only update the last bar or append a
 * newer one, so anything that touches a candle before the previous last one (a
 * backfill, a filled gap) is a reset.
 */
export function diffCandles(prev: readonly Candle5[] | null, next: readonly Candle5[]): SeriesDiff {
  if (!prev || prev.length === 0 || next.length === 0) return { kind: 'reset' };
  const lastPrev = prev[prev.length - 1]!;

  // Align `next` to `prev` by time; a window that slid left starts later.
  let p = -1;
  {
    let lo = 0;
    let hi = prev.length - 1;
    const target = next[0]![0];
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = prev[mid]![0];
      if (t === target) {
        p = mid;
        break;
      }
      if (t < target) lo = mid + 1;
      else hi = mid - 1;
    }
  }
  if (p === -1) return { kind: 'reset' };

  let i = 0;
  while (i < next.length && p < prev.length - 1) {
    if (!sameRow(next[i]!, prev[p]!)) return { kind: 'reset' };
    i++;
    p++;
  }
  // `next` ended before reaching prev's last candle.
  if (p < prev.length - 1) return { kind: 'reset' };

  const tail = next.slice(i);
  if (tail.length === 0) return { kind: 'reset' };
  if (tail[0]![0] > lastPrev[0]) return { kind: 'reset' };
  if (tail.length === 1 && sameRow(tail[0]!, lastPrev)) return { kind: 'noop' };
  return { kind: 'patch', candles: tail };
}

/**
 * Applies a patch to a compact candle array in place, the way the runtime
 * applies it to the chart: replace the last bar, or append newer ones.
 */
export function applyPatch(rows: Candle5[], patch: readonly Candle5[]): void {
  for (const c of patch) {
    const last = rows[rows.length - 1];
    if (last && last[0] === c[0]) rows[rows.length - 1] = c;
    else if (!last || c[0] > last[0]) rows.push(c);
  }
}
