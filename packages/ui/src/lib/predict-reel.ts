/**
 * The Predict feed as a reel: what each full-screen page says, and which pages
 * there are.
 *
 * Pure, and none of it decides anything. A market's result is `settleThreshold`
 * in `@kanon/spec`; this file only words the question that arithmetic answers,
 * picks which markets a viewer sees, and says what state a page is in. No clock
 * is read here: `nowSeconds` is passed in, so every phase and countdown is
 * pinned down in `predict-reel.test.ts`.
 */

import {
  MAX_REFERENCE_AGE_SECONDS,
  canTakeSide,
  distanceBps,
  formatBps,
  formatDecimal,
  isMarketAsset,
  marketAssets,
  marketPhase,
  type Decimal,
  type MarketPhase,
  type MarketSide,
} from '@kanon/spec';
import { CROSSED_MESSAGE, STALE_MESSAGE, type MarketAvailability } from './market-client';
import { durationLabel, formatAmount, positionResultLabel, sideLabel } from './predict-map';
import type { PredictMarket, PredictPosition } from './predict-types';

// ---------------------------------------------------------------------------
// Words for prices and windows.
// ---------------------------------------------------------------------------

/** `BTC/USD` is `BTC`. */
export const assetCode = (symbol: string): string => symbol.split('/')[0] ?? symbol;

/** Drops the run of trailing zeros a fixed-decimals price carries: `81,200.00` is `81,200`. */
export function trimDecimal(d: Decimal): string {
  const text = formatDecimal(d);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** A price as a person says it: `$81,200`, `$3,412.5`, `$0.0342`. */
export const dollars = (d: Decimal): string => `$${trimDecimal(d)}`;

/**
 * How many places a live price is shown to. Pyth prints eight; a card that
 * shows `81,204.12345678` is noise. Rounds half up, in BigInt: no float.
 */
export function displayPlaces(d: Decimal): number {
  const whole = BigInt(d.atoms.replace('-', '')) / 10n ** BigInt(d.decimals);
  if (whole >= 10n) return Math.min(2, d.decimals);
  if (whole >= 1n) return Math.min(3, d.decimals);
  return Math.min(5, d.decimals);
}

export function roundDecimal(d: Decimal, places: number): Decimal {
  if (places >= d.decimals) return d;
  const drop = 10n ** BigInt(d.decimals - places);
  const atoms = BigInt(d.atoms);
  const negative = atoms < 0n;
  const abs = negative ? -atoms : atoms;
  const rounded = (abs + drop / 2n) / drop;
  return { atoms: (negative ? -rounded : rounded).toString(), decimals: places };
}

/** A live price for the big figure: rounded to a readable width, grouped, never trimmed. */
export function displayPrice(d: Decimal): string {
  return formatDecimal(roundDecimal(d, displayPlaces(d)));
}

const TIMEFRAME_SECONDS: Record<string, number> = { '15M': 900, '1H': 3_600, '4H': 14_400, '1D': 86_400 };

/** `1H` is 3600. `null` for a label this feed does not use. */
export function timeframeSeconds(label: string): number | null {
  return TIMEFRAME_SECONDS[label] ?? null;
}

/** `3600` is `1 hour`, `14400` is `4 hours`, `900` is `15 minutes`. */
export function windowPhrase(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0 && seconds !== 86_400) return `${seconds / 86_400} days`;
  const hours = seconds / 3_600;
  if (Number.isInteger(hours) && hours >= 1) return hours === 1 ? '1 hour' : `${hours} hours`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** How long the card says the window runs. The label wins over the clock: a demo card's clock is not the window. */
export function windowLength(m: Pick<PredictMarket, 'timeframe' | 'windowStart' | 'windowEnd'>): number {
  return timeframeSeconds(m.timeframe) ?? Math.max(60, m.windowEnd - m.windowStart);
}

// ---------------------------------------------------------------------------
// The question. A touch, worded as one: reaching the level counts.
// ---------------------------------------------------------------------------

export interface QuestionPart {
  text: string;
  /** A figure: rendered monospaced and tabular. */
  mono: boolean;
}

/** `Will BTC reach $81,200 within 1 hour?`, split so the figure can be set in mono. */
export function questionParts(market: Pick<PredictMarket, 'asset' | 'direction' | 'target' | 'timeframe' | 'windowStart' | 'windowEnd'>): QuestionPart[] {
  const verb = market.direction === 'above' ? 'reach' : 'fall to';
  return [
    { text: `Will ${assetCode(market.asset)} ${verb} `, mono: false },
    { text: dollars(market.target), mono: true },
    // Non-breaking spaces keep "within 4 hours?" together, so a wrap never leaves a lone word on the last line.
    { text: ` within\u00A0${windowPhrase(windowLength(market)).replace(' ', '\u00A0')}?`, mono: false },
  ];
}

export const questionText = (market: Parameters<typeof questionParts>[0]): string =>
  questionParts(market)
    .map((p) => p.text)
    .join('')
    .replace(/\u00A0/g, ' ');

export interface SideCopy {
  label: 'UP' | 'DOWN';
  /** What taking the side claims, short enough for a button. */
  claim: string;
  /** The winning condition, in a full sentence. Touching counts. */
  wins: string;
}

/**
 * What a side is a claim about. UP and DOWN name the price side a person is on:
 * on a market that asks whether the price reaches a level above, UP says it
 * does and DOWN says it does not; on one below, the other way round.
 */
export function sideCopy(
  market: Pick<PredictMarket, 'asset' | 'direction' | 'target'>,
  side: MarketSide,
): SideCopy {
  const level = dollars(market.target);
  const code = assetCode(market.asset);
  const reaches = side === market.direction;
  if (reaches) {
    return {
      label: sideLabel(side),
      claim: market.direction === 'above' ? `Reaches ${level}` : `Falls to ${level}`,
      wins: `Wins if ${code} touches ${level} at any point in the window.`,
    };
  }
  return {
    label: sideLabel(side),
    claim: market.direction === 'above' ? `Stays below ${level}` : `Stays above ${level}`,
    wins: `Wins if ${code} never touches ${level} in the window.`,
  };
}

// ---------------------------------------------------------------------------
// Where a page stands.
// ---------------------------------------------------------------------------

/**
 * The phase the page shows. The contract can say a market is crossed before the
 * backend's sweep has recorded it, so an on-chain `hasCrossed` closes a live
 * market here too.
 */
export function effectivePhase(market: PredictMarket, nowSeconds: number, crossedOnChain: boolean): MarketPhase {
  const clock = marketPhase(market, nowSeconds);
  return crossedOnChain && (clock === 'open' || clock === 'upcoming') ? 'crossed' : clock;
}

export const isResolved = (phase: MarketPhase): boolean => phase === 'settled' || phase === 'unresolvable';

/** Time left in the window as 1 (all of it) down to 0. An upcoming window is full. Continuous, never stepped by phase. */
export function windowRemaining(market: Pick<PredictMarket, 'windowStart' | 'windowEnd'>, nowSeconds: number): number {
  const total = market.windowEnd - market.windowStart;
  if (total <= 0) return 0;
  const left = market.windowEnd - Math.max(nowSeconds, market.windowStart);
  return Math.min(1, Math.max(0, left / total));
}

/** The live print is missing, or older than the feed's own two-heartbeat limit. */
export function isPriceStale(market: Pick<PredictMarket, 'price' | 'priceAt' | 'demo'>, nowSeconds: number): boolean {
  if (market.demo) return false;
  if (!market.price || market.priceAt === null) return true;
  return nowSeconds - market.priceAt > MAX_REFERENCE_AGE_SECONDS;
}

export type NoteKind = 'crossed' | 'expired' | 'stale' | 'unavailable';

export interface PageNote {
  kind: NoteKind;
  text: string;
}

export interface PageState {
  phase: MarketPhase;
  /** The two side buttons are shown. */
  showSides: boolean;
  /** ...and can be pressed. False while a note explains why not. */
  canStake: boolean;
  /** A plain neutral sentence: never an error. */
  note: PageNote | null;
}

/**
 * What a page shows in its action zone. Every reason a side cannot be taken is
 * a statement of fact: the threshold was crossed, the window ended, the price is
 * not fresh, staking is not deployed here. None of them is a fault.
 */
export function pageState(input: {
  market: PredictMarket;
  nowSeconds: number;
  crossedOnChain: boolean;
  availability: MarketAvailability;
}): PageState {
  const { market, nowSeconds, crossedOnChain, availability } = input;
  const phase = effectivePhase(market, nowSeconds, crossedOnChain);
  if (isResolved(phase)) return { phase, showSides: false, canStake: false, note: null };
  if (phase === 'crossed') {
    return { phase, showSides: false, canStake: false, note: { kind: 'crossed', text: CROSSED_MESSAGE } };
  }
  if (phase === 'expired') {
    return {
      phase,
      showSides: false,
      canStake: false,
      note: { kind: 'expired', text: 'Window ended. Waiting for the print that closes the last candle.' },
    };
  }
  if (!canTakeSide(phase)) return { phase, showSides: false, canStake: false, note: null };
  if (isPriceStale(market, nowSeconds)) {
    return { phase, showSides: true, canStake: false, note: { kind: 'stale', text: STALE_MESSAGE } };
  }
  // Demo says so on the card's badge and in the stake sheet; repeating it under every card is noise.
  if (availability.state === 'demo') return { phase, showSides: true, canStake: true, note: null };
  if (availability.state !== 'ready') {
    return { phase, showSides: true, canStake: false, note: { kind: 'unavailable', text: availability.message } };
  }
  return { phase, showSides: true, canStake: true, note: null };
}

// ---------------------------------------------------------------------------
// A settled page.
// ---------------------------------------------------------------------------

export interface OutcomeCopy {
  headline: string;
  /** Label for the figure under the headline. */
  figureLabel: string | null;
  figure: Decimal | null;
  /** True when the level was touched. */
  hit: boolean | null;
}

/** A settled market in one plain sentence, and the price that decided it. A miss is a result like any other. */
export function outcomeCopy(market: PredictMarket): OutcomeCopy {
  const s = market.settlement;
  const code = assetCode(market.asset);
  const level = dollars(market.target);
  if (!s || s.outcome === 'unresolvable') {
    return { headline: 'No result. Stakes are refunded.', figureLabel: null, figure: null, hit: null };
  }
  if (s.outcome === 'hit') {
    return {
      headline: `Yes. ${code} ${market.direction === 'above' ? 'reached' : 'fell to'} ${level}.`,
      figureLabel: 'Deciding price',
      figure: s.decidingPrice,
      hit: true,
    };
  }
  return {
    headline: `No. ${code} did not ${market.direction === 'above' ? 'reach' : 'fall to'} ${level}.`,
    figureLabel: market.direction === 'above' ? 'Window high' : 'Window low',
    figure: s.windowExtreme?.price ?? null,
    hit: false,
  };
}

/** One line per stake the person holds on a market: `UP · 0.05 · Won`. */
export function positionLines(positions: readonly PredictPosition[], symbol: string): string[] {
  return positions.map((p) => {
    const stake = p.stake ? `${formatAmount(p.stake)} ${symbol}` : '';
    return [sideLabel(p.side), stake, positionResultLabel(p.result)].filter(Boolean).join(' · ');
  });
}

/** `+0.50%`, the signed distance from the live price to the level. `null` without a price. */
export function distanceLabel(market: Pick<PredictMarket, 'price' | 'target'>): string | null {
  if (!market.price) return null;
  try {
    return formatBps(distanceBps(market.price, market.target), { signed: true });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Which pages there are.
// ---------------------------------------------------------------------------

export interface ReelFilter {
  /** An asset code like `BTC`, or `null` for all of them. */
  asset: string | null;
  /** A window label like `1H`, or `null` for any. */
  timeframe: string | null;
}

export const NO_FILTER: ReelFilter = { asset: null, timeframe: null };

/** Asset codes present in `markets`, in the app's own order. Only assets with a Pyth feed: AVAX never appears. */
export function assetOptions(markets: readonly Pick<PredictMarket, 'asset'>[]): string[] {
  const present = new Set(markets.filter((m) => isMarketAsset(m.asset)).map((m) => assetCode(m.asset)));
  return marketAssets()
    .map(assetCode)
    .filter((code) => present.has(code));
}

/** Window labels present in `markets`, shortest first. */
export function timeframeOptions(markets: readonly Pick<PredictMarket, 'timeframe'>[]): string[] {
  const seen = [...new Set(markets.map((m) => m.timeframe))];
  return seen.sort((a, b) => (timeframeSeconds(a) ?? Infinity) - (timeframeSeconds(b) ?? Infinity));
}

/** The next timeframe in the chip's cycle: any, then each in turn, then any again. */
export function nextTimeframe(current: string | null, options: readonly string[]): string | null {
  if (options.length === 0) return null;
  if (current === null) return options[0] ?? null;
  const i = options.indexOf(current);
  return i < 0 || i === options.length - 1 ? null : (options[i + 1] ?? null);
}

export function filterMarkets<M extends Pick<PredictMarket, 'asset' | 'timeframe'>>(
  markets: readonly M[],
  filter: ReelFilter,
): M[] {
  return markets.filter(
    (m) =>
      isMarketAsset(m.asset) &&
      (filter.asset === null || assetCode(m.asset) === filter.asset) &&
      (filter.timeframe === null || m.timeframe === filter.timeframe),
  );
}

export type ReelItem = { kind: 'market'; id: string; market: PredictMarket } | { kind: 'end'; id: 'end' };

/** The pages: one per market, then one closing page so the last swipe lands somewhere. Nothing for an empty feed. */
export function reelItems(markets: readonly PredictMarket[]): ReelItem[] {
  if (markets.length === 0) return [];
  return [...markets.map((market): ReelItem => ({ kind: 'market', id: market.id, market })), { kind: 'end', id: 'end' }];
}

/** The page a confirmed stake moves to: the next one, never past the last. */
export const advanceIndex = (current: number, total: number): number => Math.max(0, Math.min(current + 1, total - 1));

/** The index of the page showing `id`, or -1. */
export const indexOfItem = (items: readonly ReelItem[], id: string): number => items.findIndex((i) => i.id === id);

// ---------------------------------------------------------------------------
// Stakes.
// ---------------------------------------------------------------------------

export interface StakeChoice {
  index: number;
  amount: Decimal;
  label: string;
}

/**
 * The stakes offered, as labelled choices. Fixed and all shown. The first is the
 * smallest and is where the sheet starts: an amount is never a default the
 * person did not see.
 */
export function stakeChoices(presets: readonly Decimal[]): StakeChoice[] {
  return presets.map((amount, index) => ({ index, amount, label: formatAmount(amount) }));
}

export const DEFAULT_STAKE_INDEX = 0;

/** The preset at `index`, clamped into range. `null` only for an empty list. */
export function stakeAt(presets: readonly Decimal[], index: number): Decimal | null {
  if (presets.length === 0) return null;
  return presets[Math.min(presets.length - 1, Math.max(0, Math.floor(index)))] ?? null;
}

/** Window and candle width as one figure line: `1H · 15M CANDLES`. */
export function termsLine(market: PredictMarket): string {
  const candle = market.terms ? ` · ${durationLabel(market.terms.bucketSeconds)} CANDLES` : '';
  return `${market.timeframe}${candle}`;
}

/**
 * The numbers that shaped a market, for the "how it settles" sheet: the level,
 * the window, the candle width, and where the level sits from the price it was
 * built from. Nothing the compiler chose is left off a card.
 */
export function settleTerms(market: PredictMarket): [string, string][] {
  const rows: [string, string][] = [
    ['Level', dollars(market.target)],
    ['Window', windowPhrase(windowLength(market))],
  ];
  if (market.terms) {
    rows.push(['Candle', durationLabel(market.terms.bucketSeconds)]);
    rows.push([
      'Built from',
      `${dollars(market.terms.referencePrice)} (${formatBps(market.terms.distanceBps, { signed: true })})`,
    ]);
  }
  rows.push(['Touching counts', 'Yes']);
  return rows;
}

/** Splits a sentence so each price in it (`$3,438.7`) can be set in mono. Everything else stays as it was. */
export function splitFigures(text: string): QuestionPart[] {
  const parts: QuestionPart[] = [];
  let last = 0;
  for (const m of text.matchAll(/\$[\d,]+(?:\.\d+)?/g)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at), mono: false });
    parts.push({ text: m[0], mono: true });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), mono: false });
  return parts;
}
