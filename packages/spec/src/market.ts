/**
 * The Predict tab's market lifecycle, as arithmetic.
 *
 * A market asks one question of the recorded price series: does it touch a
 * threshold inside a window? This file owns everything about that question
 * that is not I/O: how a threshold is derived from a price, how a window is
 * aligned, what phase a market is in at a given second, what a series says
 * about it once the window is over, and what a side on it means.
 *
 * Settlement is `settleThreshold` in `threshold.ts` and nothing else. This
 * file wraps it in the rules about *when* its answer may be trusted (a window
 * is only final once the series has moved past it) and never computes a hit
 * itself. The backend, the UI and the on-chain `ThresholdMarket` therefore
 * disagree only if the contract does.
 *
 * Three places the spec's honesty matters, stated so nobody has to find them:
 *
 *  - Only recorded samples count. Candles carried forward across an empty
 *    bucket (`synthetic`) are dropped before settling: a price nobody printed
 *    in the window cannot touch a threshold. A window with no recorded sample
 *    at all is `unresolvable`, and stakes are refunded, exactly as the contract
 *    does when `swingHigh`/`swingLow` find nothing.
 *  - The window's last bucket is included, on chain and here. `settleThreshold`
 *    counts a candle whose start is at or before `windowEnd`, so the bucket
 *    that opens at `windowEnd` is in the window. A market is therefore only
 *    final once a sample exists *after* that bucket has closed. Settling
 *    earlier would make the answer depend on when the settler happened to run.
 *  - Touching counts. `high >= threshold` (above) and `low <= threshold`
 *    (below) both hit, as in the contract.
 */

import type { Series } from './candle';
import { maxDecimal, minDecimal } from './candle';
import { Decimal, compareDecimal } from './decimal';
import { fedAssets } from './pyth';
import { settleThreshold } from './threshold';

// ---------------------------------------------------------------------------
// Parameters. Every number that shapes a market is named here and stored on the
// market, so the card can show it. There is no default that is not surfaced.
// ---------------------------------------------------------------------------

export type MarketTemplateId = '1H' | '4H' | '1D';

export interface MarketTemplate {
  id: MarketTemplateId;
  /** How long the window runs, in seconds. A multiple of `bucketSeconds`. */
  windowSeconds: number;
  /** The candle width the market is decided on. */
  bucketSeconds: number;
  /** How far the threshold sits from the reference price, in basis points. */
  offsetBps: number;
}

/**
 * Every template decides on 15-minute candles, the width the deployed
 * `CanonicalSeries` contracts bucket at (`Deploy.s.sol`), so an off-chain
 * result and the on-chain `ThresholdMarket` read the same candles. The chain
 * client refuses to stake on a series bucketed at any other width.
 */
export const MARKET_TEMPLATES: readonly MarketTemplate[] = [
  { id: '1H', windowSeconds: 3_600, bucketSeconds: 900, offsetBps: 50 },
  { id: '4H', windowSeconds: 14_400, bucketSeconds: 900, offsetBps: 100 },
  { id: '1D', windowSeconds: 86_400, bucketSeconds: 900, offsetBps: 200 },
];

export function templateById(id: string): MarketTemplate | undefined {
  return MARKET_TEMPLATES.find((t) => t.id === id);
}

/** Thresholds are rounded to this many significant digits of the reference price. */
export const SIGNIFICANT_DIGITS = 5;

/**
 * The oldest reference price a market may be built from. Pyth's sponsored feeds
 * heartbeat hourly, so a quiet market's newest print is routinely most of an
 * hour old. Two heartbeats is the limit before the feed is considered down.
 */
export const MAX_REFERENCE_AGE_SECONDS = 7_200;

/** A reference print stamped this far in the future is a clock problem, not a price. */
export const MAX_REFERENCE_FUTURE_SKEW_SECONDS = 60;

export type MarketDirection = 'above' | 'below';

/** The two sides a person can take. `above` is UP, `below` is DOWN. */
export type MarketSide = 'above' | 'below';

/** Assets a market may be opened on: listed in `assets.ts` and with a Pyth feed. AVAX is not. */
export function marketAssets(): string[] {
  return fedAssets().map((a) => a.symbol);
}

export function isMarketAsset(symbol: string): boolean {
  return marketAssets().includes(symbol);
}

// ---------------------------------------------------------------------------
// Threshold derivation.
// ---------------------------------------------------------------------------

const BPS = 10_000n;
const MAX_DECIMALS = 18;

/**
 * The threshold `offsetBps` away from `reference`, on the side `direction`
 * names, rounded to `significantDigits` of the reference price.
 *
 * Rounding is always away from the reference (up for `above`, down for
 * `below`), so the threshold is never nearer than the offset the card states.
 * Integer arithmetic throughout: no float ever touches a price.
 *
 * The result carries as few decimals as its precision needs, so a threshold
 * on BTC is `68,750` and not `68,750.00000000`.
 */
export function deriveThreshold(
  reference: Decimal,
  direction: MarketDirection,
  offsetBps: number,
  significantDigits: number = SIGNIFICANT_DIGITS,
): Decimal {
  const atoms = BigInt(reference.atoms);
  if (atoms <= 0n) throw new RangeError('reference price must be positive');
  if (!Number.isInteger(offsetBps) || offsetBps <= 0 || offsetBps >= 10_000) {
    throw new RangeError(`offsetBps must be an integer in 1..9999, got ${offsetBps}`);
  }
  if (!Number.isInteger(significantDigits) || significantDigits < 1 || significantDigits > 17) {
    throw new RangeError(`significantDigits must be an integer in 1..17, got ${significantDigits}`);
  }

  // Decimal place of the reference's first significant digit, then the place
  // the grid ends at. `p` is a count of decimals and may be negative for prices
  // with more integer digits than `significantDigits`.
  const exponent = atoms.toString().length - 1 - reference.decimals;
  const p = Math.min(significantDigits - 1 - exponent, MAX_DECIMALS);
  const outDecimals = Math.max(p, 0);
  const unit = p >= 0 ? 1n : 10n ** BigInt(-p);

  const factor = direction === 'above' ? BPS + BigInt(offsetBps) : BPS - BigInt(offsetBps);
  const numerator = atoms * factor * 10n ** BigInt(outDecimals);
  const denominator = BPS * 10n ** BigInt(reference.decimals) * unit;

  const floor = numerator / denominator;
  const quotient = direction === 'above' && numerator % denominator !== 0n ? floor + 1n : floor;
  const out = quotient * unit;
  if (out <= 0n) throw new RangeError('threshold rounded to zero: reference price is too small');
  return { atoms: out.toString(), decimals: outDecimals };
}

function align(a: Decimal, b: Decimal): [bigint, bigint] {
  const decimals = Math.max(a.decimals, b.decimals);
  const scale = (d: Decimal) => BigInt(d.atoms) * 10n ** BigInt(decimals - d.decimals);
  return [scale(a), scale(b)];
}

/**
 * How far `threshold` sits from `reference`, in whole basis points, signed and
 * truncated toward zero. Positive when the threshold is above the reference.
 */
export function distanceBps(reference: Decimal, threshold: Decimal): number {
  const [r, t] = align(reference, threshold);
  if (r <= 0n) throw new RangeError('reference price must be positive');
  return Number(((t - r) * BPS) / r);
}

/**
 * The same value at `decimals` places, or `null` when that would drop a
 * non-zero digit. Used to hand a threshold to a contract in its own units:
 * a contract must never receive a rounded number the card did not show.
 */
export function rescaleExact(d: Decimal, decimals: number): Decimal | null {
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  const atoms = BigInt(d.atoms);
  if (decimals >= d.decimals) {
    return { atoms: (atoms * 10n ** BigInt(decimals - d.decimals)).toString(), decimals };
  }
  const drop = 10n ** BigInt(d.decimals - decimals);
  if (atoms % drop !== 0n) return null;
  return { atoms: (atoms / drop).toString(), decimals };
}

// ---------------------------------------------------------------------------
// Windows and generation.
// ---------------------------------------------------------------------------

/**
 * The window a market opened at `nowSeconds` covers.
 *
 * It starts on the first bucket boundary strictly after `now`, so every
 * candle in the window is made only of prints that happened after the market
 * existed: a print at or before `now` (the reference itself included) can never
 * be what decides it. A bucket that opened before the market was created is
 * never allowed to count.
 */
export function alignWindow(
  nowSeconds: number,
  template: Pick<MarketTemplate, 'windowSeconds' | 'bucketSeconds'>,
): { windowStart: number; windowEnd: number } {
  const windowStart = (Math.floor(nowSeconds / template.bucketSeconds) + 1) * template.bucketSeconds;
  return { windowStart, windowEnd: windowStart + template.windowSeconds };
}

export interface ReferenceTick {
  price: Decimal;
  /** Pyth publish time, unix seconds. */
  publishTime: number;
  feedId: string;
}

export interface MarketParams {
  template: MarketTemplateId;
  offsetBps: number;
  significantDigits: number;
  windowSeconds: number;
  bucketSeconds: number;
  referencePrice: Decimal;
  referenceAt: number;
  maxReferenceAgeSeconds: number;
  feedId: string;
}

export interface MarketTerms {
  asset: string;
  direction: MarketDirection;
  thresholdPrice: Decimal;
  windowStart: number;
  windowEnd: number;
  bucketSeconds: number;
}

export interface NewMarket extends MarketTerms {
  template: MarketTemplateId;
  params: MarketParams;
}

export function isReferenceFresh(
  referenceAt: number,
  nowSeconds: number,
  maxAgeSeconds: number = MAX_REFERENCE_AGE_SECONDS,
): boolean {
  if (referenceAt > nowSeconds + MAX_REFERENCE_FUTURE_SKEW_SECONDS) return false;
  return nowSeconds - referenceAt <= maxAgeSeconds;
}

export type BuildMarketResult =
  | { ok: true; market: NewMarket }
  | { ok: false; reason: 'unsupported_asset' | 'stale_reference' | 'bad_reference' };

/**
 * A market on `asset`, from the latest recorded print. Refuses, with a reason,
 * rather than building from a stale or missing price or on an asset without a
 * sponsored feed.
 */
export function buildMarket(input: {
  asset: string;
  direction: MarketDirection;
  template: MarketTemplate;
  reference: ReferenceTick;
  nowSeconds: number;
}): BuildMarketResult {
  const { asset, direction, template, reference, nowSeconds } = input;
  if (!isMarketAsset(asset)) return { ok: false, reason: 'unsupported_asset' };
  if (!isReferenceFresh(reference.publishTime, nowSeconds)) {
    return { ok: false, reason: 'stale_reference' };
  }

  let thresholdPrice: Decimal;
  try {
    thresholdPrice = deriveThreshold(reference.price, direction, template.offsetBps);
  } catch {
    return { ok: false, reason: 'bad_reference' };
  }

  const { windowStart, windowEnd } = alignWindow(nowSeconds, template);
  return {
    ok: true,
    market: {
      asset,
      direction,
      thresholdPrice,
      windowStart,
      windowEnd,
      bucketSeconds: template.bucketSeconds,
      template: template.id,
      params: {
        template: template.id,
        offsetBps: template.offsetBps,
        significantDigits: SIGNIFICANT_DIGITS,
        windowSeconds: template.windowSeconds,
        bucketSeconds: template.bucketSeconds,
        referencePrice: reference.price,
        referenceAt: reference.publishTime,
        maxReferenceAgeSeconds: MAX_REFERENCE_AGE_SECONDS,
        feedId: reference.feedId,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Phase.
// ---------------------------------------------------------------------------

export type MarketStatus = 'open' | 'settled' | 'unresolvable';

export type MarketPhase =
  /** Created, the window has not begun. Sides can be taken. */
  | 'upcoming'
  /** The window is running. Sides can be taken. */
  | 'open'
  /** The window is running and the recorded series has already touched the threshold. Closed to new sides. */
  | 'crossed'
  /** The window is over and no result is recorded yet. */
  | 'expired'
  | 'settled'
  | 'unresolvable';

/**
 * The phase at `nowSeconds`. The window closes to new sides at `windowEnd`
 * exactly: the contract's `takeSide` reverts once `block.timestamp >=
 * windowEnd`, and this agrees to the second.
 */
export function marketPhase(
  market: {
    status: MarketStatus;
    windowStart: number;
    windowEnd: number;
    crossed?: unknown | undefined;
  },
  nowSeconds: number,
): MarketPhase {
  if (market.status === 'settled') return 'settled';
  if (market.status === 'unresolvable') return 'unresolvable';
  if (nowSeconds >= market.windowEnd) return 'expired';
  if (market.crossed) return 'crossed';
  if (nowSeconds < market.windowStart) return 'upcoming';
  return 'open';
}

export function canTakeSide(phase: MarketPhase): boolean {
  return phase === 'upcoming' || phase === 'open';
}

// ---------------------------------------------------------------------------
// Sides.
// ---------------------------------------------------------------------------

/**
 * Whether taking `side` is a stake on the market's condition happening. On an
 * `above` market UP is the condition (price reaches the threshold) and DOWN is
 * its negation; on a `below` market it is the other way round. This is the
 * `takesAboveSide` flag the contract's `takeSide` takes, named for the price
 * side a person is on instead of for a boolean.
 */
export function sideTakesYes(direction: MarketDirection, side: MarketSide): boolean {
  return side === direction;
}

export type PositionResult = 'won' | 'lost' | 'refunded';

/** Won iff the side's claim matched what the series did. Never called for an unresolvable market. */
export function positionResult(
  direction: MarketDirection,
  side: MarketSide,
  hit: boolean,
): 'won' | 'lost' {
  return sideTakesYes(direction, side) === hit ? 'won' : 'lost';
}

/** What a market's result is worth to a stake: an unresolvable market refunds both sides. */
export function resultForSide(
  direction: MarketDirection,
  side: MarketSide,
  resolution: { kind: 'settled'; hit: boolean } | { kind: 'unresolvable' },
): PositionResult {
  return resolution.kind === 'unresolvable'
    ? 'refunded'
    : positionResult(direction, side, resolution.hit);
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

export interface WindowExtreme {
  price: Decimal;
  /** Start of the candle that printed it, unix seconds. */
  at: number;
}

export type MarketResolution =
  /** Window still running, nothing touched. */
  | { kind: 'open' }
  /** Window still running, and the threshold has already been touched. Final at `windowEnd`. */
  | { kind: 'crossed'; decidingPrice: Decimal; decidingAt: number }
  /** Window over, but the series has not yet moved past its last bucket. Try again later. */
  | { kind: 'awaiting' }
  | {
      kind: 'settled';
      hit: boolean;
      /** `settleThreshold`'s deciding price. Present only on a hit. */
      decidingPrice?: Decimal;
      decidingAt?: number;
      /**
       * The window's own high (`above`) or low (`below`): how close a miss came.
       * Evidence only. It plays no part in deciding anything.
       */
      windowExtreme: WindowExtreme;
      recordedCandles: number;
    }
  /** Window over, series moved past it, and not one sample was recorded inside. Stakes are refunded. */
  | { kind: 'unresolvable' };

/** Only recorded samples: a candle carried forward over an empty bucket is dropped. */
export function recordedOnly(series: Series): Series {
  return { ...series, candles: series.candles.filter((c) => !c.synthetic) };
}

export function windowExtreme(series: Series, terms: MarketTerms): WindowExtreme | null {
  const inWindow = series.candles.filter(
    (c) => !c.synthetic && c.timestamp >= terms.windowStart && c.timestamp <= terms.windowEnd,
  );
  if (inWindow.length === 0) return null;
  const pick =
    terms.direction === 'above'
      ? maxDecimal(inWindow.map((c) => c.high))
      : minDecimal(inWindow.map((c) => c.low));
  const candle = inWindow.find((c) =>
    compareDecimal(terms.direction === 'above' ? c.high : c.low, pick) === 0,
  );
  return { price: pick, at: candle?.timestamp ?? terms.windowStart };
}

/**
 * What the recorded series says about a market at `nowSeconds`. Pure: give it
 * the same series and it gives the same answer whenever it runs, which is what
 * lets a settlement be re-derived from the evidence.
 *
 * The decision itself is `settleThreshold`'s. This function only decides
 * whether that answer may be acted on yet.
 */
export function resolveMarket(
  series: Series,
  terms: MarketTerms,
  nowSeconds: number,
): MarketResolution {
  const recorded = recordedOnly(series);
  const decision = settleThreshold(recorded, {
    asset: terms.asset,
    direction: terms.direction,
    thresholdPrice: terms.thresholdPrice,
    windowStart: terms.windowStart,
    windowEnd: terms.windowEnd,
  });

  // The window is still running (or ending this very second): nothing is final.
  if (nowSeconds <= terms.windowEnd) {
    return decision.hit && decision.decidingPrice && decision.decidingAt !== undefined
      ? { kind: 'crossed', decidingPrice: decision.decidingPrice, decidingAt: decision.decidingAt }
      : { kind: 'open' };
  }

  // The last bucket opens at `windowEnd` and is part of the window. It is only
  // complete once a sample exists in a later bucket.
  const closed = recorded.candles.some((c) => c.timestamp >= terms.windowEnd + terms.bucketSeconds);
  if (!closed || !decision.settled) return { kind: 'awaiting' };

  const extreme = windowExtreme(recorded, terms);
  if (!extreme) return { kind: 'unresolvable' };

  const recordedCandles = recorded.candles.filter(
    (c) => c.timestamp >= terms.windowStart && c.timestamp <= terms.windowEnd,
  ).length;

  return {
    kind: 'settled',
    hit: decision.hit,
    ...(decision.decidingPrice ? { decidingPrice: decision.decidingPrice } : {}),
    ...(decision.decidingAt !== undefined ? { decidingAt: decision.decidingAt } : {}),
    windowExtreme: extreme,
    recordedCandles,
  };
}

// ---------------------------------------------------------------------------
// Evidence.
// ---------------------------------------------------------------------------

export interface SettlementEvidence extends MarketTerms {
  outcome: 'hit' | 'miss' | 'unresolvable';
  decidingPrice?: Decimal | undefined;
  decidingAt?: number | undefined;
  windowExtreme?: WindowExtreme | undefined;
  recordedCandles: number;
}

const dec = (d: Decimal | undefined) => (d ? `${d.atoms}@${d.decimals}` : '-');

/**
 * The exact text a settlement hash commits to. One field per line in a fixed
 * order, so anyone holding the stored fields can rebuild it byte for byte.
 */
export function evidencePreimage(e: SettlementEvidence): string {
  return [
    'kanon.threshold-market.settlement.v1',
    `asset=${e.asset}`,
    `direction=${e.direction}`,
    `threshold=${dec(e.thresholdPrice)}`,
    `windowStart=${e.windowStart}`,
    `windowEnd=${e.windowEnd}`,
    `bucketSeconds=${e.bucketSeconds}`,
    `outcome=${e.outcome}`,
    `decidingPrice=${dec(e.decidingPrice)}`,
    `decidingAt=${e.decidingAt ?? '-'}`,
    `extremePrice=${dec(e.windowExtreme?.price)}`,
    `extremeAt=${e.windowExtreme?.at ?? '-'}`,
    `recordedCandles=${e.recordedCandles}`,
  ].join('\n');
}

/** The market as it was created: what a person agreed to when they took a side. */
export function termsPreimage(m: NewMarket): string {
  return [
    'kanon.threshold-market.terms.v1',
    `asset=${m.asset}`,
    `direction=${m.direction}`,
    `threshold=${dec(m.thresholdPrice)}`,
    `windowStart=${m.windowStart}`,
    `windowEnd=${m.windowEnd}`,
    `bucketSeconds=${m.bucketSeconds}`,
    `template=${m.template}`,
    `offsetBps=${m.params.offsetBps}`,
    `significantDigits=${m.params.significantDigits}`,
    `referencePrice=${dec(m.params.referencePrice)}`,
    `referenceAt=${m.params.referenceAt}`,
    `maxReferenceAgeSeconds=${m.params.maxReferenceAgeSeconds}`,
    `feedId=${m.params.feedId}`,
  ].join('\n');
}

/** sha-256 over `text`, as `0x…`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `0x${hex}`;
}

export const hashSettlementEvidence = (e: SettlementEvidence) => sha256Hex(evidencePreimage(e));
export const hashMarketTerms = (m: NewMarket) => sha256Hex(termsPreimage(m));

/** The evidence a resolved market commits to. `awaiting`, `open` and `crossed` have none: they are not final. */
export function evidenceFor(
  terms: MarketTerms,
  resolution: Extract<MarketResolution, { kind: 'settled' | 'unresolvable' }>,
): SettlementEvidence {
  if (resolution.kind === 'unresolvable') {
    return { ...terms, outcome: 'unresolvable', recordedCandles: 0 };
  }
  return {
    ...terms,
    outcome: resolution.hit ? 'hit' : 'miss',
    decidingPrice: resolution.decidingPrice,
    decidingAt: resolution.decidingAt,
    windowExtreme: resolution.windowExtreme,
    recordedCandles: resolution.recordedCandles,
  };
}
