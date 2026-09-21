/**
 * Geometry for the big price line on a reel page.
 *
 * Display only. The line is drawn from recorded candle closes and nothing here
 * is fed back into settlement: the result of a market is `settleThreshold` in
 * `@kanon/spec` and never a number this file produced. The float boundary is
 * the same one `chart-series.ts` draws.
 */

import type { Series } from '@kanon/spec';
import { decimalToNumber } from './chart-series';

/** The most points a page draws. More than this is not visible on a phone-width line. */
export const MAX_POINTS = 90;

/**
 * Candles a page shows: about three windows of history, so a market's level is
 * read against a stretch several times its own length. Bounded so a 15-minute
 * market is not a two-hour blip and a one-day market is not a month.
 */
export function candleCountFor(windowSeconds: number, bucketSeconds: number): number {
  const wanted = Math.round((windowSeconds * 3) / Math.max(1, bucketSeconds));
  return Math.min(MAX_POINTS, Math.max(32, wanted));
}

/** The closes of the last `count` candles, as numbers for drawing. */
export function closesOf(series: Series, count: number): number[] {
  const candles = series.candles.slice(-count);
  return candles.map((c) => decimalToNumber(c.close)).filter((n) => Number.isFinite(n));
}

/** At most `max` points, keeping the first and the last, so the line still ends on the live price. */
export function downsample(values: readonly number[], max = MAX_POINTS): number[] {
  if (values.length <= max) return [...values];
  const out: number[] = [];
  const step = (values.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(values[Math.round(i * step)]!);
  return out;
}

export interface ChartGeometry {
  /** A smoothed SVG path through every point. */
  line: string;
  /** The same path closed down to the floor, for the wash beneath. */
  area: string;
  /** Height of the level's line, in px from the top. */
  targetY: number;
  /** Where the line ends, and the live price's dot goes. */
  end: { x: number; y: number } | null;
  /** The price range the box maps to. */
  min: number;
  max: number;
}

export interface ChartBox {
  /** The full width of the box. */
  width: number;
  height: number;
  /** The line's last point sits here: the rest of the width is left for the rail. */
  plotRight: number;
  padTop?: number;
  padBottom?: number;
}

const r = (n: number) => Math.round(n * 10) / 10;

/**
 * Fits the closes, the level and the live price into one box, so the dashed
 * level is always on screen and the distance to it is honest: both use the same
 * scale. A flat series draws a centred line, not a divide-by-zero.
 */
export function chartGeometry(
  closes: readonly number[],
  target: number,
  price: number | null,
  box: ChartBox,
): ChartGeometry | null {
  const { width, height, plotRight } = box;
  const padTop = box.padTop ?? 24;
  const padBottom = box.padBottom ?? 24;
  if (!(width > 0) || !(height > 0) || !Number.isFinite(target)) return null;

  const series = price !== null && Number.isFinite(price) ? [...closes, price] : [...closes];
  const values = downsample(series);
  const all = [...values, target];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi === lo) {
    // Nothing to scale against: give the box a band a quarter of a percent either side.
    const half = Math.abs(hi) * 0.0025 || 1;
    lo -= half;
    hi += half;
  }
  const inner = height - padTop - padBottom;
  const yOf = (v: number) => r(padTop + (1 - (v - lo) / (hi - lo)) * inner);
  const targetY = yOf(target);

  if (values.length < 2) return { line: '', area: '', targetY, end: null, min: lo, max: hi };

  const pts = values.map((v, i) => ({ x: r((i / (values.length - 1)) * plotRight), y: yOf(v) }));
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  // Quadratic through the midpoints: smooth, and it never overshoots a point the way a spline can.
  let line = `M${first.x} ${first.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const n = pts[i + 1]!;
    line += ` Q${p.x} ${p.y} ${r((p.x + n.x) / 2)} ${r((p.y + n.y) / 2)}`;
  }
  line += ` L${last.x} ${last.y}`;
  const area = `${line} L${last.x} ${height} L${first.x} ${height} Z`;
  return { line, area, targetY, end: last, min: lo, max: hi };
}
