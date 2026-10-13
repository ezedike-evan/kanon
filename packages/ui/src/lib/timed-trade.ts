import { formatBps, type Decimal } from '@kanon/spec';
import { baseOf, normalizeSymbol } from './chart-assets';
import { displayDecimals, formatAtoms, formatCountdown } from './chart-format';
import {
  NOT_REPORTED_YET,
  chosenOption,
  feeFact,
  formatLeverage,
  formatUsd,
  formatVenueSize,
  venueTx,
  type TxRef,
} from './venue-trade';
import type {
  TimedCloseResult,
  TimedDirection,
  TimedEnd,
  TimedLimits,
  TimedMarketView,
  TimedNetwork,
  TimedOpenResult,
  TimedRequest,
  TimedSending,
  TimedState,
  TimedStateView,
  TimedTrade,
  TimedTradeStatus,
  TimedTradeView,
} from './timed-types';

/**
 * The pure half of Predict: what it offers, what it says and what it links to,
 * worked out from what the server answered. No React, no I/O, and no clock of
 * its own (a caller passes `nowMs`), so every rule here is pinned down in
 * `timed-trade.test.ts`.
 *
 * A timed trade is a position with a timer: UP is a long, DOWN is a short,
 * opened at market and closed at market by the server when the time is up.
 * What this file says about one while it runs is a direction and a price
 * difference, never money. A trade's result in AUSD exists only in
 * `finishedDetail`, which a screen shows one press away from the list.
 *
 * Prices and sizes stay integers throughout. The line a slide draws is
 * `predict-chart.ts`'s, and is the only place a price becomes a float.
 */

// --- Words the client says itself ---------------------------------------------

export const TIMED_STATE_UNREAD = 'Timed trades could not be read. Try again.';
export const TIMED_STATE_UNKNOWN_SHAPE = 'Timed trades came back in a shape this screen does not know.';
/** A call that threw may or may not have reached the venue, so this claims neither. */
export const TIMED_OPEN_UNREAD = "The trade's result could not be read. Check the running trades before opening another.";
export const TIMED_OPEN_UNKNOWN_SHAPE =
  "The trade's result came back in a shape this screen does not know. Check the running trades before opening another.";
export const TIMED_CLOSE_UNREAD = 'The request to end the trade could not be read. The trade still closes itself when its time is up.';
export const TIMED_CLOSE_UNKNOWN_SHAPE =
  'The request to end the trade came back in a shape this screen does not know. The trade still closes itself when its time is up.';
/** Said in a running trade once its time has passed and its row has not closed yet. */
export const TIME_IS_UP = 'Time is up. Closing at market.';

// --- Reading what the server answered -----------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCount = (v: unknown): v is number => isNumber(v) && v >= 0;
const isDirection = (v: unknown): v is TimedDirection => v === 'up' || v === 'down';
const isNetwork = (v: unknown): v is TimedNetwork => v === 'testnet' || v === 'mainnet';
const isAmounts = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => isNumber(n) && n > 0);

function isDecimal(v: unknown): v is Decimal {
  return (
    isRecord(v) &&
    typeof v.atoms === 'string' &&
    /^-?\d+$/.test(v.atoms) &&
    typeof v.decimals === 'number' &&
    Number.isInteger(v.decimals) &&
    v.decimals >= 0
  );
}

const isLimits = (v: unknown): v is TimedLimits =>
  isRecord(v) && isAmounts(v.stakesUsd) && isAmounts(v.durations) && isCount(v.maxLeverage) && isCount(v.slippageBps);

const isBusy = (v: unknown): v is { until: number | null } => isRecord(v) && (v.until === null || isNumber(v.until));

const isMarket = (v: unknown): v is TimedMarketView =>
  isRecord(v) &&
  isText(v.asset) &&
  typeof v.open === 'boolean' &&
  isNumber(v.leverage) &&
  v.leverage >= 1 &&
  (v.busy === null || isBusy(v.busy));

/** Each value once, smallest first: the order the chips are drawn in, and the one `chosenOption` reads. */
const ascending = (values: readonly number[]): number[] => [...new Set(values)].sort((a, b) => a - b);

/**
 * `GET /predict/state`'s answer as the state a screen draws. A reply that is
 * not one of its two shapes is a failure to read, not a state: the screen then
 * says so and offers nothing, instead of drawing chips from fields that are not
 * there.
 */
export function asTimedState(result: unknown): TimedStateView {
  if (isRecord(result)) {
    if (result.status === 'unavailable' && isText(result.message)) {
      return { status: 'unavailable', message: result.message };
    }
    if (
      result.status === 'ready' &&
      isNetwork(result.network) &&
      isLimits(result.limits) &&
      Array.isArray(result.markets) &&
      result.markets.every(isMarket)
    ) {
      const { limits } = result;
      return {
        status: 'ready',
        venue: 'perpl',
        network: result.network,
        limits: {
          stakesUsd: ascending(limits.stakesUsd),
          durations: ascending(limits.durations),
          maxLeverage: limits.maxLeverage,
          slippageBps: limits.slippageBps,
        },
        markets: (result.markets as TimedMarketView[]).map((m) => ({
          asset: m.asset,
          open: m.open,
          leverage: m.leverage,
          busy: m.busy ? { until: m.busy.until } : null,
        })),
      };
    }
  }
  return { status: 'unavailable', message: TIMED_STATE_UNKNOWN_SHAPE };
}

function isTradeView(v: unknown): v is TimedTradeView {
  return (
    isRecord(v) &&
    isText(v.id) &&
    isText(v.asset) &&
    isDirection(v.direction) &&
    isCount(v.stakeUsd) &&
    isCount(v.leverage) &&
    isCount(v.seconds) &&
    isNumber(v.openedAt) &&
    isNumber(v.expiresAt) &&
    isDecimal(v.size) &&
    isDecimal(v.entryPrice)
  );
}

/** What a rate limit says when the server sent no sentence of its own. */
export function rateLimitedLine(retryAfterMs: number): string {
  const seconds = Math.ceil(Math.max(0, retryAfterMs) / 1000);
  return seconds > 0 ? `Too many requests. The next one can go in ${seconds} seconds.` : 'Too many requests. Wait a moment.';
}

/** `POST /predict/open`'s answer, read the same way as the state. */
export function asTimedOpenResult(result: unknown): TimedOpenResult {
  if (isRecord(result)) {
    switch (result.status) {
      case 'opened':
        if (isTradeView(result.trade)) return { status: 'opened', trade: result.trade };
        break;
      case 'refused':
        if (isText(result.reason)) return { status: 'refused', reason: result.reason };
        break;
      case 'busy':
      case 'unfilled':
      case 'pending':
      case 'unavailable':
        if (isText(result.message)) return { status: result.status, message: result.message };
        break;
      case 'rate_limited': {
        const retryAfterMs = isCount(result.retryAfterMs) ? result.retryAfterMs : 0;
        return {
          status: 'rate_limited',
          retryAfterMs,
          message: isText(result.message) ? result.message : rateLimitedLine(retryAfterMs),
        };
      }
    }
  }
  return { status: 'unavailable', message: TIMED_OPEN_UNKNOWN_SHAPE };
}

/** `POST /predict/close`'s answer. */
export function asTimedCloseResult(result: unknown): TimedCloseResult {
  if (isRecord(result)) {
    if (result.status === 'closing' && isText(result.tradeId)) return { status: 'closing', tradeId: result.tradeId };
    if (result.status === 'refused' && isText(result.reason)) return { status: 'refused', reason: result.reason };
    if (result.status === 'unavailable' && isText(result.message)) return { status: 'unavailable', message: result.message };
  }
  return { status: 'unavailable', message: TIMED_CLOSE_UNKNOWN_SHAPE };
}

const STATUSES: readonly TimedTradeStatus[] = ['live', 'closing', 'closed'];
const ENDS: readonly TimedEnd[] = ['time', 'cut', 'owner', 'venue'];

/**
 * One `timedData.listMine` row as the UI's trade: every absent field becomes
 * null, and an optional field in a shape this screen cannot read is treated as
 * absent. A row missing what a trade cannot be drawn without is null: it is
 * left out, not guessed at.
 */
export function timedTradeFromRow(row: unknown): TimedTrade | null {
  if (
    !isRecord(row) ||
    !isText(row._id) ||
    !isNetwork(row.network) ||
    !isText(row.asset) ||
    !isDirection(row.direction) ||
    !isCount(row.stakeUsd) ||
    !isCount(row.leverage) ||
    !isCount(row.seconds) ||
    !(STATUSES as readonly unknown[]).includes(row.status) ||
    !isNumber(row.openedAt) ||
    !isNumber(row.expiresAt) ||
    !isDecimal(row.size) ||
    !isDecimal(row.entryPrice)
  ) {
    return null;
  }
  return {
    id: row._id,
    network: row.network,
    asset: normalizeSymbol(row.asset),
    direction: row.direction,
    stakeUsd: row.stakeUsd,
    leverage: row.leverage,
    seconds: row.seconds,
    status: row.status as TimedTradeStatus,
    openedAt: row.openedAt,
    expiresAt: row.expiresAt,
    closedAt: isNumber(row.closedAt) ? row.closedAt : null,
    endedBy: (ENDS as readonly unknown[]).includes(row.endedBy) ? (row.endedBy as TimedEnd) : null,
    size: row.size,
    entryPrice: row.entryPrice,
    exitPrice: isDecimal(row.exitPrice) ? row.exitPrice : null,
    result: isDecimal(row.result) ? row.result : null,
    fees: isDecimal(row.fees) ? row.fees : null,
    openTx: isText(row.openTx) ? row.openTx : null,
    closeTx: isText(row.closeTx) ? row.closeTx : null,
    reason: isText(row.reason) ? row.reason : null,
    origin: row.origin === 'autopilot' ? 'autopilot' : null,
    // The evidence link is only ever drawn for a trade that says autopilot opened it.
    proposalId: row.origin === 'autopilot' && isText(row.proposalId) ? row.proposalId : null,
  };
}

/** The rows a list can draw, in the order the server sent them. */
export function timedTradesFromRows(rows: readonly unknown[]): TimedTrade[] {
  const out: TimedTrade[] = [];
  for (const row of rows) {
    const trade = timedTradeFromRow(row);
    if (trade) out.push(trade);
  }
  return out;
}

/** The trade an `opened` answer states, as a running trade. Its row carries the rest when it lands. */
export function tradeFromOpened(view: TimedTradeView, network: TimedNetwork): TimedTrade {
  return {
    id: view.id,
    network,
    asset: normalizeSymbol(view.asset),
    direction: view.direction,
    stakeUsd: view.stakeUsd,
    leverage: view.leverage,
    seconds: view.seconds,
    status: 'live',
    openedAt: view.openedAt,
    expiresAt: view.expiresAt,
    closedAt: null,
    endedBy: null,
    size: view.size,
    entryPrice: view.entryPrice,
    exitPrice: null,
    result: null,
    fees: null,
    openTx: null,
    closeTx: null,
    reason: null,
    // An `opened` answer is the answer to the caller's own press: autopilot's trades arrive as rows.
    origin: null,
    proposalId: null,
  };
}

/**
 * The caller's trades with the one just opened among them. The answer to an
 * open arrives before the list has its row, and for that moment the trade is
 * drawn from the answer. Once the row is there the row is the trade: the same
 * list comes back.
 */
export function withOpened(trades: readonly TimedTrade[], opened: TimedTrade | null): readonly TimedTrade[] {
  if (!opened || trades.some((trade) => trade.id === opened.id)) return trades;
  return [opened, ...trades];
}

/** Trades the server has not closed yet, the soonest to end first. */
export function runningTrades(trades: readonly TimedTrade[]): TimedTrade[] {
  return trades.filter((trade) => trade.status !== 'closed').sort((a, b) => a.expiresAt - b.expiresAt);
}

/** When a trade ended: the server's own time for it, or the time it was due. */
export const endedAt = (trade: TimedTrade): number => trade.closedAt ?? trade.expiresAt;

/** Closed trades, the latest to end first. */
export function finishedTrades(trades: readonly TimedTrade[]): TimedTrade[] {
  return trades.filter((trade) => trade.status === 'closed').sort((a, b) => endedAt(b) - endedAt(a));
}

/**
 * The ids this screen has seen running, with any running now added. The same
 * set comes back when nothing is new, so a caller can keep it in state.
 */
export function watchRunning(watched: ReadonlySet<string>, trades: readonly TimedTrade[]): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const trade of trades) {
    if (trade.status === 'closed' || watched.has(trade.id)) continue;
    next ??= new Set(watched);
    next.add(trade.id);
  }
  return next ?? watched;
}

/** The most endings shown at once above the choices. Older ones are in the history, where every ending is. */
export const JUST_ENDED_MAX = 3;

/**
 * Trades that ended while this screen was looking at them, the latest first.
 * They are drawn where they ran, so the ending is seen in place instead of the
 * trade vanishing into the list below.
 *
 * An ending gives way once a later trade is opened on the same market: the new
 * trade is what that market is doing now. And only the latest few are kept, so
 * a run of trades never pushes the choices off the screen.
 */
export function justEnded(
  trades: readonly TimedTrade[],
  watched: ReadonlySet<string>,
  dismissed: ReadonlySet<string>,
): TimedTrade[] {
  return finishedTrades(trades)
    .filter(
      (trade) =>
        watched.has(trade.id) &&
        !dismissed.has(trade.id) &&
        !trades.some((other) => other.asset === trade.asset && other.openedAt > trade.openedAt),
    )
    .slice(0, JUST_ENDED_MAX);
}

/** What changes when the caller's running trades do. A change means a market was taken or freed: the state is read again. */
export function runningSignature(trades: readonly TimedTrade[]): string {
  return trades
    .filter((trade) => trade.status !== 'closed')
    .map((trade) => `${trade.id}:${trade.status}`)
    .sort()
    .join('|');
}

// --- Figures ------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `60` is `1m`, `3600` is `1h`. The server's own spelling of a duration. */
export function durationLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** `1 minute`, `15 minutes`, `1 hour`: a duration as a screen reader says it. */
export function durationWords(seconds: number): string {
  const [count, unit] =
    seconds % 3600 === 0 ? [seconds / 3600, 'hour'] : seconds % 60 === 0 ? [seconds / 60, 'minute'] : [seconds, 'second'];
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * `12:01:05`: a time of day on the viewer's own clock. `offsetMinutes` is the
 * zone's distance east of UTC, and defaults to the device's at that moment.
 */
export function formatClockTime(ms: number, offsetMinutes: number = -new Date(ms).getTimezoneOffset()): string {
  const d = new Date(ms + offsetMinutes * 60_000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** `58s`, `1m 02s`, `1h 00m`: how long a trade ran. */
export function formatRan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m`;
}

/** A price at the places a terminal quotes it to, rounded on its integer atoms. */
export function formatTimedPrice(price: Decimal): string {
  const dp = displayDecimals(Number(price.atoms) / 10 ** price.decimals, price.decimals);
  return formatAtoms(price.atoms, price.decimals, dp);
}

/** `+0.42 AUSD`, `−1.20 AUSD`: a signed amount of collateral at two places. */
export function formatAusd(amount: Decimal): string {
  return `${formatAtoms(amount.atoms, amount.decimals, Math.min(2, amount.decimals), { signed: true })} AUSD`;
}

/** `$25 · 5x · 1m`: what was put on a trade. */
export function termsLine(trade: Pick<TimedTrade, 'stakeUsd' | 'leverage' | 'seconds'>): string {
  return `${formatUsd(trade.stakeUsd)} · ${formatLeverage(trade.leverage)} · ${durationLabel(trade.seconds)}`;
}

export const DIRECTION_WORD: Record<TimedDirection, string> = { up: 'UP', down: 'DOWN' };

// --- A price against another --------------------------------------------------

/** How far a price is from another. A direction and a distance in price; it is never money. */
export interface PriceMove {
  direction: 'up' | 'down' | 'flat';
  /** `15.5`: the difference in price, unsigned. The direction carries the sign. */
  diff: string;
  /** `0.025%` of the price moved from, unsigned, to three places: a minute moves a price by hundredths of a percent. */
  percent: string;
  /** Whole basis points of the price moved from, signed. For ordering and tests, not for display. */
  bps: number;
}

/** `to` against `from`, on the integers. Null when `from` is not a price. */
export function priceMove(from: Decimal, to: Decimal): PriceMove | null {
  const decimals = Math.max(from.decimals, to.decimals);
  const a = BigInt(from.atoms) * 10n ** BigInt(decimals - from.decimals);
  const b = BigInt(to.atoms) * 10n ** BigInt(decimals - to.decimals);
  if (a <= 0n) return null;
  const diff = b - a;
  const magnitude = diff < 0n ? -diff : diff;
  // Thousandths of a percent, rounded half up on the integers.
  const milli = (magnitude * 100_000n * 2n + a) / (2n * a);
  const bps = Number((magnitude * 10_000n * 2n + a) / (2n * a));
  const dp = displayDecimals(Number(from.atoms) / 10 ** from.decimals, Math.min(from.decimals, to.decimals));
  return {
    direction: diff > 0n ? 'up' : diff < 0n ? 'down' : 'flat',
    diff: formatAtoms(magnitude.toString(), decimals, dp),
    percent: `${formatAtoms(milli.toString(), 3, 3)}%`,
    bps: diff < 0n ? -bps : bps,
  };
}

/** `Up 15.5 · 0.025%`, or `No change`. */
export function moveLine(move: PriceMove): string {
  if (move.direction === 'flat') return 'No change';
  return `${move.direction === 'up' ? 'Up' : 'Down'} ${move.diff} · ${move.percent}`;
}

/** Whether the price went the way that was called. Flat is neither. */
export function calledIt(direction: TimedDirection, move: PriceMove): 'as_called' | 'against' | 'flat' {
  if (move.direction === 'flat') return 'flat';
  return move.direction === direction ? 'as_called' : 'against';
}

// --- What can be opened -------------------------------------------------------

/** What the person picked. What is in force is on the view: a pick that is no longer offered falls back to one that is. */
export interface TimedWanted {
  asset: string | null;
  stakeUsd: number | null;
  seconds: number | null;
}

/** One market as a choice. */
export interface TimedMarketChoice {
  /** `BTC/USD`. */
  asset: string;
  /** `BTC`. */
  base: string;
  leverage: number;
  /** Why no trade can be opened on it now, in two words: `CLOSED`, `IN A TRADE`, `HELD`. Null when one can. */
  tag: string | null;
  /** The same as a line: `In a trade until 12:01:05`. */
  busyLine: string | null;
}

export interface TimedView {
  status: 'loading' | 'unavailable' | 'ready';
  /** `Perpl testnet · shared demo account`. Whose account a trade goes to, said plainly. */
  venueLine: string;
  /** Why trading is unavailable, in the words it came with. */
  message: string | null;
  network: TimedNetwork | null;
  markets: TimedMarketChoice[];
  /** The market in force. Null when the server lists none. */
  asset: string | null;
  stakes: number[];
  stakeUsd: number | null;
  durations: number[];
  seconds: number | null;
  /** The multiple a trade on the market in force uses. The server's, never a choice. */
  leverage: number | null;
  /** `1.00%`. */
  slippage: string | null;
  /** Why no trade can be opened right now, in one line. Null when one can. */
  hold: string | null;
  /**
   * The signed-out sample: what is here is to be looked at, the screen labels
   * it, and UP and DOWN lead to sign-in instead of sending anything.
   */
  sample: boolean;
}

/** Why a market cannot take a trade right now, as a tag and a line. Both null when it can. */
export function marketHold(market: TimedMarketView): { tag: string; line: string } | null {
  if (!market.open) return { tag: 'CLOSED', line: 'The market is closed' };
  if (!market.busy) return null;
  return market.busy.until === null
    ? { tag: 'HELD', line: 'Holds a position from the chart' }
    : { tag: 'IN A TRADE', line: `In a trade until ${formatClockTime(market.busy.until)}` };
}

const sameAsset = (a: string, b: string): boolean => normalizeSymbol(a) === normalizeSymbol(b);

/**
 * What the screen draws to choose a trade, from the state as last read and what
 * the person picked. Loading or unavailable, it offers nothing: stakes,
 * durations and leverage come from the server, and until they are read there is
 * nothing true to offer.
 *
 * With no pair picked it is the first one that can take a trade, so the screen
 * opens on something that can be sent. A pair that is picked stays picked while
 * it is busy: the screen then says why, and when it frees.
 */
export function timedView(state: TimedState, wanted: TimedWanted): TimedView {
  if (state.status !== 'ready') {
    return {
      status: state.status,
      venueLine: 'Perpl · shared demo account',
      message: state.status === 'unavailable' ? state.message : null,
      network: null,
      markets: [],
      asset: null,
      stakes: [],
      stakeUsd: null,
      durations: [],
      seconds: null,
      leverage: null,
      slippage: null,
      hold: state.status === 'unavailable' ? state.message : 'Reading what can be traded.',
      sample: false,
    };
  }

  const { limits } = state;
  const picked = wanted.asset === null ? undefined : state.markets.find((m) => sameAsset(m.asset, wanted.asset ?? ''));
  const market = picked ?? state.markets.find((m) => marketHold(m) === null) ?? state.markets[0] ?? null;
  const stakeUsd = chosenOption(limits.stakesUsd, wanted.stakeUsd);
  const seconds = chosenOption(limits.durations, wanted.seconds);

  let hold: string | null = null;
  if (!market) hold = 'No market is listed for timed trades right now.';
  else if (!market.open) hold = `The ${baseOf(market.asset)} market is closed.`;
  else if (market.busy) {
    hold =
      market.busy.until === null
        ? `${baseOf(market.asset)} holds a position opened from the chart. A market holds one position at a time.`
        : `${baseOf(market.asset)} is in a trade until ${formatClockTime(market.busy.until)}. A market takes one timed trade at a time.`;
  } else if (stakeUsd === null) hold = 'No stake is on offer right now.';
  else if (seconds === null) hold = 'No duration is on offer right now.';

  return {
    status: 'ready',
    venueLine: `Perpl ${state.network} · shared demo account`,
    message: null,
    network: state.network,
    markets: state.markets.map((m) => {
      const held = marketHold(m);
      return {
        asset: normalizeSymbol(m.asset),
        base: baseOf(m.asset),
        leverage: m.leverage,
        tag: held?.tag ?? null,
        busyLine: held?.line ?? null,
      };
    }),
    asset: market ? normalizeSymbol(market.asset) : null,
    stakes: limits.stakesUsd,
    stakeUsd,
    durations: limits.durations,
    seconds,
    leverage: market ? market.leverage : null,
    slippage: formatBps(limits.slippageBps),
    hold,
    sample: state.sample === true,
  };
}

/** `Whose account this is`, in a sentence. Said once on the screen, as the order ticket says it. */
export function accountNote(network: TimedNetwork | null): string {
  return network === 'testnet' || network === null
    ? 'Every trade goes to one account that everyone signed in shares. It holds testnet funds, not yours.'
    : 'Every trade goes to one account that everyone signed in shares. Its funds are not yours.';
}

/**
 * What the choice means before it is sent, label then value: the size it opens,
 * that it closes itself after the time chosen, the most it can lose (and that
 * a trade which has lost that much is ended early), and how far from the mark
 * price it may fill. Every figure is the server's. Empty until they are known.
 */
export function choiceFacts(view: TimedView): Array<[label: string, value: string]> {
  if (view.stakeUsd === null || view.seconds === null || view.leverage === null || view.slippage === null) return [];
  return [
    ['Size', `${formatUsd(view.stakeUsd * view.leverage)}, ${formatLeverage(view.leverage)} the stake`],
    ['Closes itself', `after ${durationLabel(view.seconds)}`],
    ['Most it can lose', `${formatUsd(view.stakeUsd)}, ended early at that loss`],
    ['Max slippage', `${view.slippage} in and out`],
  ];
}

/** What the stake rule does, in a sentence. Said where the trades are listed, so the early ending is no surprise. */
export const CUT_NOTE = 'If the loss at the mark price reaches the stake, the server ends the trade early.';

// --- Sending ------------------------------------------------------------------

/** What UP or DOWN says to a screen reader: `Open up on BTC, 25 dollars, 1 minute`. */
export function openLabel(request: TimedRequest): string {
  const stake = `${Math.trunc(request.stakeUsd)} dollars`;
  return `Open ${request.direction} on ${baseOf(request.asset)}, ${stake}, ${durationWords(request.seconds)}`;
}

/** The request the choices in force make on one side, or null while they make none. A sample makes none: nothing is sent with it. */
export function requestOf(view: TimedView, direction: TimedDirection): TimedRequest | null {
  if (view.sample || view.hold !== null || view.asset === null || view.stakeUsd === null || view.seconds === null) return null;
  return { asset: view.asset, direction, stakeUsd: view.stakeUsd, seconds: view.seconds };
}

/** What a screen says while something is out. */
export function sendingLine(sending: Exclude<TimedSending, null>): string {
  if (sending.action === 'close') return 'Asking the server to end the trade…';
  return `Opening ${baseOf(sending.asset)} ${sending.direction}, ${formatUsd(sending.stakeUsd)} for ${durationLabel(sending.seconds)}…`;
}

/** UP or DOWN as the screen offers it. */
export interface DirectionAction {
  direction: TimedDirection;
  /** `UP`, `DOWN`. Beside its arrow: direction never rests on colour alone. */
  word: string;
  /** What a press sends, or the direction and why it is off. */
  accessibilityLabel: string;
  disabled: boolean;
  /** This direction's order is the one on its way. */
  sending: boolean;
}

/** What the signed-out sample says where a slide would say whose account a trade goes to. The way to sign in follows it. */
export const SAMPLE_LEAD = 'Sample prices.';

/**
 * One of the two primary actions. `locked` is something on its way, or an
 * answer whose state read has not landed yet.
 *
 * On the signed-out sample the action is on and opens nothing: the screen sends
 * its press to sign-in, and its name says so instead of naming an order.
 */
export function directionAction(
  view: TimedView,
  direction: TimedDirection,
  sending: TimedSending,
  locked: boolean,
): DirectionAction {
  const word = DIRECTION_WORD[direction];
  if (view.sample) {
    const name = direction === 'up' ? 'Up' : 'Down';
    return { direction, word, accessibilityLabel: `${name}. A sample: sign in to trade.`, disabled: false, sending: false };
  }
  if (sending?.action === 'open' && sending.direction === direction) {
    return { direction, word, accessibilityLabel: sendingLine(sending), disabled: true, sending: true };
  }
  const request = requestOf(view, direction);
  if (!request) {
    const name = direction === 'up' ? 'Up' : 'Down';
    return { direction, word, accessibilityLabel: `${name}. ${view.hold ?? ''}`.trim(), disabled: true, sending: false };
  }
  return { direction, word, accessibilityLabel: openLabel(request), disabled: locked, sending: false };
}

// --- An answer that is not a trade --------------------------------------------

/**
 * What the server said when it opened nothing, or would not end a trade. Its
 * own sentence, unchanged, set the same way whatever it says: a refusal is the
 * limits doing their job, so it is labelled like any other answer.
 */
export interface TimedOutcomeView {
  status: Exclude<TimedOpenResult['status'], 'opened'>;
  /** `REFUSED`, `NOT FILLED`, `SENT`, `BUSY`, `UNAVAILABLE`, `RATE LIMITED`. */
  label: string;
  /** `BTC/USD · UP · $25 · 1m`: what was asked for. */
  context: string;
  /** The server's sentence. */
  text: string;
  /** `BTC/USD`: the pair it was asked on. The answer is shown on that pair's slides. */
  asset: string;
  /** The time it was asked for, or null for a request to end a trade, which concerns every slide of the pair. */
  seconds: number | null;
}

const OUTCOME_LABEL: Record<TimedOutcomeView['status'], string> = {
  refused: 'REFUSED',
  unfilled: 'NOT FILLED',
  // Sent, and that is all that is known. Not a trade and not a fault.
  pending: 'SENT',
  busy: 'BUSY',
  unavailable: 'UNAVAILABLE',
  rate_limited: 'RATE LIMITED',
};

/** An open's answer as the screen shows it in place. Null for a trade that opened: the trade itself is the answer. */
export function openOutcomeView(result: TimedOpenResult, request: TimedRequest): TimedOutcomeView | null {
  if (result.status === 'opened') return null;
  return {
    status: result.status,
    label: OUTCOME_LABEL[result.status],
    context: [
      normalizeSymbol(request.asset),
      DIRECTION_WORD[request.direction],
      formatUsd(request.stakeUsd),
      durationLabel(request.seconds),
    ].join(' · '),
    text: result.status === 'refused' ? result.reason : result.message,
    asset: normalizeSymbol(request.asset),
    seconds: request.seconds,
  };
}

/** An early end's answer. Null when the server took it: the trade's own row then says it is closing. */
export function closeOutcomeView(result: TimedCloseResult, trade: Pick<TimedTrade, 'asset' | 'direction'>): TimedOutcomeView | null {
  if (result.status === 'closing') return null;
  return {
    status: result.status,
    label: OUTCOME_LABEL[result.status],
    context: `${normalizeSymbol(trade.asset)} · ${DIRECTION_WORD[trade.direction]} · END NOW`,
    text: result.status === 'refused' ? result.reason : result.message,
    asset: normalizeSymbol(trade.asset),
    seconds: null,
  };
}

/**
 * What a live region says when a trade opens: `Opened up on BTC. It closes itself at 12:01:05.`
 * One autopilot opened says so, since nobody on this screen pressed anything for it.
 */
export function openedLine(
  trade: Pick<TimedTrade, 'asset' | 'direction' | 'expiresAt'> & { origin?: TimedTrade['origin'] | undefined },
): string {
  const opened = trade.origin === 'autopilot' ? 'Autopilot opened' : 'Opened';
  return `${opened} ${trade.direction} on ${baseOf(trade.asset)}. It closes itself at ${formatClockTime(trade.expiresAt)}.`;
}

// --- A running trade ----------------------------------------------------------

/** Milliseconds a trade has left. Never negative. */
export function timeLeftMs(expiresAt: number, nowMs: number): number {
  return Math.max(0, expiresAt - nowMs);
}

/** `00:42`, `14:59`, `1:00:00`. A second that has started counts until it has passed, so it reaches `00:00` exactly on time. */
export function countdownText(expiresAt: number, nowMs: number): string {
  if (nowMs <= 0) return '--:--';
  return formatCountdown(Math.ceil(timeLeftMs(expiresAt, nowMs) / 1000));
}

/** How much of its time a trade has used, from 0 to 1. */
export function elapsedFraction(openedAt: number, expiresAt: number, nowMs: number): number {
  const total = expiresAt - openedAt;
  if (!(total > 0) || nowMs <= 0) return 0;
  return Math.min(1, Math.max(0, (nowMs - openedAt) / total));
}

export interface RunningView {
  id: string;
  /** `BTC/USD`. */
  asset: string;
  direction: TimedDirection;
  /** `UP`. */
  word: string;
  /** `$25 · 5x · 1m`. */
  terms: string;
  /** `RUNNING`, or `CLOSING` once the server is closing it or its time has passed. */
  label: string;
  /** The trade is past the point where it can be ended by hand. */
  closing: boolean;
  /** `Closes at 12:01:05`. Short: it sits under the countdown, beside the prices, on a narrow phone. */
  closesAt: string;
  /** Why closing is taking a while, in the server's words, or that its time is up. Null while it simply runs. */
  note: string | null;
  /** `61,234.5`. */
  entry: string;
  /** `0.00041 BTC`. */
  size: string;
  /** The opening transaction, once its row carries it: the evidence for the entry, one press away. */
  openTx: TxRef | null;
  end: {
    /** `END NOW`, `ENDING…`, `CLOSING…`. */
    label: string;
    /** `End the BTC up trade now`. */
    accessibilityLabel: string;
    disabled: boolean;
  };
}

/**
 * One running trade as its card draws it. The countdown is not here: it moves
 * every second, and a part that moves is drawn by a part that subscribes to the
 * clock (`countdownText`), so the card around it stays still.
 *
 * `due` is the time having passed without the row closing yet. `asked` is the
 * server having taken a request to end it, in the moment before its row says so.
 */
export function runningView(
  trade: TimedTrade,
  opts: { due: boolean; sending: TimedSending; locked: boolean; asked?: boolean | undefined },
): RunningView {
  const base = baseOf(trade.asset);
  const ending = opts.sending?.action === 'close' && opts.sending.tradeId === trade.id;
  const closing = trade.status === 'closing' || opts.due || opts.asked === true;
  return {
    id: trade.id,
    asset: trade.asset,
    direction: trade.direction,
    word: DIRECTION_WORD[trade.direction],
    terms: termsLine(trade),
    label: closing ? 'CLOSING' : 'RUNNING',
    closing,
    closesAt: `Closes at ${formatClockTime(trade.expiresAt)}`,
    note: trade.reason ?? (opts.due && trade.status === 'live' ? TIME_IS_UP : null),
    entry: formatTimedPrice(trade.entryPrice),
    size: formatVenueSize(trade.size, trade.asset),
    openTx: trade.openTx ? venueTx(trade.network, trade.openTx) : null,
    end: {
      label: ending ? 'ENDING…' : closing ? 'CLOSING…' : 'END NOW',
      accessibilityLabel: closing
        ? `The ${base} ${trade.direction} trade is closing`
        : `End the ${base} ${trade.direction} trade now`,
      disabled: closing || opts.locked,
    },
  };
}

/** A running trade's entry against the price now. Null until there is a price to read it against. */
export function liveMove(trade: Pick<TimedTrade, 'entryPrice'>, price: Decimal | null): { price: string; move: PriceMove } | null {
  if (!price) return null;
  const move = priceMove(trade.entryPrice, price);
  return move ? { price: formatTimedPrice(price), move } : null;
}

// --- A finished trade ---------------------------------------------------------

const END_LABEL: Record<TimedEnd, string> = {
  time: 'TIME UP',
  cut: 'CUT',
  owner: 'ENDED EARLY',
  venue: 'CLOSED ELSEWHERE',
};

const END_LINE: Record<TimedEnd, string> = {
  time: 'Its time was up, so the server closed it.',
  cut: 'It had lost its stake at the mark price, so the server ended it early.',
  owner: 'You ended it before its time.',
  venue: 'The position was already gone: closed from the chart, or liquidated by the venue.',
};

export interface FinishedView {
  id: string;
  asset: string;
  direction: TimedDirection;
  word: string;
  terms: string;
  /** `TIME UP`, `CUT`, `ENDED EARLY`, `CLOSED ELSEWHERE`. How it ended. */
  ended: string;
  /** The same in a sentence. */
  endedLine: string;
  entry: string;
  /** The exit price, or `Not reported yet` for the few seconds after it closes. */
  exit: string;
  /** Entry against exit. Null until the exit price is reported. */
  move: PriceMove | null;
  /** `Moved up, as called.`, `Moved down, against the call.`, or `Not reported yet`. */
  called: string;
  /** The exit price and the result have not arrived yet. */
  awaiting: boolean;
  /** Milliseconds it ended. */
  at: number;
  /** `Up on BTC/USD, time up. Moved up, as called. Open the details.` */
  accessibilityLabel: string;
}

/** `Moved up, as called.` */
export function calledLine(direction: TimedDirection, move: PriceMove | null): string {
  if (!move) return NOT_REPORTED_YET;
  const called = calledIt(direction, move);
  if (called === 'flat') return 'The price did not move.';
  return `Moved ${move.direction}, ${called === 'as_called' ? 'as called' : 'against the call'}.`;
}

/**
 * A finished trade as its row and its card draw it: what was called and what
 * the price did. No money: the result is in `finishedDetail`, one press away.
 */
export function finishedView(trade: TimedTrade): FinishedView {
  const move = trade.exitPrice ? priceMove(trade.entryPrice, trade.exitPrice) : null;
  const ended = trade.endedBy ? END_LABEL[trade.endedBy] : 'CLOSED';
  const called = calledLine(trade.direction, move);
  return {
    id: trade.id,
    asset: trade.asset,
    direction: trade.direction,
    word: DIRECTION_WORD[trade.direction],
    terms: termsLine(trade),
    ended,
    endedLine: trade.endedBy ? END_LINE[trade.endedBy] : 'It is closed.',
    entry: formatTimedPrice(trade.entryPrice),
    exit: trade.exitPrice ? formatTimedPrice(trade.exitPrice) : NOT_REPORTED_YET,
    move,
    called,
    awaiting: trade.exitPrice === null,
    at: endedAt(trade),
    accessibilityLabel:
      `${trade.direction === 'up' ? 'Up' : 'Down'} on ${trade.asset}, ${ended.toLowerCase()}. ` +
      `${trade.exitPrice ? called : 'The exit price is not reported yet.'} Open the details.`,
  };
}

export interface FinishedDetail {
  /** Label then value. The result is here and nowhere else on the screen. */
  facts: Array<[label: string, value: string]>;
  /** The evidence: the opening and the closing transaction. */
  openTx: TxRef | null;
  closeTx: TxRef | null;
}

/**
 * Everything about a finished trade, for its detail sheet. This is the one
 * place the money result is stated, in the neutral way every other figure is:
 * a row among rows.
 */
export function finishedDetail(trade: TimedTrade): FinishedDetail {
  const move = trade.exitPrice ? priceMove(trade.entryPrice, trade.exitPrice) : null;
  const closed = endedAt(trade);
  return {
    facts: [
      ['Opened', formatClockTime(trade.openedAt)],
      ['Closed', formatClockTime(closed)],
      ['Ran for', formatRan(closed - trade.openedAt)],
      ['Stake', formatUsd(trade.stakeUsd)],
      ['Size', `${formatVenueSize(trade.size, trade.asset)} · ${formatLeverage(trade.leverage)}`],
      ['Entry', formatTimedPrice(trade.entryPrice)],
      ['Exit', trade.exitPrice ? formatTimedPrice(trade.exitPrice) : NOT_REPORTED_YET],
      ['Price move', move ? moveLine(move) : NOT_REPORTED_YET],
      ['Result after fees', trade.result ? formatAusd(trade.result) : NOT_REPORTED_YET],
      trade.fees ? feeFact(trade.fees) : ['Fees', NOT_REPORTED_YET],
    ],
    openTx: trade.openTx ? venueTx(trade.network, trade.openTx) : null,
    closeTx: trade.closeTx ? venueTx(trade.network, trade.closeTx) : null,
  };
}

// --- When to read the state again ---------------------------------------------

/** A market is read again this long after the trade holding it was due to end. */
export const BUSY_GRACE_MS = 1_500;
/** A market still held after its trade was due is read again this often, a few times. */
export const OVERDUE_RECHECK_MS = 5_000;
/** How many times in a row an overdue market is read again before the slow interval is left to it. */
export const OVERDUE_RECHECKS = 6;

/**
 * How long until the state is worth reading again, from the markets it says are
 * busy: just after the soonest trade holding one is due to end. A trade already
 * due and still holding its market is read again after a short wait. Null when
 * no market is waiting on a trade.
 */
export function stateRecheck(state: TimedState, nowMs: number): { delayMs: number; overdue: boolean } | null {
  if (state.status !== 'ready') return null;
  let soonest: number | null = null;
  let overdue = false;
  for (const market of state.markets) {
    const until = market.busy?.until;
    if (until === null || until === undefined) continue;
    if (until + BUSY_GRACE_MS <= nowMs) overdue = true;
    else soonest = soonest === null ? until : Math.min(soonest, until);
  }
  if (overdue) return { delayMs: OVERDUE_RECHECK_MS, overdue: true };
  return soonest === null ? null : { delayMs: Math.max(0, soonest + BUSY_GRACE_MS - nowMs), overdue: false };
}
