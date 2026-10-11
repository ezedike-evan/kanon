import type { Decimal } from '@kanon/spec';
import { normalizeSymbol } from './chart-assets';
import { displayDecimals, formatAtoms } from './chart-format';
import type { VenuePositionView, VenueSide } from './venue-types';

/**
 * The pure half of the Perpl risk screen: what the venue's public market data
 * and the account's positions say about risk, worked out on integers. No React,
 * no I/O and no clock of its own (a caller passes `nowMs`), so every rule here
 * is pinned down in `perpl-risk.test.ts`.
 *
 * Two inputs, both the venue's own. `/v1/pub/context` lists each market with its
 * margin terms, its funding and a snapshot of its state; `/v1/market-data/ticker`
 * is the same state, fresher. Their shapes are Perpl's (`types.md` in
 * PerplFoundation/api-docs): prices and sizes are integers at the market's own
 * decimals, an amount is AUSD atoms at six, a funding rate and a fee are
 * millionths, and a margin term is a multiple in hundredths (2500 is 25x, which
 * is a 4% maintenance margin).
 *
 * The liquidation price is Perpl's published formula, not a guess at one:
 *
 *     P_liq = P_entry + s * (P_entry * L / MMF - C_deposit - C_funding) / L
 *
 * with `s` +1 for a long and -1 for a short, `L` the size and `MMF` the
 * maintenance multiple. A position's accrued funding is not in the snapshot this
 * reads, so it is left out and every screen that shows the figure says "before
 * funding".
 *
 * Nothing here is a profit or a loss. Risk is said as a price and a distance.
 */

/** AUSD's decimals: what an amount, a collateral and a volume are stated in. */
const AMOUNT_DECIMALS = 6;
const MILLION = 1_000_000;
const SECONDS_PER_YEAR = 31_536_000;

// --- What the venue sends -----------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isCount = (v: unknown): v is number => isInt(v) && v >= 0;
/** An amount arrives as a decimal string, or as a number when it is small. */
const amountOf = (v: unknown): string | null =>
  typeof v === 'string' && /^\d+$/.test(v) ? v : isCount(v) ? String(v) : null;

/** One market's state: the fields of Perpl's `MarketState` this screen reads. */
export interface RiskState {
  /** Milliseconds the venue stamped it. */
  at: number;
  oracle: number;
  mark: number;
  bid: number;
  ask: number;
  /** The price a day ago. Zero when the venue has none. */
  prev: number;
  /** Open interest, a size. */
  openInterest: number;
  /** A day's volume, AUSD atoms. */
  volume: string;
}

function readState(v: unknown): RiskState | null {
  if (!isRecord(v) || !isRecord(v.at) || !isCount(v.at.t)) return null;
  if (!isCount(v.orl) || !isCount(v.mrk) || !isCount(v.bid) || !isCount(v.ask)) return null;
  return {
    at: v.at.t,
    oracle: v.orl,
    mark: v.mrk,
    bid: v.bid,
    ask: v.ask,
    prev: isCount(v.prv) ? v.prv : 0,
    openInterest: isCount(v.oi) ? v.oi : 0,
    volume: amountOf(v.dva) ?? '0',
  };
}

/** One market as the context lists it: its terms, its funding, and a state that a ticker may replace. */
export interface RiskMarketTerms {
  id: number;
  /** `BTC`. */
  symbol: string;
  open: boolean;
  priceDecimals: number;
  sizeDecimals: number;
  /** A multiple in hundredths: 2500 keeps 1/25 of the position's entry value as margin. */
  maintenance: number;
  /** A multiple in hundredths: 1500 is the highest leverage, 15x. */
  initial: number;
  /** Millionths of the order's value. */
  takerFee: number;
  makerFee: number;
  /** Seconds between funding events. */
  fundingInterval: number;
  /** Millionths of the position's value per funding event, signed. Positive: longs pay shorts. */
  fundingRate: number;
  state: RiskState | null;
}

/**
 * `/v1/pub/context` as the markets this screen can draw. A market missing a
 * term it cannot be drawn without is left out, not guessed at; a body that is
 * not a context at all is null.
 */
export function readContext(body: unknown): RiskMarketTerms[] | null {
  if (!isRecord(body) || !Array.isArray(body.markets)) return null;
  const out: RiskMarketTerms[] = [];
  for (const m of body.markets) {
    if (!isRecord(m) || !isCount(m.id) || typeof m.symbol !== 'string' || m.symbol.trim() === '') continue;
    const c = m.config;
    if (!isRecord(c) || !isCount(c.price_decimals) || !isCount(c.size_decimals)) continue;
    if (!isCount(c.maintenance_margin) || c.maintenance_margin === 0 || !isCount(c.initial_margin)) continue;
    const funding = isRecord(m.funding) && isInt(m.funding.rate) ? m.funding.rate : 0;
    out.push({
      id: m.id,
      symbol: m.symbol.trim().toUpperCase(),
      open: c.is_open === true,
      priceDecimals: c.price_decimals,
      sizeDecimals: c.size_decimals,
      maintenance: c.maintenance_margin,
      initial: c.initial_margin,
      takerFee: isInt(c.taker_fee) ? c.taker_fee : 0,
      makerFee: isInt(c.maker_fee) ? c.maker_fee : 0,
      fundingInterval: isCount(m.funding_interval_sec) ? m.funding_interval_sec : 0,
      fundingRate: funding,
      state: readState(m.state),
    });
  }
  return out;
}

/** `/v1/market-data/ticker` as states by market id. Null when the body is not a ticker. */
export function readTickers(body: unknown): Map<number, RiskState> | null {
  if (!isRecord(body) || !isRecord(body.d)) return null;
  const out = new Map<number, RiskState>();
  for (const [id, raw] of Object.entries(body.d)) {
    const state = readState(raw);
    if (state && /^\d+$/.test(id)) out.set(Number(id), state);
  }
  return out;
}

/** Each market with the fresher of its own state and the ticker's. */
export function withTickers(markets: readonly RiskMarketTerms[], tickers: ReadonlyMap<number, RiskState> | null): RiskMarketTerms[] {
  if (!tickers) return [...markets];
  return markets.map((m) => {
    const fresh = tickers.get(m.id);
    return fresh && (!m.state || fresh.at >= m.state.at) ? { ...m, state: fresh } : m;
  });
}

// --- A market, as figures -----------------------------------------------------

/** A ratio of two integers in whole basis points, rounded half away from zero. Null when there is nothing to divide by. */
export function ratioBps(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator * 10_000) / denominator);
}

/** The state is older than this: the venue has stopped stamping the market, or the read is stuck. */
export const STALE_AFTER_MS = 60_000;
/** A book this wide costs more to cross than a market order's fee. */
export const WIDE_SPREAD_BPS = 10;
/** A mark this far from the oracle is pulling funding hard. */
export const WIDE_BASIS_BPS = 25;
/** Funding at this yearly pace is a crowded side paying to stay in. Millionths: 500_000 is 50%. */
export const CROWDED_FUNDING_YEARLY = 500_000;

export type MarketFlag = 'closed' | 'stale' | 'wide_spread' | 'wide_basis' | 'crowded_funding';

export interface MarketRisk {
  id: number;
  /** `BTC/USD`. */
  asset: string;
  symbol: string;
  open: boolean;
  priceDecimals: number;
  sizeDecimals: number;
  /** Null until the venue has stated the market's prices. */
  mark: Decimal | null;
  oracle: Decimal | null;
  /** Mark over oracle, whole basis points, signed. */
  basisBps: number | null;
  /** Ask over bid, as basis points of the mid. */
  spreadBps: number | null;
  /** Mark against the price a day ago, whole basis points, signed. Null when the venue has no day-old price. */
  dayMoveBps: number | null;
  /** Open interest at the mark, AUSD atoms at six decimals. */
  openInterestUsd: Decimal | null;
  /** A day's volume, AUSD. */
  volumeUsd: Decimal | null;
  /** Millionths per funding event, signed. Positive: longs pay shorts. */
  fundingRate: number;
  fundingInterval: number;
  /** The same rate carried over a year, in millionths. Null when the venue states no interval. */
  fundingYearly: number | null;
  /** The share of a position's entry value it must keep, whole basis points: 400 is 4%. */
  maintenanceBps: number;
  /** Whole multiple: the highest leverage the venue opens at. */
  maxLeverage: number;
  /** Millionths of an order's value. */
  takerFee: number;
  /** Milliseconds the state was stamped, or null with no state. */
  at: number | null;
  flags: MarketFlag[];
}

/** One market's terms and state as the figures a row shows, with what is worth a look flagged. */
export function marketRisk(m: RiskMarketTerms, nowMs: number): MarketRisk {
  const s = m.state;
  const price = (atoms: number): Decimal => ({ atoms: String(atoms), decimals: m.priceDecimals });
  const mid = s ? Math.round((s.bid + s.ask) / 2) : 0;
  const basisBps = s ? ratioBps(s.mark - s.oracle, s.oracle) : null;
  const spreadBps = s && s.ask >= s.bid ? ratioBps(s.ask - s.bid, mid) : null;
  const fundingYearly =
    m.fundingInterval > 0 ? Math.round((m.fundingRate * SECONDS_PER_YEAR) / m.fundingInterval) : null;

  const flags: MarketFlag[] = [];
  if (!m.open) flags.push('closed');
  if (s && nowMs > 0 && nowMs - s.at > STALE_AFTER_MS) flags.push('stale');
  if (spreadBps !== null && spreadBps > WIDE_SPREAD_BPS) flags.push('wide_spread');
  if (basisBps !== null && Math.abs(basisBps) > WIDE_BASIS_BPS) flags.push('wide_basis');
  if (fundingYearly !== null && Math.abs(fundingYearly) > CROWDED_FUNDING_YEARLY) flags.push('crowded_funding');

  return {
    id: m.id,
    asset: `${m.symbol}/USD`,
    symbol: m.symbol,
    open: m.open,
    priceDecimals: m.priceDecimals,
    sizeDecimals: m.sizeDecimals,
    mark: s && s.mark > 0 ? price(s.mark) : null,
    oracle: s && s.oracle > 0 ? price(s.oracle) : null,
    basisBps,
    spreadBps,
    dayMoveBps: s && s.prev > 0 ? ratioBps(s.mark - s.prev, s.prev) : null,
    openInterestUsd: s ? notionalUsd(String(s.openInterest), m.sizeDecimals, String(s.mark), m.priceDecimals) : null,
    volumeUsd: s ? { atoms: s.volume, decimals: AMOUNT_DECIMALS } : null,
    fundingRate: m.fundingRate,
    fundingInterval: m.fundingInterval,
    fundingYearly,
    maintenanceBps: Math.round(1_000_000 / m.maintenance),
    maxLeverage: Math.floor(m.initial / 100),
    takerFee: m.takerFee,
    at: s ? s.at : null,
    flags,
  };
}

/** Markets as rows: the open ones first, the largest open interest first within each. */
export function marketRisks(markets: readonly RiskMarketTerms[], nowMs: number): MarketRisk[] {
  const weight = (r: MarketRisk) => (r.openInterestUsd ? BigInt(r.openInterestUsd.atoms) : BigInt(0));
  return markets
    .map((m) => marketRisk(m, nowMs))
    .sort((a, b) => Number(b.open) - Number(a.open) || (weight(b) > weight(a) ? 1 : weight(b) < weight(a) ? -1 : 0));
}

/** A size times a price, in AUSD atoms at six decimals, truncated. */
export function notionalUsd(sizeAtoms: string, sizeDecimals: number, priceAtoms: string, priceDecimals: number): Decimal {
  const shift = sizeDecimals + priceDecimals - AMOUNT_DECIMALS;
  const product = BigInt(sizeAtoms) * BigInt(priceAtoms);
  const atoms = shift >= 0 ? product / BigInt(10) ** BigInt(shift) : product * BigInt(10) ** BigInt(-shift);
  return { atoms: atoms.toString(), decimals: AMOUNT_DECIMALS };
}

// --- A position ---------------------------------------------------------------

const rescale = (d: Decimal, decimals: number): bigint =>
  decimals >= d.decimals
    ? BigInt(d.atoms) * BigInt(10) ** BigInt(decimals - d.decimals)
    : BigInt(d.atoms) / BigInt(10) ** BigInt(d.decimals - decimals);

/**
 * Perpl's liquidation price for an isolated position, before funding, at the
 * entry price's own decimals. Null when the position cannot be liquidated by
 * price alone (a long whose collateral covers the whole fall to zero), or when
 * a figure is missing.
 */
export function liquidationPrice(input: {
  side: VenueSide;
  size: Decimal;
  entryPrice: Decimal;
  collateral: Decimal;
  /** The market's maintenance multiple in hundredths: 2500. */
  maintenance: number;
}): Decimal | null {
  const size = BigInt(input.size.atoms);
  const entry = BigInt(input.entryPrice.atoms);
  if (size <= BigInt(0) || entry <= BigInt(0) || input.maintenance <= 0) return null;
  const dp = input.entryPrice.decimals;
  // Margin the position must keep, per unit of size, as a price: entry / MMF.
  const keep = (entry * BigInt(100)) / BigInt(input.maintenance);
  // Collateral per unit of size, as a price at the entry's decimals.
  const cushion = (rescale(input.collateral, AMOUNT_DECIMALS) * BigInt(10) ** BigInt(input.size.decimals + dp)) /
    (size * BigInt(10) ** BigInt(AMOUNT_DECIMALS));
  const gap = keep - cushion;
  const price = input.side === 'long' ? entry + gap : entry - gap;
  return price > BigInt(0) ? { atoms: price.toString(), decimals: dp } : null;
}

export type RiskLevel =
  /** Less than half of the way from entry to liquidation. */
  | 'clear'
  /** Half of the way or more. */
  | 'watch'
  /** Three quarters or more, or already past. */
  | 'near';

/** Of the way from entry to liquidation, in basis points, at which a position is worth watching, then near. */
export const WATCH_AT_BPS = 5_000;
export const NEAR_AT_BPS = 7_500;

export interface PositionRisk {
  asset: string;
  side: VenueSide;
  size: Decimal;
  entryPrice: Decimal;
  leverage: number;
  collateral: Decimal;
  /** The venue's mark for the market, or null when it has not stated one. */
  mark: Decimal | null;
  /** Size at the mark, AUSD. Null without a mark. */
  exposure: Decimal | null;
  /** Before funding. Null when price alone cannot liquidate it or the market's terms are unknown. */
  liquidation: Decimal | null;
  /** How far the mark is from liquidation, as basis points of the mark. Zero when it is at or past it. */
  distanceBps: number | null;
  /** How much of the way from entry to liquidation the mark has gone: 0 at entry, 10_000 at liquidation, negative when the price has moved the position's way. */
  usedBps: number | null;
  level: RiskLevel | null;
}

/** One position against its market: where it is liquidated and how far the mark is from there. */
export function positionRisk(position: VenuePositionView, market: MarketRisk | null, maintenance: number | null): PositionRisk {
  const base: PositionRisk = {
    asset: normalizeSymbol(position.asset),
    side: position.side,
    size: position.size,
    entryPrice: position.entryPrice,
    leverage: position.leverage,
    collateral: position.collateral,
    mark: market?.mark ?? null,
    exposure: null,
    liquidation: null,
    distanceBps: null,
    usedBps: null,
    level: null,
  };
  if (market?.mark) {
    base.exposure = notionalUsd(position.size.atoms, position.size.decimals, market.mark.atoms, market.mark.decimals);
  }
  if (maintenance === null) return base;
  const liquidation = liquidationPrice({ ...position, maintenance });
  base.liquidation = liquidation;
  if (!liquidation || !market?.mark) return base;

  const dp = Math.max(liquidation.decimals, market.mark.decimals, position.entryPrice.decimals);
  const liq = rescale(liquidation, dp);
  const mark = rescale(market.mark, dp);
  const entry = rescale(position.entryPrice, dp);
  const long = position.side === 'long';
  // Positive while the position is alive: what the mark still has to travel.
  const left = long ? mark - liq : liq - mark;
  const span = long ? entry - liq : liq - entry;
  const gone = long ? entry - mark : mark - entry;
  const distanceBps = left <= BigInt(0) ? 0 : Number((left * BigInt(10_000)) / mark);
  const usedBps = span > BigInt(0) ? Number((gone * BigInt(10_000)) / span) : null;
  return {
    ...base,
    distanceBps,
    usedBps,
    level: usedBps === null ? null : usedBps >= NEAR_AT_BPS || left <= BigInt(0) ? 'near' : usedBps >= WATCH_AT_BPS ? 'watch' : 'clear',
  };
}

/** Every position against its market, the one nearest liquidation first. */
export function positionRisks(positions: readonly VenuePositionView[], markets: readonly MarketRisk[], terms: readonly RiskMarketTerms[]): PositionRisk[] {
  const byAsset = new Map<string, MarketRisk>(markets.map((m) => [m.asset, m]));
  const maintenanceOf = new Map<string, number>(terms.map((t) => [`${t.symbol}/USD`, t.maintenance]));
  return positions
    .map((p) => {
      const asset = normalizeSymbol(p.asset);
      return positionRisk(p, byAsset.get(asset) ?? null, maintenanceOf.get(asset) ?? null);
    })
    .sort((a, b) => (b.usedBps ?? -Infinity) - (a.usedBps ?? -Infinity));
}

// --- The account --------------------------------------------------------------

export interface AccountRisk {
  /** AUSD not in any position. */
  free: Decimal;
  /** Collateral inside positions, AUSD. */
  locked: Decimal;
  /** Every position's size at its mark, AUSD. Null while a position has no mark. */
  exposure: Decimal | null;
  positions: number;
  /** Positions at `watch` or `near`. */
  flagged: number;
}

/** The account's AUSD and what its positions add up to. Sums are taken with `reduce`, never a counter (see `trade-records.ts`). */
export function accountRisk(balance: Decimal, risks: readonly PositionRisk[]): AccountRisk {
  const locked = risks.reduce((sum, r) => sum + rescale(r.collateral, AMOUNT_DECIMALS), BigInt(0));
  const marked = risks.every((r) => r.exposure !== null);
  const exposure = risks.reduce((sum, r) => sum + (r.exposure ? BigInt(r.exposure.atoms) : BigInt(0)), BigInt(0));
  return {
    free: { atoms: rescale(balance, AMOUNT_DECIMALS).toString(), decimals: AMOUNT_DECIMALS },
    locked: { atoms: locked.toString(), decimals: AMOUNT_DECIMALS },
    exposure: marked ? { atoms: exposure.toString(), decimals: AMOUNT_DECIMALS } : null,
    positions: risks.length,
    flagged: risks.filter((r) => r.level === 'watch' || r.level === 'near').length,
  };
}

// --- Words and figures --------------------------------------------------------

/** `84,032.6`: a price at the places a terminal quotes it to. */
export function formatRiskPrice(price: Decimal): string {
  const dp = displayDecimals(Number(price.atoms) / 10 ** price.decimals, price.decimals);
  return formatAtoms(price.atoms, price.decimals, dp);
}

/** `$1,741,892`: AUSD as whole dollars, for a figure whose cents say nothing. */
export function formatUsdWhole(amount: Decimal): string {
  return `$${formatAtoms(amount.atoms, amount.decimals, 0)}`;
}

/** `1,099.96 AUSD`. */
export function formatAusdAmount(amount: Decimal): string {
  return `${formatAtoms(amount.atoms, amount.decimals, 2)} AUSD`;
}

/** `4.2%`, `0.31%`, `−1.05%` from whole basis points. */
export function formatBpsPercent(bps: number, opts: { signed?: boolean } = {}): string {
  return `${formatAtoms(String(Math.trunc(bps)), 2, 2, opts.signed ? { signed: true } : {})}%`;
}

/** `+0.0030%` from millionths: a funding rate for one event keeps four places, since it is small. */
export function formatFundingRate(micros: number): string {
  return `${formatAtoms(String(Math.trunc(micros)), 4, 4, { signed: true })}%`;
}

/** `+36.67%` from millionths: the same rate over a year. */
export function formatFundingYearly(micros: number): string {
  return `${formatAtoms(String(Math.trunc(micros)), 4, 2, { signed: true })}%`;
}

/** `0.0345%` from millionths. */
export function formatFee(micros: number): string {
  return `${formatAtoms(String(Math.trunc(micros)), 4, 4)}%`;
}

/** `43m`, `1h`, `1h 05m`: how often funding is exchanged. */
export function formatInterval(seconds: number): string {
  if (seconds <= 0) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h ${String(rest).padStart(2, '0')}m`;
}

/** Who pays whom at this rate, in words. A rate of zero moves nothing. */
export function fundingDirection(micros: number): string {
  if (micros > 0) return 'Longs pay shorts';
  if (micros < 0) return 'Shorts pay longs';
  return 'Nobody pays';
}

export const FLAG_LABEL: Record<MarketFlag, string> = {
  closed: 'CLOSED',
  stale: 'STALE',
  wide_spread: 'WIDE BOOK',
  wide_basis: 'OFF ORACLE',
  crowded_funding: 'CROWDED',
};

/** One flag as a sentence with its figure, for the "worth a look" list. */
export function flagLine(market: MarketRisk, flag: MarketFlag): string {
  switch (flag) {
    case 'closed':
      return `${market.asset} is closed to new orders.`;
    case 'stale':
      return `${market.asset} has not been stamped by the venue for over a minute.`;
    case 'wide_spread':
      return `${market.asset} book is ${formatBpsPercent(market.spreadBps ?? 0)} wide, more than a market order's fee.`;
    case 'wide_basis':
      return `${market.asset} mark is ${formatBpsPercent(market.basisBps ?? 0, { signed: true })} from the oracle.`;
    case 'crowded_funding':
      return `${market.asset} funding runs at ${formatFundingYearly(market.fundingYearly ?? 0)} a year. ${fundingDirection(market.fundingRate)}.`;
  }
}

export const LEVEL_LABEL: Record<RiskLevel, string> = { clear: 'CLEAR', watch: 'WATCH', near: 'NEAR' };

/** A position's risk in one sentence. */
export function positionLine(risk: PositionRisk): string {
  if (!risk.liquidation) return 'Price alone cannot liquidate this position.';
  if (risk.distanceBps === null) return `Liquidation at ${formatRiskPrice(risk.liquidation)}, before funding.`;
  if (risk.distanceBps === 0) return `The mark is at or past its liquidation price, ${formatRiskPrice(risk.liquidation)}.`;
  return `Liquidation at ${formatRiskPrice(risk.liquidation)}, ${formatBpsPercent(risk.distanceBps)} from the mark, before funding.`;
}
