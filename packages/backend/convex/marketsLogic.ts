/**
 * The pure half of the market lifecycle: which markets to open, what series a
 * market is decided on, and what a resolution writes back. No `ctx`, no clock,
 * no I/O. `markets.ts` supplies those and calls in here, so every rule below is
 * pinned down in `marketsLogic.test.ts`.
 *
 * The arithmetic (thresholds, phases, resolution) lives in `@kanon/spec`'s
 * `market.ts`, where the UI reads the same functions. This file is only the
 * backend's bookkeeping around it.
 */

import {
  MARKET_TEMPLATES,
  bucketTicks,
  buildMarket,
  marketAssets,
  type Decimal,
  type MarketDirection,
  type MarketResolution,
  type MarketTemplate,
  type NewMarket,
  type ReferenceTick,
  type Series,
  type WindowExtreme,
} from '@kanon/spec';

/** One rolling stream of markets: an asset, a window length, a direction. Each has at most one live market. */
export function streamKey(asset: string, template: string, direction: MarketDirection): string {
  return `${asset}|${template}|${direction}`;
}

export const DIRECTIONS: readonly MarketDirection[] = ['above', 'below'];

/**
 * A stream is live while its newest market's window has not ended. The moment
 * it has, a fresh market opens on the same stream and the old one waits to be
 * settled: there is never a gap, and never two open windows on one stream.
 */
export function isStreamLive(head: { windowEnd: number } | null | undefined, nowSeconds: number): boolean {
  return Boolean(head) && head!.windowEnd > nowSeconds;
}

export type SkipReason = 'no_reference' | 'stale_reference' | 'bad_reference' | 'unsupported_asset';

export interface MarketPlan {
  toOpen: NewMarket[];
  skipped: { asset: string; template: string; direction: MarketDirection; reason: SkipReason }[];
}

/**
 * The markets to open now: one per stream that is not live, from the asset's
 * latest recorded print. An asset with no print, or only a stale one, gets no
 * market and says why, rather than a market built from a price nobody can vouch
 * for. AVAX and anything else without a Pyth feed never appears.
 *
 * `live` holds the `streamKey`s that already have a running window.
 */
export function planNewMarkets(input: {
  nowSeconds: number;
  latest: Readonly<Record<string, ReferenceTick | null | undefined>>;
  live: ReadonlySet<string>;
  templates?: readonly MarketTemplate[];
  assets?: readonly string[];
}): MarketPlan {
  const { nowSeconds, latest, live } = input;
  const templates = input.templates ?? MARKET_TEMPLATES;
  const assets = input.assets ?? marketAssets();
  const toOpen: NewMarket[] = [];
  const skipped: MarketPlan['skipped'] = [];

  for (const asset of assets) {
    const reference = latest[asset];
    for (const template of templates) {
      for (const direction of DIRECTIONS) {
        if (live.has(streamKey(asset, template.id, direction))) continue;
        if (!reference) {
          skipped.push({ asset, template: template.id, direction, reason: 'no_reference' });
          continue;
        }
        const built = buildMarket({ asset, direction, template, reference, nowSeconds });
        if (built.ok) toOpen.push(built.market);
        else skipped.push({ asset, template: template.id, direction, reason: built.reason });
      }
    }
  }
  return { toOpen, skipped };
}

export interface StoredTick {
  price: Decimal;
  publishTime: number;
}

/**
 * The half-open range of tick times a market is decided on: from its window's
 * start up to, not including, the first bucket after the window. The window's
 * last bucket opens at `windowEnd` and is part of it.
 */
export function windowReadRange(m: { windowStart: number; windowEnd: number; bucketSeconds: number }): {
  from: number;
  to: number;
} {
  return { from: m.windowStart, to: m.windowEnd + m.bucketSeconds };
}

/** One market's tick read, as the sweep decides on it. */
export interface WindowRead {
  ticks: StoredTick[];
  closing: StoredTick | null;
  truncated: boolean;
}

/**
 * The union of several windows on one asset: the read that covers all of them
 * once, instead of one read per market.
 */
export function unionRange(ranges: readonly { from: number; to: number }[]): { from: number; to: number } | null {
  if (ranges.length === 0) return null;
  return {
    from: Math.min(...ranges.map((r) => r.from)),
    to: Math.max(...ranges.map((r) => r.to)),
  };
}

/**
 * Cuts one market's read out of a read that covered a union of windows.
 *
 * `union` holds every recorded tick in `[unionRange.from, unionRange.to)`,
 * ascending, and `afterUnion` is the first tick at or after `unionRange.to`.
 * The result is exactly what a read of `[from, to)` alone would have returned:
 * the same ticks, the same first tick at or after `to` (which is inside the
 * union read when the union runs past `to`, and `afterUnion` otherwise), and
 * `truncated` on the same rule (`maxTicks` ticks in this window's own range),
 * so a settlement does not depend on whether markets were read together.
 */
export function sliceWindowRead(input: {
  union: readonly StoredTick[];
  afterUnion: StoredTick | null;
  range: { from: number; to: number };
  maxTicks: number;
}): WindowRead {
  const { union, afterUnion, range, maxTicks } = input;
  const inside = union.filter((t) => t.publishTime >= range.from && t.publishTime < range.to);
  const closing = union.find((t) => t.publishTime >= range.to) ?? afterUnion;
  return {
    ticks: inside.slice(0, maxTicks),
    closing: closing ?? null,
    truncated: inside.length > maxTicks,
  };
}

/**
 * The series a market is decided on. Recorded samples only: `fillGaps` is off,
 * so an empty bucket is absent rather than carried forward.
 *
 * `closingTick` is the first print at or after the end of the window's last
 * bucket. It is not part of the window; its presence is what says the last
 * bucket is complete, which `resolveMarket` requires before it will settle.
 * Ticks outside the window range are ignored rather than trusted to be sorted
 * or pre-filtered.
 */
export function seriesForMarket(input: {
  asset: string;
  window: { windowStart: number; windowEnd: number; bucketSeconds: number };
  windowTicks: readonly StoredTick[];
  closingTick?: StoredTick | null | undefined;
}): Series {
  const { from, to } = windowReadRange(input.window);
  const ticks = input.windowTicks
    .filter((t) => t.publishTime >= from && t.publishTime < to)
    .map((t) => ({ timestamp: t.publishTime, price: t.price }));
  if (input.closingTick && input.closingTick.publishTime >= to) {
    ticks.push({ timestamp: input.closingTick.publishTime, price: input.closingTick.price });
  }
  return bucketTicks(ticks, {
    asset: input.asset,
    bucketSeconds: input.window.bucketSeconds,
    fillGaps: false,
  });
}

export interface SettlementFields {
  status: 'settled' | 'unresolvable';
  outcome?: 'hit' | 'miss';
  decidingPrice?: Decimal;
  decidingAt?: number;
  windowExtreme?: WindowExtreme;
  recordedCandles: number;
}

/** What a final resolution writes onto the market. `null` for a resolution that is not final. */
export function settlementFields(resolution: MarketResolution): SettlementFields | null {
  if (resolution.kind === 'unresolvable') return { status: 'unresolvable', recordedCandles: 0 };
  if (resolution.kind !== 'settled') return null;
  return {
    status: 'settled',
    outcome: resolution.hit ? 'hit' : 'miss',
    ...(resolution.decidingPrice ? { decidingPrice: resolution.decidingPrice } : {}),
    ...(resolution.decidingAt !== undefined ? { decidingAt: resolution.decidingAt } : {}),
    windowExtreme: resolution.windowExtreme,
    recordedCandles: resolution.recordedCandles,
  };
}

/** How many stakes one settlement mutation writes, so a busy market never exceeds a transaction's limits. */
export const SETTLE_POSITIONS_BATCH = 256;
/** How many settlement mutations one sweep runs for a single market before leaving the rest to the next. */
export const SETTLE_POSITIONS_MAX_ROUNDS = 40;

/** Markets read per sweep. A backlog beyond this waits for the next minute. */
export const SWEEP_MARKET_LIMIT = 200;

/** How many open markets and how many recent results the feed returns. */
export const FEED_OPEN_LIMIT = 60;
export const FEED_SETTLED_LIMIT = 12;

/** A stake must be positive and within the chain's 18 decimals. */
export function isValidStake(stake: Decimal): boolean {
  if (!/^\d+$/.test(stake.atoms)) return false;
  if (!Number.isInteger(stake.decimals) || stake.decimals < 0 || stake.decimals > 18) return false;
  return BigInt(stake.atoms) > 0n;
}
