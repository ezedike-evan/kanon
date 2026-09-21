/**
 * The demo chart. Used only when no live series is available: logged out, or
 * no provider mounted (`demoDataSource` in `./data.tsx`). A signed-in session
 * with a live source never reaches this file, and never falls back to it: an
 * empty live series is shown as empty.
 *
 * It builds a `Series` the way the real pipeline does, raw ticks through
 * `bucketTicks` at the requested bucket width, so the chart is exercised
 * against the exact canonical shape (`packages/spec/src/candle.ts`) it gets in
 * production, gaps included. One tape per asset is re-bucketed per width, so
 * the 1m..1W selector changes real candle sizes here too.
 *
 * The tape gets finer towards the present (see `TIERS`), so 1m and 5m candles
 * are real prints rather than a flat carry-forward, and it ends at the current
 * minute so the bar countdown and "last candle" read as live. The price path is deterministic per asset and per
 * UTC day.
 */

import type { Decimal } from '@kanon/spec';
// See components/chart/scale.ts for why this reaches into spec's source
// directly rather than through `@kanon/spec`'s package entrypoint.
import { bucketTicks, type PriceTick, type Series } from '../../../spec/src/candle';
import type { TradeMarker } from '../components/chart/markers';

interface AssetProfile {
  start: number;
  decimals: number;
  /** Per-step volatility as a fraction of price at the 15 minute cadence. */
  vol: number;
}

const PROFILES: Record<string, AssetProfile> = {
  'BTC/USD': { start: 64_200, decimals: 2, vol: 0.0032 },
  'ETH/USD': { start: 3_410, decimals: 2, vol: 0.0041 },
  'SOL/USD': { start: 162.4, decimals: 3, vol: 0.0054 },
  'MON/USD': { start: 0.0342, decimals: 5, vol: 0.0071 },
  'AVAX/USD': { start: 38.42, decimals: 3, vol: 0.0058 },
};
const DEFAULT_PROFILE = PROFILES['BTC/USD']!;

/**
 * Three tiers, so every timeframe has real prints without a huge tape: hourly
 * far back (1D and 1W), fifteen minutes in the middle (1H and 4H), one minute
 * for the last five days (1m and 5m).
 */
const TIERS = [
  { seconds: 3_600, days: 120, ticks: 3 },
  { seconds: 900, days: 55, ticks: 3 },
  { seconds: 60, days: 5, ticks: 2 },
] as const;
const QUIET = [0.15, 0.15, 0.08] as const;

/** The demo tape ends here: now, to the minute. Fixed at first use so every width agrees. */
const NOW_SECONDS = Math.floor(Date.now() / 1000 / 60) * 60;

/** Deterministic PRNG so the fixture (and any screenshot) is stable. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** `BTC / USD`, `btc/usd` and `BTC/USD` are the same asset. */
function normalize(asset: string): string {
  return asset.replace(/\s+/g, '').toUpperCase();
}

const tapes = new Map<string, PriceTick[]>();

/**
 * A bounded random walk of ticks with a slowly wandering trend, event-driven
 * like the real feed: several ticks in some buckets, none in others (the
 * sparse-series honesty principle docs/ARCHITECTURE.md asks for, exercised
 * here rather than assumed away).
 */
function demoTape(asset: string): PriceTick[] {
  const hit = tapes.get(asset);
  if (hit) return hit;
  const profile = PROFILES[asset] ?? DEFAULT_PROFILE;
  const rand = mulberry32(hashSeed(asset) ^ 20260917);
  const scale = 10 ** profile.decimals;
  const d = (n: number): Decimal => ({ atoms: String(Math.round(n * scale)), decimals: profile.decimals });
  const ticks: PriceTick[] = [];
  const floor = profile.start * 0.05;
  let price = profile.start;
  let trend = 0;

  const step = (weight: number) => {
    trend = trend * 0.96 + (rand() - 0.5) * profile.vol * 0.18 * weight;
    price = Math.max(floor, price * (1 + trend) + (rand() - 0.5) * price * profile.vol * weight);
  };

  // Anchored to the start of the UTC day, not to now: the path is a pure function of
  // absolute time, so a reload within the day redraws the same prices and a drawing
  // restored from storage still sits on the candles it was drawn on.
  let cursor = Math.floor(NOW_SECONDS / 86_400) * 86_400 - TIERS.reduce((sum, t) => sum + t.days, 0) * 86_400;
  TIERS.forEach((tier, index) => {
    // The finest tier runs on to the present.
    const end = index === TIERS.length - 1 ? NOW_SECONDS : cursor + tier.days * 86_400;
    // Volatility scales with the square root of the cadence, relative to 15 minutes.
    const cadence = Math.sqrt(tier.seconds / 900);
    for (let t = cursor; t < end; t += tier.seconds) {
      if (rand() < QUIET[index]!) continue; // a quiet bucket: fillGaps has real gaps to carry across
      const n = 1 + Math.floor(rand() * tier.ticks);
      for (let i = 0; i < n; i++) {
        step(cadence / Math.sqrt(n));
        ticks.push({ timestamp: t + Math.floor((i / n) * tier.seconds), price: d(price) });
      }
    }
    cursor = end;
  });
  // The tape reaches the present, so the last candle is the one forming now.
  step(1);
  ticks.push({ timestamp: NOW_SECONDS, price: d(price) });
  tapes.set(asset, ticks);
  return ticks;
}

const seriesCache = new Map<string, Series>();

/** Candles of this width the tape can supply as real prints: the tiers at least as fine as the width. */
function realCandleLimit(bucketSeconds: number): number {
  const days = TIERS.filter((t) => t.seconds <= bucketSeconds).reduce((sum, t) => sum + t.days, 0);
  return Math.max(1, Math.floor((days * 86_400) / bucketSeconds));
}

/**
 * The demo tape bucketed at `bucketSeconds`, newest `candleCount` candles (fewer
 * where the tape has no real prints that far back). Memoised per asset and width.
 */
export function buildFixtureSeries(
  asset = 'BTC/USD',
  bucketSeconds = 900,
  candleCount = 2400,
): Series {
  const name = normalize(asset);
  const key = `${name}|${bucketSeconds}|${candleCount}`;
  const hit = seriesCache.get(key);
  if (hit) return hit;
  const count = Math.min(candleCount, realCandleLimit(bucketSeconds));
  // Only the ticks that can land in the window: gap-filling across the whole tape would
  // fabricate hundreds of thousands of flat candles at 1m just to throw them away.
  const from = Math.floor(NOW_SECONDS / bucketSeconds) * bucketSeconds - (count - 1) * bucketSeconds;
  const tape = demoTape(name);
  let lo = 0;
  let hi = tape.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tape[mid]!.timestamp < from) lo = mid + 1;
    else hi = mid;
  }
  const full = bucketTicks(tape.slice(lo), { asset: name, bucketSeconds, fillGaps: true });
  const series: Series = { ...full, candles: full.candles.slice(-count) };
  seriesCache.set(key, series);
  return series;
}

/**
 * A few executed and refused trades pinned to real candles of `series`, so the
 * marker layer renders against the exact shape the real trade log will supply.
 * They sit inside the most recent stretch, where the chart opens. Synthetic
 * (gap-filled) candles are skipped: nothing prints there.
 */
export function buildFixtureMarkers(series: Series): TradeMarker[] {
  const real = series.candles.filter((c) => !c.synthetic).slice(-90);
  const plan: Array<[number, TradeMarker['side'], TradeMarker['kind']]> = [
    [0.12, 'long', 'executed'],
    [0.3, 'short', 'blocked'],
    [0.48, 'long', 'blocked'],
    [0.66, 'short', 'executed'],
    [0.86, 'long', 'executed'],
  ];
  return plan.flatMap(([at, side, kind]) => {
    const candle = real[Math.floor(at * real.length)];
    return candle ? [{ timestamp: candle.timestamp, side, kind }] : [];
  });
}
