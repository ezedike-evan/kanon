import { abbreviateHash, formatBps, formatDecimal, type Decimal } from '@kanon/spec';
import { baseOf, normalizeSymbol, parseAssetParam } from './chart-assets';
import { formatAtoms } from './chart-format';
import { formatSize } from './home-format';
import { monad, monadTestnet } from './monad-chain';
import { explorerUrl } from './profile-logic';
import type {
  TicketSending,
  VenueAccountState,
  VenueAccountView,
  VenueLimits,
  VenueMarketView,
  VenueNetwork,
  VenueOrder,
  VenueOrderResult,
  VenueOrderRow,
  VenueOrderStatus,
  VenuePositionView,
  VenueSide,
} from './venue-types';

/**
 * The pure half of the order ticket: what it offers, what it says and what it
 * links to, worked out from what the server answered. No React, no clock (a
 * caller passes `nowMs`), no I/O, so every rule here is pinned down in
 * `venue-trade.test.ts`.
 *
 * Nothing here turns a `Decimal` into a float: a size, a price, a fee and a
 * collateral figure are printed from their integer atoms. And nothing here
 * computes a profit or a loss.
 */

// --- Words the client says itself ---------------------------------------------

/** What a ticket says while nobody is signed in. Nothing is called in that state. */
export const SIGN_IN_TO_TRADE = 'Sign in to trade.';
export const ACCOUNT_UNREAD = 'The trading account could not be read. Try again.';
export const ACCOUNT_UNKNOWN_SHAPE = 'The trading account came back in a shape this screen does not know.';
/** A call that threw may or may not have reached the venue, so this claims neither. */
export const ORDER_UNREAD = "The order's result could not be read. Check the position before sending another.";
export const ORDER_UNKNOWN_SHAPE =
  "The order's result came back in a shape this screen does not know. Check the position before sending another.";
/**
 * A fill is answered as soon as the position moves, and the venue's history
 * (its price, fee, block and transaction) follows seconds later. Until it does,
 * a figure it has not given says so, and the ticket keeps listening for it.
 */
export const NOT_REPORTED_YET = 'Not reported yet';
export const TX_NOT_REPORTED = "The venue has not reported this fill's transaction yet. Its link appears here when it does.";

/**
 * A readable line from a call that threw. The server's refusals of a caller
 * (signed out, no account row) are a `ConvexError` carrying `data.message`,
 * which is written for the person. Anything else is a transport or server
 * fault whose own text is not, so the fallback is said instead.
 */
export function thrownMessage(err: unknown, fallback: string): string {
  const message = (err as { data?: { message?: unknown } } | null | undefined)?.data?.message;
  return typeof message === 'string' && message.trim() !== '' ? message : fallback;
}

// --- Reading what the server answered -----------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isSide = (v: unknown): v is VenueSide => v === 'long' || v === 'short';
const isNetwork = (v: unknown): v is VenueNetwork => v === 'testnet' || v === 'mainnet';

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

function isLimits(v: unknown): v is VenueLimits {
  return (
    isRecord(v) &&
    isCount(v.minNotionalUsd) &&
    isCount(v.maxNotionalUsd) &&
    isCount(v.maxLeverage) &&
    isCount(v.slippageBps) &&
    isCount(v.maxPositionUsd)
  );
}

const isMarket = (v: unknown): v is VenueMarketView =>
  isRecord(v) && isText(v.asset) && isCount(v.maxLeverage) && typeof v.open === 'boolean';

const isPosition = (v: unknown): v is VenuePositionView =>
  isRecord(v) &&
  isText(v.asset) &&
  isSide(v.side) &&
  isDecimal(v.size) &&
  isDecimal(v.entryPrice) &&
  isCount(v.leverage) &&
  isDecimal(v.collateral) &&
  isDecimal(v.notional);

/**
 * `venue.account`'s answer as the account a ticket draws. A reply that is not
 * one of its two shapes is a failure to read, not an account: the ticket then
 * says so and offers nothing, instead of drawing chips from fields that are not
 * there.
 */
export function asAccount(result: unknown): VenueAccountView {
  if (isRecord(result)) {
    if (result.status === 'unavailable' && isText(result.message)) {
      return { status: 'unavailable', message: result.message };
    }
    if (
      result.status === 'ready' &&
      isNetwork(result.network) &&
      typeof result.canTrade === 'boolean' &&
      isLimits(result.limits) &&
      Array.isArray(result.markets) &&
      result.markets.every(isMarket) &&
      Array.isArray(result.positions) &&
      result.positions.every(isPosition)
    ) {
      return result as unknown as VenueAccountView;
    }
  }
  return { status: 'unavailable', message: ACCOUNT_UNKNOWN_SHAPE };
}

/** `venue.placeOrder` / `venue.closePosition`'s answer, read the same way as the account. */
export function asOrderResult(result: unknown): VenueOrderResult {
  if (isRecord(result)) {
    switch (result.status) {
      case 'filled':
        if (
          isText(result.asset) &&
          (result.action === 'open' || result.action === 'close') &&
          isSide(result.side) &&
          isDecimal(result.size) &&
          // The fill's own figures follow the answer: each is a value or null, never absent.
          (result.price === null || isDecimal(result.price)) &&
          (result.fee === null || isDecimal(result.fee)) &&
          (result.block === null || isCount(result.block)) &&
          (result.txHash === null || typeof result.txHash === 'string')
        ) {
          return result as unknown as VenueOrderResult;
        }
        break;
      case 'refused':
        if (isText(result.reason)) return { status: 'refused', reason: result.reason };
        break;
      case 'unfilled':
      case 'pending':
        if (isText(result.message)) {
          return { status: result.status, orderId: String(result.orderId ?? ''), message: result.message };
        }
        break;
      case 'busy':
      case 'unavailable':
        if (isText(result.message)) return { status: result.status, message: result.message };
        break;
      case 'rate_limited':
        if (isText(result.message)) {
          return {
            status: 'rate_limited',
            retryAfterMs: isCount(result.retryAfterMs) ? result.retryAfterMs : 0,
            message: result.message,
          };
        }
        break;
    }
  }
  return { status: 'unavailable', message: ORDER_UNKNOWN_SHAPE };
}

const ORDER_STATUSES: readonly VenueOrderStatus[] = ['submitting', 'filled', 'unfilled', 'refused', 'failed'];

/** One `venueData.listMyOrders` row as the UI's order: every absent field becomes null. */
export function orderFromRow(row: VenueOrderRow): VenueOrder {
  return {
    id: String(row._id),
    network: row.network,
    asset: row.asset,
    action: row.action,
    side: row.side ?? null,
    status: row.status,
    createdAt: row.createdAt,
    settledAt: row.settledAt ?? null,
    notionalUsd: row.notionalUsd ?? null,
    leverage: row.leverage ?? null,
    requestId: row.requestId ?? null,
    size: row.size ?? null,
    fillPrice: row.fillPrice ?? null,
    fee: row.fee ?? null,
    block: row.block ?? null,
    txHash: row.txHash ?? null,
    reason: row.reason ?? null,
  };
}

/** The rows a list can draw, newest first as the server sent them. A row it cannot read is left out, not guessed at. */
export function ordersFromRows(rows: readonly unknown[]): VenueOrder[] {
  const out: VenueOrder[] = [];
  for (const row of rows) {
    if (
      isRecord(row) &&
      isText(row.asset) &&
      isNetwork(row.network) &&
      (row.action === 'open' || row.action === 'close') &&
      (ORDER_STATUSES as readonly unknown[]).includes(row.status) &&
      typeof row.createdAt === 'number'
    ) {
      out.push(orderFromRow(row as unknown as VenueOrderRow));
    }
  }
  return out;
}

// --- What the ticket offers ---------------------------------------------------

/** Round sizes a person reaches for. Only the ones inside the server's limits are ever offered. */
const SIZE_LADDER = [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000] as const;

/**
 * The sizes offered, in whole dollars: the smallest and the largest the server
 * takes, and up to two round figures between them. `10` and `100` give
 * `10, 25, 50, 100`. Nothing outside the limits, and nothing when they admit no
 * whole dollar.
 */
export function sizePresets(limits: Pick<VenueLimits, 'minNotionalUsd' | 'maxNotionalUsd'>): number[] {
  const min = Math.max(1, Math.ceil(limits.minNotionalUsd));
  const max = Math.floor(limits.maxNotionalUsd);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return [];
  if (min === max) return [min];
  const inside = SIZE_LADDER.filter((n) => n > min && n < max);
  const last = inside.length - 1;
  const between =
    inside.length <= 2 ? inside : [inside[Math.floor(last / 3)]!, inside[Math.ceil((last * 2) / 3)]!];
  return [min, ...between, max];
}

/** No venue lists a market above this, and a number that is not a leverage must not draw a thousand chips. */
const LEVERAGE_STEP_CEILING = 100;

/** Every whole step from 1x to the market's ceiling. `5` gives `1, 2, 3, 4, 5`. */
export function leverageSteps(maxLeverage: number): number[] {
  const max = Number.isFinite(maxLeverage) ? Math.min(LEVERAGE_STEP_CEILING, Math.floor(maxLeverage)) : 1;
  return Array.from({ length: Math.max(1, max) }, (_, i) => i + 1);
}

/**
 * The option in force: the one picked while it is still offered, else the
 * highest one under it, else the smallest. With nothing picked it is the
 * smallest, so a ticket opens on the least it can send. `options` ascend.
 */
export function chosenOption(options: readonly number[], wanted: number | null): number | null {
  let best = options[0];
  if (best === undefined) return null;
  if (wanted === null) return best;
  for (const option of options) if (option <= wanted) best = option;
  return best;
}

/** The venue's market for a chart asset, or null when it lists none. */
export function marketOf(account: VenueAccountState, asset: string): VenueMarketView | null {
  if (account.status !== 'ready') return null;
  const symbol = normalizeSymbol(asset);
  return account.markets.find((m) => normalizeSymbol(m.asset) === symbol) ?? null;
}

/** The account's open position on a chart asset, or null. One per market, so there is at most one. */
export function positionOf(account: VenueAccountState, asset: string): VenuePositionView | null {
  if (account.status !== 'ready') return null;
  const symbol = normalizeSymbol(asset);
  return account.positions.find((p) => normalizeSymbol(p.asset) === symbol) ?? null;
}

// --- Figures ------------------------------------------------------------------

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** `$25`, `$1,000`. Notional is whole dollars. */
export function formatUsd(usd: number): string {
  return `$${group(String(Math.trunc(usd)))}`;
}

/** `2x`, `2.5x`. Printed from hundredths, so a multiple never shows a float's tail. */
export function formatLeverage(leverage: number): string {
  const hundredths = Math.round(leverage * 100);
  const whole = Math.trunc(hundredths / 100);
  const frac = String(hundredths % 100).padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}x` : `${whole}x`;
}

/** `0.00041 BTC`: a size in the asset it is a size of, without the zeros its atoms are padded with. */
export function formatVenueSize(size: Decimal, asset: string): string {
  return `${formatSize(size)} ${baseOf(asset)}`;
}

/** `12.50 AUSD`: collateral at two places, rounded on the integer atoms. */
export function formatCollateral(collateral: Decimal): string {
  return `${formatAtoms(collateral.atoms, collateral.decimals, Math.min(2, collateral.decimals))} AUSD`;
}

/**
 * `$25.10`: a position's size at its entry price, in dollars to two places. It
 * is what the position limit is measured against, and is only ever said beside
 * that limit. It is not what the position is worth now.
 */
export function formatNotional(notional: Decimal): string {
  return `$${formatAtoms(notional.atoms, notional.decimals, 2)}`;
}

/**
 * A fee keeps every place it has, since it is small against the order. Negative
 * atoms are a rebate, and are called one instead of being shown as a negative fee.
 */
export function feeFact(fee: Decimal): [label: string, value: string] {
  const rebate = fee.atoms.startsWith('-');
  const magnitude = rebate ? { atoms: fee.atoms.slice(1), decimals: fee.decimals } : fee;
  return [rebate ? 'Rebate' : 'Fee', `${formatSize(magnitude)} AUSD`];
}

// --- Evidence -----------------------------------------------------------------

/** A transaction, and where to read it. */
export interface TxRef {
  hash: string;
  /** `0x12ab34…cd56`. */
  short: string;
  url: string;
  /** The explorer's name, for the link's label. */
  explorer: string;
}

/**
 * The explorer page for a fill's transaction. The explorer follows the venue's
 * network, not the chain this client is configured for: an order placed on
 * Perpl's testnet settles on Monad testnet whatever the rest of the app reads.
 */
export function venueTx(network: VenueNetwork, txHash: string): TxRef {
  const explorer = (network === 'testnet' ? monadTestnet : monad).blockExplorers.default;
  return {
    hash: txHash,
    short: abbreviateHash(txHash, 6, 4),
    url: explorerUrl(explorer.url, 'tx', encodeURIComponent(txHash)),
    explorer: explorer.name,
  };
}

// --- The ticket ---------------------------------------------------------------

/** Every limit in force, worded for the ticket. All of it comes from the server's `limits`. */
export interface TicketLimits {
  /** `Market, IOC`: it fills now, inside the slippage bound, or not at all. */
  orderType: string;
  /** `1.00%`. */
  slippage: string;
  /** `$10 to $100`. */
  size: string;
  /** `1x to 5x`, for the market on the chart. */
  leverage: string;
  /** `Up to $300`: the most a position on one market may reach, at its entry price. */
  position: string;
}

export interface TicketView {
  status: 'loading' | 'unavailable' | 'ready';
  /** `Perpl testnet · shared demo account`. Whose account an order goes to, said plainly. */
  venueLine: string;
  /** Why the account is unavailable, in the words it came with. */
  message: string | null;
  network: VenueNetwork | null;
  limits: TicketLimits | null;
  sizes: number[];
  /** The sizes on offer that cannot be sent: each would take the open position past the position limit. */
  sizesOff: number[];
  /** The size in force, or null when none can be sent. */
  usd: number | null;
  leverages: number[];
  /** The leverage in force. With a position open it is the position's, or null when the server takes no order at it. */
  leverage: number | null;
  /** The leverage is the open position's and not a choice: an order that adds to it uses the same. */
  leverageFixed: boolean;
  /** The open position on this asset. An order on its side adds to it; the other side waits for it to close. */
  position: VenuePositionView | null;
  /** Why no order can be opened, or added to the open position, right now. One line. Null when one can. */
  hold: string | null;
  /** With a position open, why its other side is off, in the words the server refuses it with. Null with none open. */
  sideNote: string | null;
}

const range = (low: string, high: string): string => (low === high ? low : `${low} to ${high}`);

const otherSide = (side: VenueSide): VenueSide => (side === 'long' ? 'short' : 'long');

/**
 * Whether an order of `usd` dollars keeps a position inside the position limit.
 * The server measures the position at its entry price (`notional`) and adds the
 * order's dollars. Integers throughout, as it does.
 */
function fitsPosition(position: VenuePositionView, usd: number, maxPositionUsd: number): boolean {
  if (!Number.isFinite(usd) || !Number.isFinite(maxPositionUsd)) return false;
  const scale = 10n ** BigInt(position.notional.decimals);
  const held = BigInt(position.notional.atoms);
  return held + BigInt(Math.trunc(usd)) * scale <= BigInt(Math.floor(maxPositionUsd)) * scale;
}

/**
 * What a ticket draws for one asset, from the account as last read and what the
 * person picked. Loading or unavailable, it offers no size and no leverage:
 * both come from the server's limits, and until those are read there is nothing
 * true to offer.
 *
 * A market holds one position per account. With one open here, an order on its
 * side adds to it: at the position's own leverage, and only in a size that
 * keeps the position inside `maxPositionUsd`. An order on the other side is one
 * the server refuses, so it is never offered.
 */
export function ticketView(
  account: VenueAccountState,
  asset: string,
  wanted: { usd: number | null; leverage: number | null },
): TicketView {
  if (account.status !== 'ready') {
    return {
      status: account.status,
      venueLine: 'Perpl · shared demo account',
      message: account.status === 'unavailable' ? account.message : null,
      network: null,
      limits: null,
      sizes: [],
      sizesOff: [],
      usd: null,
      leverages: [],
      leverage: null,
      leverageFixed: false,
      position: null,
      hold: account.status === 'unavailable' ? account.message : 'Reading the trading account.',
      sideNote: null,
    };
  }

  const { limits } = account;
  const market = marketOf(account, asset);
  const position = positionOf(account, asset);
  const sizes = sizePresets(limits);
  const leverages = market ? leverageSteps(market.maxLeverage) : [];
  const ceiling = market ? Math.max(1, Math.floor(market.maxLeverage)) : limits.maxLeverage;
  const levers = range('1x', formatLeverage(ceiling));
  const base = baseOf(asset);

  const sizesOff = position ? sizes.filter((usd) => !fitsPosition(position, usd, limits.maxPositionUsd)) : [];
  const sendable = sizes.filter((usd) => !sizesOff.includes(usd));
  const leverage = position
    ? leverages.includes(position.leverage)
      ? position.leverage
      : null
    : chosenOption(leverages, wanted.leverage);

  let hold: string | null = null;
  if (!account.canTrade) hold = 'The shared account is not taking orders right now.';
  else if (!market) hold = `Perpl lists no market for ${normalizeSymbol(asset)}.`;
  else if (!market.open) hold = `The ${base} market is closed.`;
  else if (sizes.length === 0) hold = 'No order size fits the limits in force.';
  else if (position && leverage === null) {
    // Both halves are the server's own refusals: an add must match the position, and it takes whole steps only.
    hold =
      `The ${base} position is at ${formatLeverage(position.leverage)}. An order that adds to it uses the same ` +
      `leverage, and leverage on ${base} here is ${levers}, in whole steps.`;
  } else if (position && sendable.length === 0) {
    hold =
      `The ${base} position is ${formatNotional(position.notional)} at entry. ` +
      `A position here is at most ${formatUsd(limits.maxPositionUsd)}.`;
  }

  return {
    status: 'ready',
    venueLine: `Perpl ${account.network} · shared demo account`,
    message: null,
    network: account.network,
    limits: {
      orderType: 'Market, IOC',
      slippage: formatBps(limits.slippageBps),
      size: range(formatUsd(limits.minNotionalUsd), formatUsd(limits.maxNotionalUsd)),
      leverage: levers,
      position: `Up to ${formatUsd(limits.maxPositionUsd)}`,
    },
    sizes,
    sizesOff,
    usd: chosenOption(sendable, wanted.usd),
    leverages,
    leverage,
    leverageFixed: position !== null,
    position,
    hold,
    sideNote: position
      ? `The account holds a ${base} ${position.side}. Close it before opening a ${otherSide(position.side)}.`
      : null,
  };
}

/** What a control says to a screen reader: `Open long, 25 dollars, 2x`. */
export function openOrderLabel(side: VenueSide, usd: number, leverage: number): string {
  return `Open ${side}, ${Math.trunc(usd)} dollars, ${formatLeverage(leverage)}`;
}

/** `Add to the long, 25 dollars, 2x`: an order on the side of the position already open. */
export function addOrderLabel(side: VenueSide, usd: number, leverage: number): string {
  return `Add to the ${side}, ${Math.trunc(usd)} dollars, ${formatLeverage(leverage)}`;
}

/** `Close the BTC long position, 0.00041 BTC`. The whole position closes; there is no part of one. */
export function closePositionLabel(position: VenuePositionView): string {
  return `Close the ${baseOf(position.asset)} ${position.side} position, ${formatVenueSize(position.size, position.asset)}`;
}

/** A position's figures, label then value. No mark price and no result: neither is this ticket's to show. */
export function positionFacts(position: VenuePositionView): Array<[label: string, value: string]> {
  return [
    ['Size', formatVenueSize(position.size, position.asset)],
    ['Entry', formatDecimal(position.entryPrice)],
    ['Leverage', formatLeverage(position.leverage)],
    ['Collateral', formatCollateral(position.collateral)],
  ];
}

/** Why an order on one side cannot go out, in one line. Null when it can. */
export function sideHold(view: TicketView, side: VenueSide): string | null {
  if (view.position && view.position.side !== side) return view.sideNote;
  if (view.hold !== null) return view.hold;
  return view.usd === null || view.leverage === null ? 'No order size fits the limits in force.' : null;
}

/** LONG or SHORT as a ticket offers it. */
export interface SideButton {
  /** `LONG`, `SHORT`, or `ADD LONG` when the account holds a long on this asset. */
  word: string;
  /** What a press sends, `Add to the long, 25 dollars, 2x`, or the side and why it is off. */
  accessibilityLabel: string;
  /** For the phone's bar, where a press opens the sheet and sends nothing: `Add to the long: open the order ticket`. */
  sheetLabel: string;
  disabled: boolean;
}

/**
 * One direction button. The side of the open position reads as an add, since
 * that is what an order on it does. The other side is off until the position
 * closes, and says so. `locked` is an order out, or one whose account read has
 * not landed yet.
 */
export function sideButton(view: TicketView, side: VenueSide, locked: boolean): SideButton {
  const adding = view.position?.side === side;
  const word = `${adding ? 'ADD ' : ''}${side.toUpperCase()}`;
  const name = adding ? `Add to the ${side}` : side === 'long' ? 'Long' : 'Short';
  const hold = sideHold(view, side);
  if (hold !== null || view.usd === null || view.leverage === null) {
    const off = `${name}. ${hold ?? ''}`.trim();
    return { word, accessibilityLabel: off, sheetLabel: off, disabled: true };
  }
  return {
    word,
    accessibilityLabel: (adding ? addOrderLabel : openOrderLabel)(side, view.usd, view.leverage),
    sheetLabel: `${name}: open the order ticket`,
    disabled: locked,
  };
}

/** What a size chip says to a screen reader: `Size 25 dollars`, and why when it is off. */
export function sizeChipLabel(view: TicketView, usd: number): string {
  const name = `Size ${Math.trunc(usd)} dollars`;
  return view.sizesOff.includes(usd) && view.limits
    ? `${name}. The position would pass its limit (${view.limits.position.toLowerCase()}).`
    : name;
}

/** Whether what is on its way is the close of this market's position. */
export function isClosing(sending: TicketSending, asset: string): boolean {
  return sending?.action === 'close' && normalizeSymbol(sending.asset) === normalizeSymbol(asset);
}

/** What a ticket says while an order is out. A close names its market: it may not be the one on the chart. */
export function sendingLine(sending: Exclude<TicketSending, null>): string {
  return sending.action === 'open' ? 'Sending the order…' : `Closing the ${baseOf(sending.asset)} position…`;
}

/**
 * The one line beside a ticket's buttons: what is on its way, else why nothing
 * can be sent, else why one side is off while a position is open. Null when
 * either side can go out, and the ticket then says what a press will do instead.
 */
export function ticketLine(view: TicketView, sending: TicketSending): string | null {
  return sending ? sendingLine(sending) : (view.hold ?? view.sideNote);
}

/**
 * A second line under the first, for the one case the first cannot cover: an
 * order that adds is held for its own reason, and the other side is off for
 * another. Each button's reason is then in view.
 */
export function ticketSecondLine(view: TicketView, sending: TicketSending): string | null {
  return !sending && view.hold !== null ? view.sideNote : null;
}

/**
 * What the phone's sheet is being used for while a position is open: adding to
 * it, or closing it. One of the two decides what the sheet's single action does.
 */
export type SheetIntent = 'add' | 'close';

/**
 * What the sheet starts on when it opens. Closing, unless it was opened from
 * the bar's button for the position's own side, which asked to add.
 */
export function openingIntent(view: TicketView, side: VenueSide | null): SheetIntent {
  return view.position !== null && side === view.position.side ? 'add' : 'close';
}

/** The sheet's one bottom-anchored action, worked out from the ticket and what was picked in the sheet. */
export interface SheetPrimary {
  /** What a press does: sends an order on `side` (an open, or an add), closes the position, or nothing. */
  action: 'open' | 'close' | null;
  /** The side the action is for, which colours it. Null for a close and for anything that sends nothing. */
  side: VenueSide | null;
  /** `OPEN LONG · $25 · 2x`. */
  label: string;
  /** `Open long, 25 dollars, 2x`. */
  accessibilityLabel: string;
  disabled: boolean;
}

/**
 * With a position open the sheet closes it or adds to it, whichever `intent`
 * says, and an add is always on the position's own side. With none open it
 * opens on the side picked, once one is: a ticket never picks a side for
 * anybody. `locked` is an order out, or one whose account read has not landed
 * yet.
 */
export function sheetPrimary(
  view: TicketView,
  choice: { side: VenueSide | null; intent: SheetIntent },
  sending: TicketSending,
  locked: boolean,
): SheetPrimary {
  if (sending) {
    return {
      action: null,
      side: sending.action === 'open' ? sending.side : null,
      label: sending.action === 'open' ? 'SENDING…' : 'CLOSING…',
      accessibilityLabel: sendingLine(sending),
      disabled: true,
    };
  }
  if (view.position && choice.intent === 'close') {
    const { position } = view;
    return {
      action: 'close',
      side: null,
      label: `CLOSE ${position.side.toUpperCase()} · ${formatVenueSize(position.size, position.asset)}`,
      accessibilityLabel: closePositionLabel(position),
      disabled: locked,
    };
  }
  if (view.position) {
    const { side } = view.position;
    if (view.hold !== null || view.usd === null || view.leverage === null) {
      return {
        action: null,
        side: null,
        label: 'ADDING IS OFF',
        accessibilityLabel: view.hold ?? 'Adding is off',
        disabled: true,
      };
    }
    return {
      action: 'open',
      side,
      label: `ADD ${side.toUpperCase()} · ${formatUsd(view.usd)} · ${formatLeverage(view.leverage)}`,
      accessibilityLabel: addOrderLabel(side, view.usd, view.leverage),
      disabled: locked,
    };
  }
  if (view.hold !== null || view.usd === null || view.leverage === null) {
    return {
      action: null,
      side: null,
      label: 'NOT AVAILABLE RIGHT NOW',
      accessibilityLabel: view.hold ?? 'Not available right now',
      disabled: true,
    };
  }
  if (choice.side === null) {
    return {
      action: null,
      side: null,
      label: 'CHOOSE LONG OR SHORT',
      accessibilityLabel: 'Choose long or short first',
      disabled: true,
    };
  }
  return {
    action: 'open',
    side: choice.side,
    label: `OPEN ${choice.side.toUpperCase()} · ${formatUsd(view.usd)} · ${formatLeverage(view.leverage)}`,
    accessibilityLabel: openOrderLabel(choice.side, view.usd, view.leverage),
    disabled: locked,
  };
}

/**
 * The line over the sheet's action. While the sheet is set to close, what holds
 * an add back is not what the action is waiting on, so it is left out.
 */
export function sheetLine(view: TicketView, intent: SheetIntent, sending: TicketSending): string | null {
  if (sending) return sendingLine(sending);
  return view.position && intent === 'close' ? null : view.hold;
}

// --- An order's answer --------------------------------------------------------

export interface OutcomeView {
  status: VenueOrderResult['status'];
  /** `FILLED`, `REFUSED`, `NOT FILLED`, `SENT`. A refusal is an answer, and is labelled like any other. */
  label: string;
  /** `BTC/USD`: the asset the order was for. */
  asset: string;
  /** The answer in one line. For anything but a fill it is the server's own words, unchanged. */
  text: string;
  /** `Opened long`, `Closed short`: what a fill did. An add is an open on the side already held. Null for anything else. */
  headline: string | null;
  /** A fill's side, for its direction glyph. */
  side: VenueSide | null;
  /** A fill's figures, label then value. Empty for anything else. */
  facts: Array<[label: string, value: string]>;
  /** The fill's transaction: the evidence, one tap away. */
  tx: TxRef | null;
  /** Said in place of the link while a fill's transaction has not been reported. */
  txMissing: string | null;
}

const OUTCOME_LABEL: Record<Exclude<VenueOrderResult['status'], 'filled'>, string> = {
  refused: 'REFUSED',
  unfilled: 'NOT FILLED',
  // Sent, and that is all that is known. Not a fill and not a fault.
  pending: 'SENT',
  busy: 'BUSY',
  unavailable: 'UNAVAILABLE',
  rate_limited: 'RATE LIMITED',
};

/**
 * An order's answer as the ticket shows it, in place. `context` is what the
 * request knew and the answer does not repeat: the asset it was for, and the
 * network the account was on when it was sent.
 *
 * A fill is answered as soon as the position moves, so its price, fee, block
 * and transaction may not be known yet. Each one that is missing says so;
 * `completeFill` puts them in as the order's row gains them.
 */
export function outcomeView(
  result: VenueOrderResult,
  context: { asset: string; network: VenueNetwork },
): OutcomeView {
  if (result.status !== 'filled') {
    return {
      status: result.status,
      label: OUTCOME_LABEL[result.status],
      asset: normalizeSymbol(context.asset),
      text: result.status === 'refused' ? result.reason : result.message,
      headline: null,
      side: null,
      facts: [],
      tx: null,
      txMissing: null,
    };
  }
  const size = formatVenueSize(result.size, result.asset);
  const price = result.price ? formatDecimal(result.price) : null;
  const verb = result.action === 'open' ? 'Opened' : 'Closed';
  return {
    status: 'filled',
    label: 'FILLED',
    asset: normalizeSymbol(result.asset),
    text: `${verb} ${result.side} ${size}${price ? ` at ${price}` : ''}.`,
    headline: `${verb} ${result.side}`,
    side: result.side,
    facts: [
      ['Size', size],
      ['Price', price ?? NOT_REPORTED_YET],
      result.fee ? feeFact(result.fee) : ['Fee', NOT_REPORTED_YET],
      ['Block', result.block === null ? NOT_REPORTED_YET : group(String(Math.trunc(result.block)))],
    ],
    tx: result.txHash ? venueTx(context.network, result.txHash) : null,
    txMissing: result.txHash ? null : TX_NOT_REPORTED,
  };
}

/**
 * Whether an answer is a fill the venue has not finished reporting: its price,
 * fee, block or transaction is still missing. The ticket follows the order's
 * row only while such an answer is showing.
 */
export function fillAwaitsFigures(result: VenueOrderResult): boolean {
  return (
    result.status === 'filled' &&
    (result.price === null || result.fee === null || result.block === null || !result.txHash)
  );
}

/**
 * A fill with whatever its order's row has gained since the answer came back.
 * The row is the one whose `id` is the answer's `orderId`. Only a figure the
 * answer left out is put in: one the server gave is never replaced. When the
 * rows add nothing the same object comes back, so a caller can tell nothing
 * changed.
 *
 * The row's own status is not read. The server answers before the row is fully
 * written, so for a moment after a `filled` answer the row still says
 * `submitting`. The answer is what happened; the row only ever adds figures to
 * it, and can never turn a fill back into something else.
 */
export function completeFill(result: VenueOrderResult, orders: readonly VenueOrder[]): VenueOrderResult {
  if (result.status !== 'filled' || !fillAwaitsFigures(result)) return result;
  const row = orders.find((order) => order.id === result.orderId);
  if (!row) return result;
  const price = result.price ?? row.fillPrice;
  const fee = result.fee ?? row.fee;
  const block = result.block ?? row.block;
  const txHash = result.txHash || row.txHash;
  if (price === result.price && fee === result.fee && block === result.block && txHash === result.txHash) {
    return result;
  }
  return { ...result, price, fee, block, txHash };
}

// --- The phone's bar ----------------------------------------------------------

/**
 * The bar's single line. What is on its way comes first, then why nothing can
 * be sent (an account that cannot be read, a position at its limit), then the
 * last answer, then why one side is off while a position is open, and with
 * nothing else to say, whose account this is.
 */
export function barLine(view: TicketView, sending: TicketSending, outcome: OutcomeView | null): string {
  if (sending) return sendingLine(sending);
  if (view.hold !== null) return view.hold;
  if (outcome) return `${outcome.label} · ${outcome.text}`;
  return view.sideNote ?? view.venueLine;
}

/** The bar's right-hand figure: the size and leverage a new order would start from, or what the sheet holds. */
export function barSummary(view: TicketView): string {
  if (view.position) return 'POSITION';
  if (view.usd !== null && view.leverage !== null) return `${formatUsd(view.usd)} · ${formatLeverage(view.leverage)}`;
  return 'TICKET';
}

// --- The open positions -------------------------------------------------------

/** One position on the shared account, as a row. Its own figures and nothing about how it is doing. */
export interface PositionRowView {
  /** `BTC/USD`: the market, as the venue names it. What the row's Close closes. */
  asset: string;
  /** The same market as the chart knows it, or null when the chart draws no such asset. A press on the row shows it. */
  chartAsset: string | null;
  side: VenueSide;
  /** `LONG`. Beside the glyph: direction never rests on colour alone. */
  sideWord: string;
  /** `0.00041 BTC`. */
  size: string;
  /** `61,234.5`. */
  entry: string;
  /** `2x`. */
  leverage: string;
  /** `Show BTC/USD on the chart. Long, 0.00041 BTC, entry 61,234.5, 2x`. */
  accessibilityLabel: string;
  /** `Close the BTC long position, 0.00041 BTC`. */
  closeLabel: string;
}

export function positionRowView(position: VenuePositionView): PositionRowView {
  const asset = normalizeSymbol(position.asset);
  const chartAsset = parseAssetParam(position.asset) ?? null;
  const size = formatVenueSize(position.size, position.asset);
  const entry = formatDecimal(position.entryPrice);
  const leverage = formatLeverage(position.leverage);
  const figures = `${position.side === 'long' ? 'Long' : 'Short'}, ${size}, entry ${entry}, ${leverage}`;
  return {
    asset,
    chartAsset,
    side: position.side,
    sideWord: position.side.toUpperCase(),
    size,
    entry,
    leverage,
    accessibilityLabel: chartAsset ? `Show ${chartAsset} on the chart. ${figures}` : `${asset}. ${figures}`,
    closeLabel: closePositionLabel(position),
  };
}

// --- The order list -----------------------------------------------------------

/**
 * How long an order may sit at `submitting` before the list stops saying it is
 * on its way. The server waits under a minute for a fill; a row older than that
 * belongs to a call that never reported back.
 */
export const STALE_SENDING_MS = 60_000;

export interface OrderRowView {
  id: string;
  /** `BTC/USD · Open long`. */
  title: string;
  side: VenueSide | null;
  /** `FILLED`, `REFUSED`, `SENDING`. */
  label: string;
  /** One line: the fill, the request, or the reason in the server's words. */
  detail: string;
  /** Milliseconds the order was placed. */
  at: number;
  tx: TxRef | null;
  /** A fill with no transaction hash: said, not left blank. */
  txMissing: boolean;
}

/** One order as a row of the list. `nowMs` is 0 before the first client tick, when nothing is stale yet. */
export function orderRowView(order: VenueOrder, nowMs: number): OrderRowView {
  const verb = order.action === 'open' ? 'Open' : 'Close';
  const terms =
    order.notionalUsd !== null && order.leverage !== null
      ? `${formatUsd(order.notionalUsd)} · ${formatLeverage(order.leverage)}`
      : null;
  const stale = order.status === 'submitting' && nowMs > 0 && nowMs - order.createdAt > STALE_SENDING_MS;

  let label: string;
  let detail: string;
  switch (order.status) {
    case 'filled': {
      const price = order.fillPrice ? formatDecimal(order.fillPrice) : null;
      label = 'FILLED';
      detail = order.size
        ? `${formatVenueSize(order.size, order.asset)}${price ? ` at ${price}` : ''}`
        : (terms ?? 'Filled.');
      break;
    }
    case 'refused':
      label = 'REFUSED';
      detail = order.reason ?? terms ?? 'No reason was recorded.';
      break;
    case 'unfilled':
      label = 'NOT FILLED';
      detail = order.reason ?? 'Nothing filled. Nothing is left on the book.';
      break;
    case 'failed':
      label = 'NO RESULT';
      detail = order.reason ?? 'The result could not be read.';
      break;
    case 'submitting':
      label = stale ? 'NO RESULT' : 'SENDING';
      detail = stale ? 'This order never reported back.' : (terms ?? 'On its way to the venue.');
      break;
  }

  const filled = order.status === 'filled';
  return {
    id: order.id,
    title: `${normalizeSymbol(order.asset)} · ${verb}${order.side ? ` ${order.side}` : ''}`,
    side: order.side,
    label,
    detail,
    at: order.createdAt,
    tx: filled && order.txHash ? venueTx(order.network, order.txHash) : null,
    txMissing: filled && !order.txHash,
  };
}
