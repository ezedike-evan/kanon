import { baseOf, normalizeSymbol } from './chart-assets';
import {
  DIRECTION_WORD,
  TIME_IS_UP,
  durationLabel,
  durationWords,
  formatClockTime,
  openedLine,
  type TimedView,
} from './timed-trade';
import type { TimedDirection, TimedState, TimedTrade } from './timed-types';
import { formatUsd } from './venue-trade';

/**
 * Predict as a reel: which full-screen slides there are, and what each one
 * says.
 *
 * The market is not a price, it is a time. So a slide is a pair and a time:
 * `BTC, next 1 minute`, `BTC, next 5 minutes`, `ETH, next 1 minute`. The pairs
 * are the server's markets and the times are the server's durations; nothing
 * here invents either. (Signed out the state handed in is the labelled sample,
 * `timed-sample.ts`, and the slides are built from it the same way.)
 * A slide offers UP and DOWN, or shows the trade that is
 * running on its pair, or the one that just ended there, or why the pair can
 * take no trade right now.
 *
 * Pure, with no clock of its own, so every rule is pinned down in
 * `timed-reel.test.ts`.
 */

// --- Which slides there are -----------------------------------------------------

export interface ReelFilter {
  /** A pair's ticker like `BTC`, or `null` for all of them. */
  asset: string | null;
  /** A time in seconds, or `null` for any. */
  seconds: number | null;
}

export const NO_FILTER: ReelFilter = { asset: null, seconds: null };

export interface ReelSlide {
  /** `BTC/USD|60`. */
  id: string;
  /** `BTC/USD`. */
  asset: string;
  /** `BTC`. */
  base: string;
  /** How long a trade opened from this slide runs. */
  seconds: number;
}

export type ReelItem = { kind: 'slide'; id: string; slide: ReelSlide } | { kind: 'end'; id: 'end' };

export const slideId = (asset: string, seconds: number): string => `${normalizeSymbol(asset)}|${seconds}`;

/** The tickers of the pairs the server lists, in its own order. None until the state is read. */
export function assetOptions(state: TimedState): string[] {
  if (state.status !== 'ready') return [];
  return [...new Set(state.markets.map((market) => baseOf(market.asset)))];
}

/** The times the server offers, shortest first. None until the state is read. */
export function timeOptions(state: TimedState): number[] {
  return state.status === 'ready' ? state.limits.durations : [];
}

/** The next time in the top bar chip's cycle: any, then each in turn, then any again. */
export function nextTime(current: number | null, options: readonly number[]): number | null {
  if (options.length === 0) return null;
  if (current === null) return options[0] ?? null;
  const i = options.indexOf(current);
  return i < 0 || i === options.length - 1 ? null : (options[i + 1] ?? null);
}

/**
 * The slides, pair by pair, each pair's times shortest first: every time of
 * one pair, then the next pair. A filter narrows them and never reorders them.
 * A pair that cannot take a trade right now keeps its slides: the slide is
 * where it says why, and when it frees.
 */
export function reelSlides(state: TimedState, filter: ReelFilter): ReelSlide[] {
  if (state.status !== 'ready') return [];
  const slides: ReelSlide[] = [];
  const seen = new Set<string>();
  for (const market of state.markets) {
    const asset = normalizeSymbol(market.asset);
    const base = baseOf(asset);
    if (filter.asset !== null && base !== filter.asset) continue;
    for (const seconds of state.limits.durations) {
      if (filter.seconds !== null && seconds !== filter.seconds) continue;
      const id = slideId(asset, seconds);
      if (seen.has(id)) continue;
      seen.add(id);
      slides.push({ id, asset, base, seconds });
    }
  }
  return slides;
}

/** The pages: one per slide, then one closing page so the last swipe lands somewhere. Nothing for no slides. */
export function reelItems(slides: readonly ReelSlide[]): ReelItem[] {
  if (slides.length === 0) return [];
  return [...slides.map((slide): ReelItem => ({ kind: 'slide', id: slide.id, slide })), { kind: 'end', id: 'end' }];
}

/** The index of the page showing `id`, or -1. */
export const indexOfItem = (items: readonly ReelItem[], id: string): number => items.findIndex((item) => item.id === id);

/**
 * The slide to go to for a trade: its own pair and time if that slide is in
 * the reel, else any slide of its pair (every slide of a pair shows the trade
 * running on it). Null when the filter has left none of that pair in.
 */
export function slideForTrade(slides: readonly ReelSlide[], trade: Pick<TimedTrade, 'asset' | 'seconds'>): ReelSlide | null {
  const asset = normalizeSymbol(trade.asset);
  return (
    slides.find((slide) => slide.asset === asset && slide.seconds === trade.seconds) ??
    slides.find((slide) => slide.asset === asset) ??
    null
  );
}

// --- What a slide is doing --------------------------------------------------------

/**
 * What a slide shows where its two actions go. A market holds one position, so
 * a trade running on a pair is shown on every slide of that pair, whichever
 * time the slide itself is for.
 */
export type SlideMode =
  /** UP and DOWN can be pressed. */
  | { kind: 'actions' }
  /** One of the caller's trades is running on this pair. */
  | { kind: 'running'; trade: TimedTrade }
  /** One of the caller's trades ended on this pair while the screen was open, and has not been put away. */
  | { kind: 'ended'; trade: TimedTrade }
  /**
   * The pair can take no trade right now, and the slide says why: `tag` in a
   * word or two, `short` in a few (for a row), `line` in a sentence.
   */
  | { kind: 'held'; tag: string; short: string; line: string };

/**
 * `view` is the slide's own (`timedView` for its pair and time). `running` and
 * `ended` are the caller's trades, as the screen holds them.
 *
 * A running trade comes first: it is what the pair is doing. Then an ending
 * that has not been put away, so it is seen where the trade ran. Then a reason
 * the pair is held: a position from the chart, somebody else's timed trade, a
 * closed market.
 */
export function slideMode(
  slide: Pick<ReelSlide, 'asset'>,
  view: Pick<TimedView, 'hold' | 'markets'>,
  running: readonly TimedTrade[],
  ended: readonly TimedTrade[],
): SlideMode {
  const live = running.find((trade) => trade.asset === slide.asset);
  if (live) return { kind: 'running', trade: live };
  const done = ended.find((trade) => trade.asset === slide.asset);
  if (done) return { kind: 'ended', trade: done };
  if (view.hold !== null) {
    const market = view.markets.find((choice) => choice.asset === slide.asset);
    return { kind: 'held', tag: market?.tag ?? 'NOT OPEN', short: market?.busyLine ?? view.hold, line: view.hold };
  }
  return { kind: 'actions' };
}

// --- What a slide says ------------------------------------------------------------

export interface TitlePart {
  text: string;
  /** A figure: set monospaced and tabular. */
  mono: boolean;
}

// Non-breaking spaces keep a figure and its unit together, so a wrap never leaves a lone word.
const nbsp = (text: string): string => text.replace(/ /g, ' ');

/** `Which way does BTC move in the next 1 minute?`, split so the time can be set in mono. */
export function slideTitle(slide: Pick<ReelSlide, 'base' | 'seconds'>): TitlePart[] {
  return [
    { text: `Which way does ${slide.base} move in the next `, mono: false },
    { text: nbsp(durationWords(slide.seconds)), mono: true },
    { text: '?', mono: false },
  ];
}

/** `BTC called up for 1 minute.`: what a running trade is, in the place the question was. */
export function runningTitle(trade: Pick<TimedTrade, 'asset' | 'direction' | 'seconds'>): TitlePart[] {
  return [
    { text: `${baseOf(trade.asset)} called ${trade.direction} for `, mono: false },
    { text: nbsp(durationWords(trade.seconds)), mono: true },
    { text: '.', mono: false },
  ];
}

/** A title as one plain string, for a screen reader and a share. */
export const titleText = (parts: readonly TitlePart[]): string =>
  parts
    .map((part) => part.text)
    .join('')
    .replace(/ /g, ' ');

/** `Which way does BTC move in the next 1 minute?` */
export const slideQuestion = (slide: Pick<ReelSlide, 'base' | 'seconds'>): string => titleText(slideTitle(slide));

/**
 * What a press on UP or DOWN opens, short enough for the button: `Long $125`.
 * The size is the stake times the pair's leverage, both the server's. Null
 * until both are known.
 */
export function sideClaim(view: Pick<TimedView, 'stakeUsd' | 'leverage'>, direction: TimedDirection): string | null {
  if (view.stakeUsd === null || view.leverage === null) return null;
  return `${direction === 'up' ? 'Long' : 'Short'} ${formatUsd(view.stakeUsd * view.leverage)}`;
}

/** Whose account a trade goes to, in one line a slide has room for. Said once per slide. */
export function accountLine(network: 'testnet' | 'mainnet' | null): string {
  return network === 'mainnet'
    ? 'One account that everyone signed in shares. Not your funds.'
    : 'One testnet account that everyone signed in shares. Not your funds.';
}

/**
 * The line under a running trade's "End now". The server's own words on a
 * delay come first, then that its time is up, then, on a slide for another
 * time than the trade's, why this slide offers nothing, and otherwise when the
 * trade closes itself. A trade autopilot opened says so in that last line: the
 * person looking at the slide did not open it.
 */
export function runningNote(
  trade: Pick<TimedTrade, 'asset' | 'direction' | 'seconds' | 'expiresAt' | 'status' | 'reason'> & {
    origin?: TimedTrade['origin'] | undefined;
  },
  slide: Pick<ReelSlide, 'seconds'>,
  due: boolean,
): string {
  if (trade.reason) return trade.reason;
  if (due && trade.status === 'live') return TIME_IS_UP;
  if (trade.seconds !== slide.seconds) {
    const which = trade.origin === 'autopilot' ? 'Autopilot opened this one. It' : 'This one';
    return `${baseOf(trade.asset)} takes one timed trade at a time. ${which} closes itself at ${formatClockTime(trade.expiresAt)}.`;
  }
  return openedLine(trade);
}

/**
 * The word or two a slide's badge says about where it stands: `OPEN`,
 * `RUNNING`, `CLOSING`, `ENDED`, or why the pair is held (`IN A TRADE`, `HELD`,
 * `CLOSED`). `closing` is the running trade being past the point it can be ended.
 * On the signed-out sample a slide that would say `OPEN` says `SAMPLE`: nothing
 * is open to a visitor, and the prices on it are not live.
 */
export function slideBadge(mode: SlideMode, closing = false, sample = false): string {
  if (mode.kind === 'running') return closing ? 'CLOSING' : 'RUNNING';
  if (mode.kind === 'ended') return 'ENDED';
  if (mode.kind === 'held') return mode.tag;
  return sample ? 'SAMPLE' : 'OPEN';
}

/** One slide as a row of the desktop's list: `BTC · 1m`, and where it stands. */
export interface SlideRowView {
  id: string;
  /** `BTC`. */
  base: string;
  /** `1m`. */
  time: string;
  /** `Open`, `UP running`, `Just ended`, in a few words why the pair is held, or `Sample` signed out. */
  state: string;
  /** `Go to: Which way does BTC move in the next 1 minute?` */
  accessibilityLabel: string;
}

export function slideRowView(slide: ReelSlide, mode: SlideMode, sample = false): SlideRowView {
  const state =
    mode.kind === 'running'
      ? `${DIRECTION_WORD[mode.trade.direction]} running`
      : mode.kind === 'ended'
        ? 'Just ended'
        : mode.kind === 'held'
          ? mode.short
          : sample
            ? 'Sample'
            : 'Open';
  return {
    id: slide.id,
    base: slide.base,
    time: durationLabel(slide.seconds),
    state,
    accessibilityLabel: `Go to: ${slideQuestion(slide)}`,
  };
}

/**
 * How wide the candles behind a slide's line are, in seconds. One-minute
 * candles for every time up to a quarter of an hour, five-minute ones beyond,
 * so the line is about three of the slide's own windows at a readable grain.
 */
export function lineBucketSeconds(seconds: number): number {
  return seconds <= 900 ? 60 : 300;
}
