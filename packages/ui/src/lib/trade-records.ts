import type { Decimal } from '@kanon/spec';
import { normalizeSymbol } from './chart-assets';
import { formatAtoms } from './chart-format';
import {
  endedAt,
  finishedView,
  formatAusd,
  formatRan,
  formatTimedPrice,
  moveLine,
  priceMove,
  termsLine,
  type PriceMove,
} from './timed-trade';
import { stampLabel } from './profile-logic';
import type { TimedTrade } from './timed-types';
import { NOT_REPORTED_YET, formatLeverage, formatUsd, formatVenueSize, venueTx, type TxRef } from './venue-trade';
import type { VenueNetwork, VenueOrder, VenueSide } from './venue-types';

/**
 * A person's own trades from the chart's ticket, worked out from their orders.
 *
 * The server records orders, not trades: one row for each open, each add and
 * each close. A trader thinks in positions, so this pairs them: every filled
 * open on a market, up to the close that followed, is one chart trade with an
 * entry, an exit and the transactions behind both.
 *
 * Pure: no React, no clock, no I/O, and every figure stays an integer, so each
 * rule here is pinned down in `trade-records.test.ts`. A trade's result in AUSD
 * exists only in `chartTradeDetail`, which a screen shows one press away from
 * the list; a row says a direction and two prices and never money.
 *
 * Orders are the caller's own, but they all go to one shared account. A
 * position somebody else closed leaves no close among the caller's orders, and
 * this says so (`ended elsewhere`) once a later order shows it must have ended,
 * instead of guessing an exit.
 */

/** The collateral's decimals: AUSD. A result is stated in it. */
const COLLATERAL_DECIMALS = 6;

// --- Orders a timed trade placed ----------------------------------------------

/** How long before a timed trade's entry its opening order may have been recorded. */
export const TIMED_OPEN_LEAD_MS = 60_000;
/** Slack for two clocks: the server stamps an order, the gateway stamps a trade. */
export const CLOCK_SLACK_MS = 10_000;

/**
 * The ids of the orders that belong to a timed trade. A timed trade opens and
 * closes its position through the same order path as the chart's ticket, so
 * each one leaves two orders (and one more for every close it had to retry).
 * Listed beside the trade they would count it three times.
 *
 * An order is a timed trade's when it carries one of the trade's two
 * transactions, when it is the newest open recorded in the minute before the
 * trade began, or when it landed on the trade's market while the trade held it
 * (a market takes one timed trade at a time and none while the chart holds a
 * position there).
 */
export function timedOrderIds(orders: readonly VenueOrder[], trades: readonly TimedTrade[]): Set<string> {
  const ids = new Set<string>();
  for (const trade of trades) {
    const market = normalizeSymbol(trade.asset);
    const end = trade.status === 'closed' ? endedAt(trade) : Number.POSITIVE_INFINITY;
    let opening: VenueOrder | null = null;
    for (const order of orders) {
      if (normalizeSymbol(order.asset) !== market) continue;
      if (order.txHash && (order.txHash === trade.openTx || order.txHash === trade.closeTx)) {
        ids.add(order.id);
        continue;
      }
      const at = order.createdAt;
      if (order.action === 'open' && at >= trade.openedAt - TIMED_OPEN_LEAD_MS && at <= trade.openedAt + CLOCK_SLACK_MS) {
        if (!opening || at > opening.createdAt) opening = order;
      } else if (at > trade.openedAt && at <= end + CLOCK_SLACK_MS) {
        // After the trade ended only its own close can still be on this market: a new open is a new trade.
        if (at <= end || order.action === 'close') ids.add(order.id);
      }
    }
    if (opening) ids.add(opening.id);
  }
  return ids;
}

// --- Pairing orders into trades -----------------------------------------------

export type ChartTradeStatus =
  /** Still held, as far as the caller's own orders say. */
  | 'open'
  | 'closed'
  /** A later order shows the position ended, and its close is not among the caller's orders. */
  | 'ended_elsewhere';

/** One position taken from the chart's ticket: the orders that built it and the one that closed it. */
export interface ChartTrade {
  /** The first order's id. Stable while the trade gains adds and its close. */
  id: string;
  network: VenueNetwork;
  /** `BTC/USD`. */
  asset: string;
  /** Null only for a close whose side the server never read. */
  side: VenueSide | null;
  status: ChartTradeStatus;
  /** Filled opens and adds, oldest first. Empty when the caller closed a position they did not open. */
  opens: VenueOrder[];
  close: VenueOrder | null;
  /** The opens' sizes added up, or the close's size when there are no opens. Null while one is not reported. */
  size: Decimal | null;
  /** The opens' fill prices, weighted by size. Null while a fill's price is not reported, or with no opens. */
  entryPrice: Decimal | null;
  exitPrice: Decimal | null;
  /** The first open's multiple. */
  leverage: number | null;
  /** Whole dollars asked for across the opens. Null when no open said. */
  notionalUsd: number | null;
  /** Milliseconds. */
  openedAt: number;
  closedAt: number | null;
}

const scale = (d: Decimal, decimals: number): bigint => BigInt(d.atoms) * 10n ** BigInt(decimals - d.decimals);

/** Sizes added up at the finest scale among them. Null when one is missing. */
function sumSizes(orders: readonly VenueOrder[]): Decimal | null {
  if (orders.length === 0) return null;
  let decimals = 0;
  for (const o of orders) {
    if (!o.size) return null;
    decimals = Math.max(decimals, o.size.decimals);
  }
  let total = 0n;
  for (const o of orders) total += scale(o.size as Decimal, decimals);
  return { atoms: total.toString(), decimals };
}

/**
 * The size-weighted average fill price of several orders, rounded half up on
 * the integers at the finest price scale among them. Null when a fill has no
 * price or size yet: an average over the fills that happen to be reported would
 * be a different number a few seconds later.
 */
export function averageEntry(orders: readonly VenueOrder[]): Decimal | null {
  if (orders.length === 0) return null;
  let sizeDecimals = 0;
  let priceDecimals = 0;
  for (const o of orders) {
    if (!o.size || !o.fillPrice) return null;
    sizeDecimals = Math.max(sizeDecimals, o.size.decimals);
    priceDecimals = Math.max(priceDecimals, o.fillPrice.decimals);
  }
  // Both sums are `const`, from `reduce`, on purpose. Written as `let total = 0n` filled in a loop,
  // the division below breaks the production build: Next's file tracer folds constants, takes
  // `total` for the `0n` it starts as, and throws "Division by zero" while collecting page data.
  const sizes = orders.map((o) => scale(o.size as Decimal, sizeDecimals));
  const total = sizes.reduce((sum, size) => sum + size, BigInt(0));
  const weighted = orders.reduce(
    (sum, o, i) => sum + (sizes[i] ?? BigInt(0)) * scale(o.fillPrice as Decimal, priceDecimals),
    BigInt(0),
  );
  if (total <= 0n) return null;
  return { atoms: ((weighted * 2n + total) / (2n * total)).toString(), decimals: priceDecimals };
}

interface Lot {
  side: VenueSide | null;
  opens: VenueOrder[];
}

function finish(lot: Lot, close: VenueOrder | null, status: ChartTradeStatus): ChartTrade {
  const first = lot.opens[0] ?? close;
  if (!first) throw new Error('a chart trade needs an order');
  const asked = lot.opens.map((o) => o.notionalUsd);
  return {
    id: first.id,
    network: first.network,
    asset: first.asset,
    side: lot.side ?? close?.side ?? null,
    status,
    opens: lot.opens,
    close,
    size: lot.opens.length > 0 ? sumSizes(lot.opens) : (close?.size ?? null),
    entryPrice: averageEntry(lot.opens),
    exitPrice: close?.fillPrice ?? null,
    leverage: lot.opens[0]?.leverage ?? null,
    notionalUsd: asked.length > 0 && asked.every((usd) => usd !== null) ? asked.reduce<number>((sum, usd) => sum + (usd ?? 0), 0) : null,
    openedAt: first.createdAt,
    closedAt: close ? (close.settledAt ?? close.createdAt) : null,
  };
}

/**
 * The caller's chart trades, newest first, from their orders in any order.
 * `timed` is the caller's timed trades: the orders those placed are left out,
 * since each is listed as the timed trade it belongs to.
 *
 * Only a filled order moves a position, so only filled orders are read. On each
 * market, oldest first: an open starts a trade or adds to the one being held, a
 * close ends it. An open on the other side of a trade still held means that
 * trade ended without the caller's own close (the server refuses the other side
 * while a position is held), and it is marked so with no exit.
 */
export function chartTrades(orders: readonly VenueOrder[], timed: readonly TimedTrade[] = []): ChartTrade[] {
  const skip = timedOrderIds(orders, timed);
  const byMarket = new Map<string, VenueOrder[]>();
  for (const order of orders) {
    if (order.status !== 'filled' || skip.has(order.id)) continue;
    const market = normalizeSymbol(order.asset);
    const list = byMarket.get(market);
    if (list) list.push(order);
    else byMarket.set(market, [order]);
  }

  const out: ChartTrade[] = [];
  for (const list of byMarket.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt);
    let lot: Lot | null = null;
    for (const order of list) {
      if (order.action === 'open') {
        if (lot && lot.side !== null && order.side !== null && lot.side !== order.side) {
          out.push(finish(lot, null, 'ended_elsewhere'));
          lot = null;
        }
        if (!lot) lot = { side: order.side, opens: [] };
        lot.opens.push(order);
      } else {
        out.push(finish(lot ?? { side: order.side, opens: [] }, order, 'closed'));
        lot = null;
      }
    }
    if (lot) out.push(finish(lot, null, 'open'));
  }
  return out.sort((a, b) => b.openedAt - a.openedAt);
}

// --- A trade's result ---------------------------------------------------------

export interface ChartResult {
  /** AUSD, signed. After fees when `fees` is known, before them otherwise. */
  amount: Decimal;
  /** Every order's fee added up, or null while one is not reported. Negative is a rebate. */
  fees: Decimal | null;
}

/**
 * What a closed trade came to: the exit against the entry, times the size the
 * caller opened, less the fees of every order in it. Integer arithmetic over
 * the recorded fills, truncated toward zero at AUSD's six decimals. Null until
 * the entry, the exit and the size are all reported.
 */
export function chartResult(trade: ChartTrade): ChartResult | null {
  if (trade.status !== 'closed' || !trade.side || !trade.size || !trade.entryPrice || !trade.exitPrice) return null;
  if (trade.opens.length === 0) return null;
  const priceDecimals = Math.max(trade.entryPrice.decimals, trade.exitPrice.decimals);
  const diff = scale(trade.exitPrice, priceDecimals) - scale(trade.entryPrice, priceDecimals);
  const signed = trade.side === 'long' ? diff : -diff;
  const gross =
    (signed * BigInt(trade.size.atoms) * 10n ** BigInt(COLLATERAL_DECIMALS)) /
    10n ** BigInt(priceDecimals + trade.size.decimals);

  let fees: bigint | null = 0n;
  for (const order of [...trade.opens, trade.close]) {
    if (!order?.fee || order.fee.decimals > COLLATERAL_DECIMALS) {
      fees = null;
      break;
    }
    fees += scale(order.fee, COLLATERAL_DECIMALS);
  }
  return {
    amount: { atoms: (fees === null ? gross : gross - fees).toString(), decimals: COLLATERAL_DECIMALS },
    fees: fees === null ? null : { atoms: fees.toString(), decimals: COLLATERAL_DECIMALS },
  };
}

// --- What a row and a sheet say -----------------------------------------------

const SIDE_LABEL: Record<VenueSide, string> = { long: 'Long', short: 'Short' };

export const CHART_STATE_LABEL: Record<ChartTradeStatus, string> = {
  open: 'OPEN',
  closed: 'CLOSED',
  ended_elsewhere: 'ENDED ELSEWHERE',
};

const STATE_LINE: Record<ChartTradeStatus, string> = {
  open: 'Still held, as far as your own orders say. The account is shared: anyone signed in can close it.',
  closed: 'You closed it at market.',
  ended_elsewhere: 'It ended without a close of yours: closed by someone else on the shared account, or by the venue.',
};

export interface ChartTradeView {
  id: string;
  /** `BTC/USD`. */
  asset: string;
  side: VenueSide | null;
  /** `Long`, `Short`, or `Position` when the side was never read. */
  sideWord: string;
  /** `OPEN`, `CLOSED`, `ENDED ELSEWHERE`. */
  state: string;
  /** The same in a sentence. */
  stateLine: string;
  /** `$50 · 5x`, or null when the opens did not say. */
  terms: string | null;
  /** `0.00074 BTC`, or null while a fill's size is not reported. */
  size: string | null;
  /** The entry price, `Not reported yet`, or null for a close with no open of the caller's. */
  entry: string | null;
  /** The exit price, `Not reported yet` on a close that has not said, or null while there is no close. */
  exit: string | null;
  /** Entry against exit. Null until both are known. */
  move: PriceMove | null;
  /** Milliseconds it was opened. */
  at: number;
  /** `Long on BTC/USD, closed. Entry 67,120.50, exit 67,180.00. Open the details.` */
  accessibilityLabel: string;
}

/** One chart trade as a row of a list. Never money: a direction, a state and two prices. */
export function chartTradeView(trade: ChartTrade): ChartTradeView {
  const sideWord = trade.side ? SIDE_LABEL[trade.side] : 'Position';
  const state = CHART_STATE_LABEL[trade.status];
  const entry =
    trade.opens.length === 0 ? null : trade.entryPrice ? formatTimedPrice(trade.entryPrice) : NOT_REPORTED_YET;
  const exit = trade.close ? (trade.exitPrice ? formatTimedPrice(trade.exitPrice) : NOT_REPORTED_YET) : null;
  const asset = normalizeSymbol(trade.asset);
  const prices = [entry ? `Entry ${entry}` : null, exit ? `exit ${exit}` : null].filter(Boolean).join(', ');
  return {
    id: trade.id,
    asset,
    side: trade.side,
    sideWord,
    state,
    stateLine: STATE_LINE[trade.status],
    terms:
      trade.notionalUsd !== null && trade.leverage !== null
        ? `${formatUsd(trade.notionalUsd)} · ${formatLeverage(trade.leverage)}`
        : null,
    size: trade.size ? formatVenueSize(trade.size, trade.asset) : null,
    entry,
    exit,
    move: trade.entryPrice && trade.exitPrice ? priceMove(trade.entryPrice, trade.exitPrice) : null,
    at: trade.openedAt,
    accessibilityLabel: `${sideWord} on ${asset}, ${state.toLowerCase()}.${prices ? ` ${prices}.` : ''} Open the details.`,
  };
}

export interface ChartTradeDetail {
  /** Label then value. The result is here and nowhere else. */
  facts: Array<[label: string, value: string]>;
  /** The evidence: each order's settling transaction, oldest first. Null where the venue has not reported one yet. */
  txs: Array<{ name: string; tx: TxRef | null }>;
}

/** A fee total: a rebate is called one, not shown as a negative fee. */
function feesFact(fees: Decimal): [string, string] {
  const rebate = fees.atoms.startsWith('-');
  const magnitude = rebate ? fees.atoms.slice(1) : fees.atoms;
  return [rebate ? 'Rebates' : 'Fees', `${formatAtoms(magnitude, fees.decimals, 4)} AUSD`];
}

/** Everything about one chart trade: its figures as a table, the result among them, and every transaction. */
export function chartTradeDetail(trade: ChartTrade): ChartTradeDetail {
  const view = chartTradeView(trade);
  const result = chartResult(trade);
  // A record is read days later, so a time alone is not enough: the day too, in UTC like the list it opens from.
  const facts: Array<[string, string]> = [['Opened', `${stampLabel(trade.openedAt)} UTC`]];
  if (trade.closedAt !== null) {
    facts.push(['Closed', `${stampLabel(trade.closedAt)} UTC`], ['Held for', formatRan(trade.closedAt - trade.openedAt)]);
  }
  if (trade.opens.length > 1) facts.push(['Orders in', String(trade.opens.length)]);
  if (view.terms) facts.push(['Asked for', view.terms]);
  facts.push(['Size', view.size ?? NOT_REPORTED_YET]);
  if (view.entry) facts.push([trade.opens.length > 1 ? 'Average entry' : 'Entry', view.entry]);
  if (trade.close) {
    facts.push(['Exit', view.exit ?? NOT_REPORTED_YET]);
    // The close takes the whole position, which is everyone's on a shared account.
    if (trade.close.size && trade.size && trade.opens.length > 0 && !scaleEqual(trade.close.size, trade.size)) {
      facts.push(['Size closed', formatVenueSize(trade.close.size, trade.asset)]);
    }
    if (trade.opens.length > 0) {
      facts.push(['Price move', view.move ? moveLine(view.move) : NOT_REPORTED_YET]);
      facts.push([
        result?.fees === null ? 'Result before fees' : 'Result after fees',
        result ? formatAusd(result.amount) : NOT_REPORTED_YET,
      ]);
      facts.push(result?.fees ? feesFact(result.fees) : ['Fees', NOT_REPORTED_YET]);
    }
  }

  const txOf = (order: VenueOrder) => (order.txHash ? venueTx(order.network, order.txHash) : null);
  const txs = trade.opens.map((order, i) => ({ name: i === 0 ? 'Open' : `Add ${i}`, tx: txOf(order) }));
  if (trade.close) txs.push({ name: 'Close', tx: txOf(trade.close) });
  return { facts, txs };
}

function scaleEqual(a: Decimal, b: Decimal): boolean {
  const decimals = Math.max(a.decimals, b.decimals);
  return scale(a, decimals) === scale(b, decimals);
}

// --- The two figures on a row's right -----------------------------------------

/** What a record row carries on its right: the entry, and under it the exit or the state. Never money. */
export interface RowFigures {
  value: string;
  sub: string;
}

/** Said under an entry whose trade has closed and whose exit the venue has not reported yet. */
export const EXIT_PENDING = 'PENDING';

function rowFigures(entry: string | null, exit: string | null, state: string): RowFigures {
  // A close with no open of the caller's has only an exit to show.
  if (entry === null) return { value: exit === null || exit === NOT_REPORTED_YET ? '—' : exit, sub: state };
  if (exit === null) return { value: entry, sub: state };
  return { value: entry, sub: exit === NOT_REPORTED_YET ? EXIT_PENDING : `→ ${exit}` };
}

export function chartRowFigures(view: ChartTradeView): RowFigures {
  return rowFigures(view.entry, view.exit, view.state);
}

// --- A timed trade in the same list -------------------------------------------

/** One timed trade as a row of the record: running or finished, in the words Predict uses for it. */
export interface TimedRowView {
  id: string;
  asset: string;
  direction: TimedTrade['direction'];
  /** `Up`, `Down`. */
  word: string;
  /** `$10 · 5x · 1m`. */
  terms: string;
  /** Not closed yet. A running trade is watched on Predict; a finished one has details. */
  running: boolean;
  /** `RUNNING`, `CLOSING`, or how it ended: `TIME UP`, `CUT`, `ENDED EARLY`, `CLOSED ELSEWHERE`. */
  state: string;
  entry: string;
  /** The exit price, `Not reported yet` for the few seconds after it closes, or null while it runs. */
  exit: string | null;
  move: PriceMove | null;
  figures: RowFigures;
  /** Milliseconds it was opened. */
  at: number;
  accessibilityLabel: string;
}

export function timedRowView(trade: TimedTrade): TimedRowView {
  const running = trade.status !== 'closed';
  const word = trade.direction === 'up' ? 'Up' : 'Down';
  const entry = formatTimedPrice(trade.entryPrice);
  const finished = running ? null : finishedView(trade);
  const state = finished ? finished.ended : trade.status === 'closing' ? 'CLOSING' : 'RUNNING';
  const exit = finished ? finished.exit : null;
  return {
    id: trade.id,
    asset: trade.asset,
    direction: trade.direction,
    word,
    terms: termsLine(trade),
    running,
    state,
    entry,
    exit,
    move: finished ? finished.move : null,
    figures: rowFigures(entry, exit, state),
    at: trade.openedAt,
    accessibilityLabel: finished
      ? finished.accessibilityLabel
      : `${word} on ${trade.asset}, ${state.toLowerCase()}. Entry ${entry}. Open Predict.`,
  };
}
