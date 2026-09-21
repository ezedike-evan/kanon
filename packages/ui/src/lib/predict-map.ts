/**
 * Pure mapping for the Predict tab: Convex rows into what a card renders, the
 * demo fixtures into the same shape, and the text a card is made of.
 *
 * No React and no clock: `nowSeconds` is passed in, so every phase, countdown
 * and sort order is pinned down in `predict-map.test.ts`.
 */

import {
  abbreviateHash,
  distanceBps,
  formatBps,
  formatDecimal,
  isMarketAsset,
  marketPhase,
  type Decimal,
  type MarketDirection,
  type MarketPhase,
  type MarketSide,
  type MarketStatus,
} from '@kanon/spec';
import type { ChainMarketRef } from './market-client';
import type {
  PredictMarket,
  PredictPosition,
  PredictSettlement,
  PredictTerms,
} from './predict-types';

// ---------------------------------------------------------------------------
// Rows, as the Convex queries return them. Restated here: `packages/ui` does
// not depend on the backend.
// ---------------------------------------------------------------------------

export interface MarketRow {
  _id: string;
  asset: string;
  assetClass: string;
  direction: MarketDirection;
  thresholdPrice: Decimal;
  windowStart: number;
  windowEnd: number;
  bucketSeconds: number;
  template: string;
  params: {
    offsetBps: number;
    significantDigits: number;
    windowSeconds: number;
    bucketSeconds: number;
    referencePrice: Decimal;
    referenceAt: number;
    feedId: string;
  };
  termsHash: string;
  status: MarketStatus;
  crossed?: { price: Decimal; at: number } | undefined;
  outcome?: 'hit' | 'miss' | undefined;
  decidingPrice?: Decimal | undefined;
  decidingAt?: number | undefined;
  windowExtreme?: { price: Decimal; at: number } | undefined;
  recordedCandles?: number | undefined;
  evidenceHash?: string | undefined;
  /** Milliseconds, as Convex stores it. */
  settledAt?: number | undefined;
  chain?: ChainMarketRef | undefined;
  latest: { price: Decimal; publishTime: number } | null;
}

export interface PositionRow {
  marketId?: string | undefined;
  side: MarketSide;
  stake?: Decimal | undefined;
  txHash?: string | undefined;
  result?: 'won' | 'lost' | 'refunded' | undefined;
}

// ---------------------------------------------------------------------------
// Rows to markets.
// ---------------------------------------------------------------------------

function settlementOf(row: MarketRow): PredictSettlement | null {
  if (row.status === 'open') return null;
  const outcome = row.status === 'unresolvable' ? 'unresolvable' : (row.outcome ?? null);
  // A settled row with no outcome or no hash is not a result anyone can check. It is not shown as one.
  if (!outcome || !row.evidenceHash) return null;
  return {
    outcome,
    decidingPrice: row.decidingPrice ?? null,
    decidingAt: row.decidingAt ?? null,
    windowExtreme: row.windowExtreme ?? null,
    evidenceHash: row.evidenceHash,
    recordedCandles: row.recordedCandles ?? 0,
    settledAt: row.settledAt !== undefined ? Math.floor(row.settledAt / 1000) : null,
  };
}

function termsOf(row: MarketRow): PredictTerms {
  return {
    offsetBps: row.params.offsetBps,
    distanceBps: distanceBps(row.params.referencePrice, row.thresholdPrice),
    significantDigits: row.params.significantDigits,
    referencePrice: row.params.referencePrice,
    referenceAt: row.params.referenceAt,
    windowSeconds: row.params.windowSeconds,
    bucketSeconds: row.params.bucketSeconds,
    feedId: row.params.feedId,
  };
}

export function marketFromRow(row: MarketRow, positions: readonly PositionRow[]): PredictMarket {
  return {
    id: row._id,
    asset: row.asset,
    assetClass: 'CRYPTO',
    timeframe: row.template,
    direction: row.direction,
    target: row.thresholdPrice,
    price: row.latest?.price ?? null,
    priceAt: row.latest?.publishTime ?? null,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    status: row.status,
    crossed: row.crossed ?? null,
    terms: termsOf(row),
    termsHash: row.termsHash,
    settlement: settlementOf(row),
    positions: positions
      .filter((p) => p.marketId === row._id)
      .map(
        (p): PredictPosition => ({
          side: p.side,
          stake: p.stake ?? null,
          result: p.result ?? null,
          txHash: p.txHash ?? null,
        }),
      ),
    chain: row.chain ?? null,
    demo: false,
  };
}

/** Where a market sits in the feed at `nowSeconds`: live first, then awaiting a result, then resolved. */
function feedRank(m: PredictMarket, nowSeconds: number): number {
  const phase = marketPhase(m, nowSeconds);
  if (phase === 'upcoming' || phase === 'open' || phase === 'crossed') return 0;
  if (phase === 'expired') return 1;
  return 2;
}

/**
 * The feed, from rows. Only assets with a Pyth feed are shown, whatever the
 * backend sent. Live markets come first, soonest to expire first; then markets
 * awaiting a result; then resolved ones, newest first.
 */
export function marketsFromRows(
  rows: readonly MarketRow[],
  positions: readonly PositionRow[],
  nowSeconds: number,
): PredictMarket[] {
  return rows
    .filter((r) => isMarketAsset(r.asset))
    .map((r) => marketFromRow(r, positions))
    .sort((a, b) => {
      const ra = feedRank(a, nowSeconds);
      const rb = feedRank(b, nowSeconds);
      if (ra !== rb) return ra - rb;
      return ra === 0 ? a.windowEnd - b.windowEnd : b.windowEnd - a.windowEnd;
    });
}

// ---------------------------------------------------------------------------
// Demo fixtures.
// ---------------------------------------------------------------------------

export interface DemoCard {
  id: string;
  asset: string;
  timeframe: string;
  /** `mm:ss` or `hh:mm:ss`. */
  expires: string;
  price: Decimal;
  target: Decimal;
  direction: MarketDirection;
  evidenceHash: string;
}

/** `59:00` is 3540, `03:59:00` is 14340. `null` for anything else. */
export function parseClock(text: string): number | null {
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => (/^\d{1,2}$/.test(p) ? Number(p) : Number.NaN));
  if (nums.some(Number.isNaN)) return null;
  const [a = 0, b = 0, c] = nums;
  return c === undefined ? a * 60 + b : a * 3600 + b * 60 + c;
}

/**
 * The demo cards as markets. AVAX is dropped: it has no sponsored feed, so it
 * is not a market even as a fixture. Every demo market is flagged `demo`, and
 * nothing about one can be staked.
 */
export function demoMarkets(cards: readonly DemoCard[], nowSeconds: number): PredictMarket[] {
  return cards
    .filter((c) => isMarketAsset(c.asset))
    .map(
      (c): PredictMarket => ({
        id: `demo-${c.id}`,
        asset: c.asset,
        assetClass: 'CRYPTO',
        timeframe: c.timeframe,
        direction: c.direction,
        target: c.target,
        price: c.price,
        priceAt: nowSeconds,
        windowStart: nowSeconds,
        windowEnd: nowSeconds + (parseClock(c.expires) ?? 3600),
        status: 'open',
        crossed: null,
        terms: null,
        termsHash: c.evidenceHash,
        settlement: null,
        positions: [],
        chain: null,
        demo: true,
      }),
    );
}

// ---------------------------------------------------------------------------
// Text.
// ---------------------------------------------------------------------------

/** `hh:mm:ss`, with a `1D ` prefix from a day up. Zero below zero. */
export function formatCountdown(remainingSeconds: number): string {
  const total = Math.max(0, Math.ceil(remainingSeconds));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return d > 0 ? `${d}D ${clock}` : clock;
}

/** `2026-09-20 14:05:00Z`. UTC, so a card reads the same in every timezone. */
export function formatUtc(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

/** `900` is `15M`, `3600` is `1H`, `86400` is `1D`. */
export function durationLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}D`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}H`;
  if (seconds % 60 === 0) return `${seconds / 60}M`;
  return `${seconds}S`;
}

/** A native-unit amount without the run of trailing zeros an 18-decimal figure carries. */
export function formatAmount(d: Decimal, minDecimals = 2): string {
  let atoms = d.atoms;
  let decimals = d.decimals;
  while (decimals > minDecimals && atoms.endsWith('0')) {
    atoms = atoms.slice(0, -1);
    decimals -= 1;
  }
  return formatDecimal({ atoms, decimals });
}

export const sideLabel = (side: MarketSide): 'UP' | 'DOWN' => (side === 'above' ? 'UP' : 'DOWN');

/** What taking `side` on `market` claims, in the price's own terms. */
export function sideMeaning(market: Pick<PredictMarket, 'direction' | 'target'>, side: MarketSide): string {
  const target = formatDecimal(market.target);
  if (side === market.direction) return `REACHES ${target}`;
  return market.direction === 'above' ? `STAYS BELOW ${target}` : `STAYS ABOVE ${target}`;
}

/** The question a card asks. The threshold is a touch: reaching it counts. */
export function questionOf(market: Pick<PredictMarket, 'direction' | 'target'>): string {
  const arrow = market.direction === 'above' ? '▲' : '▼';
  const word = market.direction === 'above' ? 'AT OR ABOVE' : 'AT OR BELOW';
  return `${arrow} ${word} ${formatDecimal(market.target)}`;
}

export function outcomeHeadline(s: PredictSettlement): string {
  if (s.outcome === 'hit') return 'THRESHOLD TOUCHED';
  if (s.outcome === 'miss') return 'THRESHOLD NOT REACHED';
  return 'NO SAMPLES IN WINDOW';
}

export function positionResultLabel(result: PredictPosition['result']): string {
  if (result === 'won') return 'WON';
  if (result === 'lost') return 'LOST';
  if (result === 'refunded') return 'REFUNDED';
  return 'OPEN';
}

export function phaseLabel(phase: MarketPhase): string {
  switch (phase) {
    case 'upcoming':
      return 'OPENS SOON';
    case 'open':
      return 'OPEN';
    case 'crossed':
      return 'THRESHOLD TOUCHED';
    case 'expired':
      return 'WINDOW ENDED';
    case 'settled':
      return 'SETTLED';
    case 'unresolvable':
      return 'NO RESULT';
  }
}

// ---------------------------------------------------------------------------
// Ladder: where the prices sit against one another. Positions are integer
// permille of the track, computed in BigInt; no price ever passes through a float.
// ---------------------------------------------------------------------------

/**
 * Each price's distance from the top of a track, in permille (0 is the highest
 * price on it, 1000 the lowest edge), padded a quarter of the span on each
 * side so the outermost marks do not sit on the edge. `null` stays `null`.
 * With every price equal, they all sit mid-track.
 */
export function ladderPermille(prices: readonly (Decimal | null)[]): (number | null)[] {
  const present = prices.filter((p): p is Decimal => p !== null);
  if (present.length === 0) return prices.map(() => null);
  const decimals = Math.max(...present.map((p) => p.decimals));
  const atoms = (p: Decimal) => BigInt(p.atoms) * 10n ** BigInt(decimals - p.decimals);
  const values = present.map(atoms);
  let lo = values[0]!;
  let hi = values[0]!;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  if (span === 0n) return prices.map((p) => (p === null ? null : 500));
  const pad = span / 4n;
  const top = hi + pad;
  const total = top - (lo - pad);
  return prices.map((p) => (p === null ? null : Number(((top - atoms(p)) * 1000n) / total)));
}

// ---------------------------------------------------------------------------
// Evidence.
// ---------------------------------------------------------------------------

export interface EvidenceClaimData {
  symbol: string;
  summary: string;
  fields: [string, string][];
  /** Right-edge label on the claim's row; `EvidenceChain` says `SIGNED` when this is absent. */
  badge?: string;
  tone?: 'long' | 'ash';
}

/**
 * The evidence chain for a market, for `EvidenceChain`: the terms it was opened
 * with, what the series did, the result and its hash, and the person's own
 * stakes. Every claim carries the numbers the arithmetic ran on.
 */
export function marketClaims(m: PredictMarket): EvidenceClaimData[] {
  const claims: EvidenceClaimData[] = [];
  const arrow = m.direction === 'above' ? '▲' : '▼';
  const test = m.direction === 'above' ? 'WINDOW HIGH ≥ THRESHOLD' : 'WINDOW LOW ≤ THRESHOLD';

  const termFields: [string, string][] = [
    ['ASSET', m.asset],
    ['QUESTION', test],
    ['THRESHOLD', formatDecimal(m.target)],
  ];
  if (m.terms) {
    termFields.push(
      ['REFERENCE PRICE', formatDecimal(m.terms.referencePrice)],
      ['REFERENCE PRINT', formatUtc(m.terms.referenceAt)],
      ['OFFSET', formatBps(m.terms.distanceBps, { signed: true })],
      ['ROUNDING', `${m.terms.significantDigits} SIG. DIGITS, AWAY FROM PRICE`],
      ['CANDLE', durationLabel(m.terms.bucketSeconds)],
      ['FEED', abbreviateHash(m.terms.feedId)],
    );
  }
  termFields.push(
    ['WINDOW OPENS', formatUtc(m.windowStart)],
    ['WINDOW ENDS', formatUtc(m.windowEnd)],
    ['TERMS HASH', m.termsHash ? abbreviateHash(m.termsHash) : '—'],
  );
  claims.push({
    symbol: m.demo ? 'MARKET TERMS · DEMO' : 'MARKET TERMS',
    summary: `${arrow} ${formatDecimal(m.target)} · ${durationLabel(m.terms?.windowSeconds ?? m.windowEnd - m.windowStart)}`,
    fields: termFields,
    badge: 'TERMS',
    tone: 'ash',
  });

  if (m.crossed && !m.settlement) {
    claims.push({
      symbol: 'THRESHOLD TOUCHED',
      summary: `${formatDecimal(m.crossed.price)} · ${formatUtc(m.crossed.at)}`,
      fields: [
        ['PRICE', formatDecimal(m.crossed.price)],
        ['CANDLE', formatUtc(m.crossed.at)],
        ['FINAL AT', formatUtc(m.windowEnd)],
      ],
      badge: 'RECORDED',
      tone: 'ash',
    });
  }

  const s = m.settlement;
  if (s) {
    const fields: [string, string][] = [['OUTCOME', outcomeHeadline(s)]];
    if (s.decidingPrice) fields.push(['DECIDING PRICE', formatDecimal(s.decidingPrice)]);
    if (s.decidingAt !== null) fields.push(['DECIDING CANDLE', formatUtc(s.decidingAt)]);
    if (s.windowExtreme) {
      fields.push([
        m.direction === 'above' ? 'WINDOW HIGH' : 'WINDOW LOW',
        formatDecimal(s.windowExtreme.price),
      ]);
      fields.push(['REACHED AT', formatUtc(s.windowExtreme.at)]);
    }
    fields.push(['RECORDED CANDLES', String(s.recordedCandles)]);
    fields.push(['EVIDENCE HASH', abbreviateHash(s.evidenceHash)]);
    // The result leads: it is what a settled card's evidence link is for.
    claims.unshift({
      symbol: 'SETTLEMENT',
      summary: s.decidingPrice
        ? `${outcomeHeadline(s)} · ${formatDecimal(s.decidingPrice)}`
        : outcomeHeadline(s),
      fields,
      badge: s.outcome === 'unresolvable' ? 'NO RESULT' : 'SETTLED',
      tone: s.outcome === 'unresolvable' ? 'ash' : 'long',
    });
  }

  for (const p of m.positions) {
    claims.push({
      symbol: `YOUR SIDE · ${sideLabel(p.side)}`,
      summary: `${p.stake ? formatAmount(p.stake) : '—'} · ${positionResultLabel(p.result)}`,
      fields: [
        ['SIDE', `${sideLabel(p.side)} · ${sideMeaning(m, p.side)}`],
        ['STAKE', p.stake ? formatAmount(p.stake) : '—'],
        ['RESULT', positionResultLabel(p.result)],
        ['TRANSACTION', p.txHash ? abbreviateHash(p.txHash) : '—'],
      ],
      badge: 'YOURS',
      tone: 'ash',
    });
  }
  return claims;
}
