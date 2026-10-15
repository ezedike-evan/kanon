/**
 * The spot market Kanon listed on Kuru's testnet order book, as the spot
 * screen works with it: reading the gateway's answer by shape, sizing a market
 * order into the contract's own units, checking it against the market's limits,
 * and reading a fill back out of decoded `Trade` logs.
 *
 * Everything here is pure and integer. A price or a size is atoms with explicit
 * decimals from the moment it is read to the moment it is handed to the wallet;
 * nothing passes through a float. `spot-viem.ts` is the only file that talks to
 * a chain, and it does no arithmetic of its own.
 *
 * The units, which are the contract's and are easy to get wrong:
 *
 *   buy   `_quoteSize`    what is spent, at the market's PRICE decimals
 *         `_minAmountOut` the least base accepted, at the BASE token's decimals
 *         approve         what is spent, at the QUOTE token's decimals
 *   sell  `_size`         what is sold, at the market's SIZE decimals
 *         `_minAmountOut` the least quote accepted, at the QUOTE token's decimals
 *         approve         what is sold, at the BASE token's decimals
 *
 * The taker fee comes out of what is received, so the least accepted is the
 * amount at the best price, less the fee, less the slippage bound.
 */

import { abbreviateHash, compareDecimal, formatBps, formatDecimal, type Decimal } from '@kanon/spec';
import { monad, monadTestnet } from './monad-chain';
import { compactDecimal, explorerUrl } from './profile-logic';
import type { TxRef } from './venue-trade';

// --- The market, as the gateway sends it ----------------------------------------

export type SpotSide = 'buy' | 'sell';

export interface SpotToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** What the token is, in the gateway's words: `test token, open mint`. */
  kind: string;
}

export interface SpotLevel {
  price: Decimal;
  size: Decimal;
}

/** The transactions behind the listing. Each is present only when the gateway sent a well-formed hash. */
export interface SpotListing {
  marketTx?: string;
  tokenTx?: string;
  liquidityTx?: string;
  firstOrderTx?: string;
}

export interface SpotMarket {
  asset: string;
  network: string;
  chainId: number;
  /** The Kuru OrderBook contract the wallet calls. */
  market: string;
  base: SpotToken;
  quote: SpotToken;
  /** One sentence saying what the two tokens are. Shown as sent. */
  note: string;
  priceDecimals: number;
  sizeDecimals: number;
  minSize: Decimal;
  maxSize: Decimal;
  takerFeeBps: number;
  /** Best (highest) first. */
  bids: SpotLevel[];
  /** Best (lowest) first. */
  asks: SpotLevel[];
  blockNumber: number;
  /** Unix milliseconds, on the gateway's clock: when it read the book. */
  readAt: number;
  listing: SpotListing;
}

export type SpotMarketAnswer =
  | { ok: true; market: SpotMarket }
  | { ok: false; code: 'not_listed' | 'unreachable'; message: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const DIGITS = /^\d+$/;

const BPS = BigInt(10_000);
const pow10 = (n: number): bigint => BigInt(10) ** BigInt(n);
const dec = (atoms: bigint, decimals: number): Decimal => ({ atoms: atoms.toString(), decimals });

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

const int = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;

/** `{ atoms, decimals }` with a non-negative integer in `atoms`. Anything else is not an amount. */
function amount(value: unknown): Decimal | null {
  const r = record(value);
  if (!r) return null;
  const atoms = r['atoms'];
  const decimals = int(r['decimals'], 0, 36);
  if (typeof atoms !== 'string' || !DIGITS.test(atoms) || decimals === null) return null;
  return { atoms, decimals };
}

const positive = (d: Decimal | null): d is Decimal => d !== null && BigInt(d.atoms) > BigInt(0);

function token(value: unknown): SpotToken | null {
  const r = record(value);
  if (!r) return null;
  const address = r['address'];
  const symbol = text(r['symbol']);
  const name = text(r['name']);
  const decimals = int(r['decimals'], 0, 36);
  if (typeof address !== 'string' || !ADDRESS.test(address) || !symbol || !name || decimals === null) return null;
  return { address, symbol, name, decimals, kind: text(r['kind']) ?? '' };
}

/** One side of the book, or null when any row is not a positive price and size: a book is never patched up. */
function levels(value: unknown): SpotLevel[] | null {
  if (!Array.isArray(value)) return null;
  const out: SpotLevel[] = [];
  for (const row of value) {
    const r = record(row);
    const price = r ? amount(r['price']) : null;
    const size = r ? amount(r['size']) : null;
    if (!positive(price) || !positive(size)) return null;
    out.push({ price, size });
  }
  return out;
}

function listing(value: unknown): SpotListing {
  const r = record(value) ?? {};
  const out: SpotListing = {};
  for (const key of ['marketTx', 'tokenTx', 'liquidityTx', 'firstOrderTx'] as const) {
    const hash = r[key];
    if (typeof hash === 'string' && TX_HASH.test(hash)) out[key] = hash;
  }
  return out;
}

/**
 * The gateway's answer to `GET /kuru/market`, read by shape. Null means it is
 * not an answer this screen knows: the screen then says so, and draws no book.
 * Both sides are sorted best first here, so the price an order is sized from
 * does not rest on the order the rows arrived in.
 */
export function readSpotMarketAnswer(raw: unknown): SpotMarketAnswer | null {
  const r = record(raw);
  if (!r) return null;

  if (r['ok'] === false) {
    const message = text(r['message']);
    if (!message) return null;
    return { ok: false, code: r['code'] === 'not_listed' ? 'not_listed' : 'unreachable', message };
  }
  if (r['ok'] !== true) return null;

  const asset = text(r['asset']);
  const network = text(r['network']);
  const chainId = int(r['chainId'], 1, Number.MAX_SAFE_INTEGER);
  const market = r['market'];
  const base = token(r['base']);
  const quote = token(r['quote']);
  const priceDecimals = int(r['priceDecimals'], 0, 18);
  const sizeDecimals = int(r['sizeDecimals'], 0, 18);
  const minSize = amount(r['minSize']);
  const maxSize = amount(r['maxSize']);
  // A fee of the whole amount or more is not a fee this screen can size an order around.
  const takerFeeBps = int(r['takerFeeBps'], 0, 9_999);
  const bids = levels(r['bids']);
  const asks = levels(r['asks']);
  const blockNumber = int(r['blockNumber'], 0, Number.MAX_SAFE_INTEGER);
  const readAt = typeof r['readAt'] === 'number' && Number.isFinite(r['readAt']) ? r['readAt'] : null;

  if (
    !asset ||
    !network ||
    chainId === null ||
    typeof market !== 'string' ||
    !ADDRESS.test(market) ||
    !base ||
    !quote ||
    priceDecimals === null ||
    sizeDecimals === null ||
    !minSize ||
    !maxSize ||
    takerFeeBps === null ||
    !bids ||
    !asks ||
    blockNumber === null ||
    readAt === null
  ) {
    return null;
  }

  return {
    ok: true,
    market: {
      asset,
      network,
      chainId,
      market,
      base,
      quote,
      note: text(r['note']) ?? '',
      priceDecimals,
      sizeDecimals,
      minSize,
      maxSize,
      takerFeeBps,
      bids: [...bids].sort((a, b) => compareDecimal(b.price, a.price)),
      asks: [...asks].sort((a, b) => compareDecimal(a.price, b.price)),
      blockNumber,
      readAt,
      listing: listing(r['listing']),
    },
  };
}

// --- Sizing an order ---------------------------------------------------------

/** The slippage bound a ticket opens with, and the ones it offers. Basis points. */
export const DEFAULT_SLIPPAGE_BPS = 100;
export const SLIPPAGE_CHOICES_BPS: readonly number[] = [10, 50, 100, 200];

/** What "Get test USDC" mints, in whole tokens of the quote token. */
export const TEST_MINT_WHOLE = 1_000;

/** What "Get test USDC" mints: `TEST_MINT_WHOLE` whole tokens of the quote token, in its own atoms. */
export function testMintAmount(market: Pick<SpotMarket, 'quote'>): Decimal {
  return dec(BigInt(TEST_MINT_WHOLE) * pow10(market.quote.decimals), market.quote.decimals);
}

/**
 * The gap between the best ask and the best bid, as a price and as basis points
 * of the ask. Null while a side is empty, or while the two have met or crossed:
 * there is no gap to state then.
 */
export function bookSpread(market: Pick<SpotMarket, 'bids' | 'asks'>): { price: Decimal; bps: number } | null {
  const bid = market.bids[0];
  const ask = market.asks[0];
  if (!bid || !ask) return null;
  const decimals = Math.max(bid.price.decimals, ask.price.decimals);
  const bidAtoms = BigInt(bid.price.atoms) * pow10(decimals - bid.price.decimals);
  const askAtoms = BigInt(ask.price.atoms) * pow10(decimals - ask.price.decimals);
  if (askAtoms <= bidAtoms) return null;
  const gap = askAtoms - bidAtoms;
  return { price: dec(gap, decimals), bps: Number((gap * BPS) / askAtoms) };
}

/** `0.0001 to 1 tkBTC`: the sizes the market takes, stated wherever an amount is typed. */
export function sizeLimits(market: Pick<SpotMarket, 'minSize' | 'maxSize' | 'base'>): string {
  return `${compactDecimal(market.minSize)} to ${formatSpotAmount(market.maxSize, market.base.symbol)}`;
}

/** A market order in the contract's own units, with everything the confirmation states. */
export interface SpotOrder {
  side: SpotSide;
  spendToken: SpotToken;
  receiveToken: SpotToken;
  /** What leaves the wallet, at the spent token's decimals. This is the amount approved, and no more. */
  spend: Decimal;
  /** The contract's first argument: `_quoteSize` at the price decimals for a buy, `_size` at the size decimals for a sell. */
  sizeArg: Decimal;
  /** `_minAmountOut`, at the received token's decimals. */
  minOut: Decimal;
  /** What the order would bring at the best price after the fee, with no slippage. An estimate, said as one. */
  expectedOut: Decimal;
  /** The best ask (a buy) or the best bid (a sell) the order was sized from. */
  bestPrice: Decimal;
  /** The order's size in the base token at the size decimals: what the market's limits are checked against. */
  baseSize: Decimal;
  /** The order is larger than the best level holds, so part of it would fill at worse prices, or it reverts. */
  exceedsBest: boolean;
  takerFeeBps: number;
  slippageBps: number;
}

export type SpotHoldReason = 'empty' | 'invalid' | 'too_precise' | 'no_book' | 'too_small' | 'too_large' | 'balance';

export type SpotSizing = { ok: true; order: SpotOrder } | { ok: false; reason: SpotHoldReason; message: string };

/** `1,000` and `0.000997`: an amount as a sentence states it, with its trailing zeros dropped. */
export function formatSpotAmount(d: Decimal, symbol: string): string {
  return `${compactDecimal(d)} ${symbol}`;
}

/** `83,272.0000`: a price to the market's own precision, every place kept so a column of them lines up. */
export function formatSpotPrice(d: Decimal): string {
  return formatDecimal(d);
}

/** `0.248756210`: a book size to the market's own precision. */
export function formatSpotSize(d: Decimal): string {
  return formatDecimal(d);
}

type Parsed = { ok: true; atoms: bigint } | { ok: false; reason: 'empty' | 'invalid' | 'too_precise' };

/**
 * What was typed, as atoms at `decimals`. One separator is read, a point or a
 * comma (a decimal pad offers whichever the device's region uses); nothing is
 * read as a thousands mark, so a figure can only come out smaller than a
 * person meant and never larger. More places than the market takes is refused
 * in words instead of being rounded.
 */
export function parseSpotAmount(input: string, decimals: number): Parsed {
  const clean = input.trim();
  if (clean === '') return { ok: false, reason: 'empty' };
  const m = /^(\d{0,30})(?:[.,](\d{0,40}))?$/.exec(clean);
  if (!m) return { ok: false, reason: 'invalid' };
  const whole = m[1] ?? '';
  const frac = m[2] ?? '';
  if (whole === '' && frac === '') return { ok: false, reason: 'invalid' };
  if (frac.length > decimals && !/^0*$/.test(frac.slice(decimals))) return { ok: false, reason: 'too_precise' };
  const atoms = BigInt(`${whole || '0'}${frac.slice(0, decimals).padEnd(decimals, '0')}`);
  return atoms > BigInt(0) ? { ok: true, atoms } : { ok: false, reason: 'empty' };
}

/**
 * A market order for what was typed, or the plain sentence that says why there
 * is none. Nothing is sent from here: the sentence is shown before any
 * transaction exists.
 *
 * A buy is typed in the quote token (what to spend), a sell in the base token
 * (what to sell). Each is read at the finer of the token's decimals and the
 * market's own precision for it, so the amount approved, the amount the
 * contract is given and the amount on screen are one figure.
 */
export function sizeSpotOrder(input: {
  market: SpotMarket;
  side: SpotSide;
  amount: string;
  slippageBps: number;
  /** The wallet's balance of the token being spent, once it has been read. */
  balance?: Decimal | null | undefined;
}): SpotSizing {
  const { market, side } = input;
  const { base, quote, priceDecimals, sizeDecimals } = market;
  const buying = side === 'buy';
  const spendToken = buying ? quote : base;
  const receiveToken = buying ? base : quote;
  const hold = (reason: SpotHoldReason, message: string): SpotSizing => ({ ok: false, reason, message });

  // A bound outside 0 to 100% is not one; the ticket only offers the choices above.
  const slippageBps = Number.isInteger(input.slippageBps) ? Math.min(9_999, Math.max(0, input.slippageBps)) : DEFAULT_SLIPPAGE_BPS;

  const places = Math.min(spendToken.decimals, buying ? priceDecimals : sizeDecimals);
  const typed = parseSpotAmount(input.amount, places);
  if (!typed.ok) {
    if (typed.reason === 'empty') {
      return hold('empty', buying ? `Enter how much ${quote.symbol} to spend.` : `Enter how much ${base.symbol} to sell.`);
    }
    if (typed.reason === 'too_precise') {
      return hold('too_precise', `${spendToken.symbol} amounts on this market go to ${places} decimal places.`);
    }
    return hold('invalid', 'Enter the amount in digits, like 25 or 25.5.');
  }

  const best = (buying ? market.asks : market.bids)[0];
  if (!best) {
    return hold(
      'no_book',
      buying
        ? 'There are no asks on the book right now, so a market buy has nothing to fill against.'
        : 'There are no bids on the book right now, so a market sell has nothing to fill against.',
    );
  }

  const typedAtoms = typed.atoms;
  const priceAtoms = BigInt(best.price.atoms);
  const keep = (BPS - BigInt(market.takerFeeBps)) * (BPS - BigInt(slippageBps));
  const afterFee = BPS - BigInt(market.takerFeeBps);

  const spend = dec(typedAtoms * pow10(spendToken.decimals - places), spendToken.decimals);
  let sizeArg: Decimal;
  let baseSize: Decimal;
  let expectedOut: Decimal;
  let minOut: Decimal;

  if (buying) {
    // typed / price, in base. One division, at the end, so nothing is lost before the floor.
    const per = priceAtoms * pow10(places);
    const scaled = typedAtoms * pow10(best.price.decimals);
    sizeArg = dec(typedAtoms * pow10(priceDecimals - places), priceDecimals);
    baseSize = dec((scaled * pow10(sizeDecimals)) / per, sizeDecimals);
    expectedOut = dec((scaled * pow10(base.decimals) * afterFee) / (per * BPS), base.decimals);
    minOut = dec((scaled * pow10(base.decimals) * keep) / (per * BPS * BPS), base.decimals);
  } else {
    // typed * price, in quote.
    const per = pow10(places) * pow10(best.price.decimals);
    const scaled = typedAtoms * priceAtoms * pow10(quote.decimals);
    sizeArg = dec(typedAtoms * pow10(sizeDecimals - places), sizeDecimals);
    baseSize = sizeArg;
    expectedOut = dec((scaled * afterFee) / (per * BPS), quote.decimals);
    minOut = dec((scaled * keep) / (per * BPS * BPS), quote.decimals);
  }

  const sizeText = formatSpotAmount(baseSize, base.symbol);
  if (compareDecimal(baseSize, market.minSize) < 0 || BigInt(minOut.atoms) <= BigInt(0)) {
    const floor = formatSpotAmount(market.minSize, base.symbol);
    return hold(
      'too_small',
      buying
        ? `That buys about ${sizeText} at the best ask. The market takes no order under ${floor}.`
        : `The market takes no order under ${floor}.`,
    );
  }
  if (compareDecimal(baseSize, market.maxSize) > 0) {
    const cap = formatSpotAmount(market.maxSize, base.symbol);
    return hold(
      'too_large',
      buying
        ? `That buys about ${sizeText} at the best ask. The market takes no order over ${cap}.`
        : `The market takes no order over ${cap}.`,
    );
  }
  if (input.balance && compareDecimal(spend, input.balance) > 0) {
    const held = formatSpotAmount(input.balance, spendToken.symbol);
    return hold(
      'balance',
      buying
        ? `This wallet holds ${held}. Get test ${quote.symbol} or enter less.`
        : `This wallet holds ${held}. Buy some first or enter less.`,
    );
  }

  return {
    ok: true,
    order: {
      side,
      spendToken,
      receiveToken,
      spend,
      sizeArg,
      minOut,
      expectedOut,
      bestPrice: best.price,
      baseSize,
      exceedsBest: compareDecimal(baseSize, best.size) > 0,
      takerFeeBps: market.takerFeeBps,
      slippageBps,
    },
  };
}

// --- The wallet ----------------------------------------------------------------

/** What the signing wallet holds, and what the market may already move of each token. */
export interface SpotWallet {
  address: string;
  /** The chain's own coin, which pays for gas. */
  native: Decimal;
  nativeSymbol: string;
  base: Decimal;
  quote: Decimal;
  baseAllowance: Decimal;
  quoteAllowance: Decimal;
}

/** Whether the order needs an approval first: the market may not yet move what the order spends. */
export function approvalNeeded(order: SpotOrder, wallet: SpotWallet): boolean {
  const allowance = order.side === 'buy' ? wallet.quoteAllowance : wallet.baseAllowance;
  return compareDecimal(allowance, order.spend) < 0;
}

// --- Why a ticket is held --------------------------------------------------------

export type SpotAvailability = { state: 'ready' } | { state: 'no_wallet'; message: string };

export const SPOT_NO_WALLET = 'No wallet is available to sign with yet. Sign in again and Kanon will create one.';
export const SPOT_CHECKING_SESSION = 'Checking who is signed in.';
export const SPOT_READING_WALLET = 'Reading the wallet.';
export const SPOT_WALLET_UNREAD = 'The wallet could not be read. Trying again.';
export const SPOT_BOOK_STALE = 'The last read of the book failed. Orders wait until it has been read again.';

/** The network a chain id names, as a sentence says it. */
export function chainName(chainId: number): string {
  if (chainId === monadTestnet.id) return `${monadTestnet.name} (chain ${chainId})`;
  if (chainId === monad.id) return `${monad.name} mainnet (chain ${chainId})`;
  return `chain ${chainId}`;
}

/** The app is set to one chain and the market lives on another: nothing can be sent from here, and that is all. */
export function wrongChainLine(marketChainId: number, clientChainId: number): string {
  return `This market is on ${chainName(marketChainId)}. This build of the app is set to ${chainName(clientChainId)}, so orders are off here.`;
}

export function noGasLine(nativeSymbol: string): string {
  return `This wallet holds no testnet ${nativeSymbol}. Every transaction needs a little for gas, so nothing can be sent until it has some.`;
}

export type SpotWalletRead =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; wallet: SpotWallet }
  | { status: 'unread'; message: string };

export type SpotGate =
  /** Nobody is signed in: the book is shown and the ticket is the way to sign in. */
  | { kind: 'sign_in' }
  /** Signed in, and nothing can be sent yet. The sentence says why, calmly. */
  | { kind: 'hold'; message: string }
  | { kind: 'open'; wallet: SpotWallet };

/** Whether the ticket can take an order, and the one sentence that says why not. Checked in the order a person meets them. */
export function spotGate(input: {
  session: { pending: boolean; signedIn: boolean };
  availability: SpotAvailability;
  clientChainId: number;
  market: Pick<SpotMarket, 'chainId'>;
  wallet: SpotWalletRead;
}): SpotGate {
  const { session, availability, wallet } = input;
  if (session.pending) return { kind: 'hold', message: SPOT_CHECKING_SESSION };
  if (!session.signedIn) return { kind: 'sign_in' };
  if (availability.state !== 'ready') return { kind: 'hold', message: availability.message };
  if (input.market.chainId !== input.clientChainId) {
    return { kind: 'hold', message: wrongChainLine(input.market.chainId, input.clientChainId) };
  }
  if (wallet.status === 'unread') return { kind: 'hold', message: wallet.message };
  if (wallet.status !== 'ready') return { kind: 'hold', message: SPOT_READING_WALLET };
  if (BigInt(wallet.wallet.native.atoms) <= BigInt(0)) {
    return { kind: 'hold', message: noGasLine(wallet.wallet.nativeSymbol) };
  }
  return { kind: 'open', wallet: wallet.wallet };
}

// --- What the confirmation states ------------------------------------------------

/** `Spend 83.272 USDC for at least 0.00098703 tkBTC.`: the order in one line, as the foot of the screen says it. */
export function orderLine(order: SpotOrder): string {
  const spend = formatSpotAmount(order.spend, order.spendToken.symbol);
  const least = formatSpotAmount(order.minOut, order.receiveToken.symbol);
  return order.side === 'buy' ? `Spend ${spend} for at least ${least}.` : `Sell ${spend} for at least ${least}.`;
}

/**
 * Everything the confirmation states, in the order it is read: the side, what
 * leaves the wallet, the price it was sized from, the fee, the bound, the least
 * accepted, and how many transactions the wallet will be asked for. `needsApproval`
 * is null while the allowance has not been read.
 */
export function orderFacts(order: SpotOrder, market: SpotMarket, needsApproval: boolean | null): Array<readonly [string, string]> {
  const { base, quote } = market;
  const buying = order.side === 'buy';
  const transactions =
    needsApproval === null ? '1 or 2: approval if needed' : needsApproval ? '2: approval, then order' : '1: the order';
  return [
    ['Side', buying ? `Buy ${base.symbol} with ${quote.symbol}` : `Sell ${base.symbol} for ${quote.symbol}`],
    [buying ? 'You spend' : 'You sell', formatSpotAmount(order.spend, order.spendToken.symbol)],
    [buying ? 'Best ask' : 'Best bid', `${formatSpotPrice(order.bestPrice)} ${quote.symbol}`],
    ['Taker fee', `${formatBps(order.takerFeeBps)}, out of what you receive`],
    ['At that price, after the fee', formatSpotAmount(order.expectedOut, order.receiveToken.symbol)],
    ['Slippage bound', formatBps(order.slippageBps)],
    ['Least received', formatSpotAmount(order.minOut, order.receiveToken.symbol)],
    ['Wallet transactions', transactions],
  ];
}

/** What the approval is for, said when one will be asked for: exactly the order's spend, never an open allowance. */
export function approvalLine(order: SpotOrder): string {
  return `The approval lets the market move exactly ${formatSpotAmount(order.spend, order.spendToken.symbol)} from this wallet, and no more.`;
}

export const FILL_OR_KILL_LINE =
  'Fill or kill: if the book cannot fill all of it inside the bound, the transaction reverts and nothing is traded.';

/** Said under the facts when the order is larger than the best level, so a revert is not a surprise. */
export function depthLine(order: SpotOrder): string | null {
  if (!order.exceedsBest) return null;
  return order.side === 'buy'
    ? 'This is more than the best ask holds, so part of it would fill at higher prices. Past the bound, it reverts.'
    : 'This is more than the best bid holds, so part of it would fill at lower prices. Past the bound, it reverts.';
}

// --- While an order is out ---------------------------------------------------------

export type SpotStep = 'checking' | 'approving' | 'approval_pending' | 'ordering' | 'order_pending';

export const STEP_LINE: Record<SpotStep, string> = {
  checking: 'Checking the wallet and the allowance.',
  approving: 'Approve the spend in your wallet. Step 1 of 2.',
  approval_pending: 'Waiting for the approval to be mined.',
  ordering: 'Confirm the order in your wallet.',
  order_pending: 'Waiting for the order to be mined.',
};

// --- Reading a fill ------------------------------------------------------------

/** `Trade.price` is an 18-decimal fixed-point value, whatever the market's own price precision. */
export const TRADE_PRICE_DECIMALS = 18;

/** One decoded `Trade` log from the market's own address. */
export interface SpotTradeLog {
  takerAddress: string;
  /** At `TRADE_PRICE_DECIMALS`. */
  price: bigint;
  /** At the market's size decimals. */
  filledSize: bigint;
}

export interface SpotFill {
  /** Everything the taker's trades filled, at the market's size decimals. */
  size: Decimal;
  /** Size-weighted, at `TRADE_PRICE_DECIMALS`. */
  averagePrice: Decimal;
  /** How many trades it took. */
  trades: number;
}

/**
 * What a receipt's `Trade` logs say was filled for `taker`: the total size and
 * the size-weighted average price. Null when no log names the taker, in which
 * case nothing is reported as a fill.
 */
export function summariseFill(logs: readonly SpotTradeLog[], taker: string, sizeDecimals: number): SpotFill | null {
  const me = taker.toLowerCase();
  const mine = logs.filter((log) => log.takerAddress.toLowerCase() === me && log.filledSize > BigInt(0));
  if (mine.length === 0) return null;
  const size = mine.reduce((sum, log) => sum + log.filledSize, BigInt(0));
  const weighted = mine.reduce((sum, log) => sum + log.price * log.filledSize, BigInt(0));
  return {
    size: dec(size, sizeDecimals),
    averagePrice: dec(weighted / size, TRADE_PRICE_DECIMALS),
    trades: mine.length,
  };
}

/**
 * An amount at `decimals` places. With fewer places than it has, the rest is
 * cut, never rounded up: an 18-decimal trade price shown at the market's four,
 * a gas balance shown at four.
 */
export function floorToDecimals(d: Decimal, decimals: number): Decimal {
  if (d.decimals <= decimals) return dec(BigInt(d.atoms) * pow10(decimals - d.decimals), decimals);
  return dec(BigInt(d.atoms) / pow10(d.decimals - decimals), decimals);
}

// --- Evidence ------------------------------------------------------------------

/** The explorer for the chain the market is on. The market's chain, not the one this client is configured for. */
function explorerOf(chainId: number): { name: string; url: string } | null {
  if (chainId === monadTestnet.id) return monadTestnet.blockExplorers.default;
  if (chainId === monad.id) return monad.blockExplorers.default;
  return null;
}

/** A transaction on the market's own explorer, or null where the chain has none this client knows. */
export function spotTx(chainId: number, txHash: string): TxRef | null {
  const explorer = explorerOf(chainId);
  if (!explorer) return null;
  return {
    hash: txHash,
    short: abbreviateHash(txHash, 6, 4),
    url: explorerUrl(explorer.url, 'tx', encodeURIComponent(txHash)),
    explorer: explorer.name,
  };
}

export interface AddressRef {
  address: string;
  /** `0x12ab34…cd56`. */
  short: string;
  url: string;
  explorer: string;
}

export function spotAddress(chainId: number, address: string): AddressRef | null {
  const explorer = explorerOf(chainId);
  if (!explorer) return null;
  return {
    address,
    short: abbreviateHash(address, 6, 4),
    url: explorerUrl(explorer.url, 'address', encodeURIComponent(address)),
    explorer: explorer.name,
  };
}

/** The contracts behind the market and the transactions that listed it, each with its explorer page. */
export function marketEvidence(market: SpotMarket): {
  addresses: Array<{ label: string; address: string; ref: AddressRef | null }>;
  transactions: Array<{ name: string; tx: TxRef }>;
} {
  // Each token under its full name, not its symbol: `Mock USDC` says what `USDC` alone would not.
  const contracts: Array<readonly [string, string]> = [
    ['Order book', market.market],
    [market.base.name, market.base.address],
    [market.quote.name, market.quote.address],
  ];
  const listed: Array<readonly [string, string | undefined]> = [
    ['Token deploy', market.listing.tokenTx],
    ['Market listing', market.listing.marketTx],
    ['First liquidity', market.listing.liquidityTx],
    ['First order', market.listing.firstOrderTx],
  ];
  const transactions: Array<{ name: string; tx: TxRef }> = [];
  for (const [name, hash] of listed) {
    const tx = hash ? spotTx(market.chainId, hash) : null;
    if (tx) transactions.push({ name, tx });
  }
  return {
    addresses: contracts.map(([label, address]) => ({ label, address, ref: spotAddress(market.chainId, address) })),
    transactions,
  };
}

// --- The answer to an order --------------------------------------------------------

export type SpotFailure =
  | 'no_wallet'
  /** The wallet, or the app, is on another chain than the market. Nothing was sent. */
  | 'wrong_chain'
  /** The wallet cannot pay for gas. Nothing was sent. */
  | 'no_gas'
  /** The person declined in their wallet. Nothing was sent. */
  | 'rejected'
  /** The order reverted: a fill-or-kill order that could not fill inside its bound. Nothing was traded. */
  | 'reverted'
  /** A transaction went out and its receipt could not be read. It may have gone through. */
  | 'unconfirmed'
  | 'failed';

/** What the order's receipt says, as the wallet client hands it back. */
export interface SpotOrderReceipt {
  txHash: string;
  /** Present when an approval was sent first. */
  approveTxHash?: string;
  /** Null when the transaction succeeded and no `Trade` log naming the wallet was found. */
  fill: SpotFill | null;
}

export const REVERTED_LINE =
  'The order reverted, so nothing was traded. A fill-or-kill order reverts when the book cannot fill all of it inside your bound. That is the bound working.';
export const FILL_UNREAD_LINE =
  'The transaction succeeded, but its fill could not be read from the receipt. Open the transaction to see what traded.';

/** Which of the wallet's transactions a link is to. */
export type SpotTxKind = 'mint' | 'approve' | 'order';

const TX_NAME: Record<SpotTxKind, string> = { mint: 'Mint', approve: 'Approval', order: 'Order' };

/** An answer, as the screen draws it: a neutral title, what it says, its figures and its transactions. */
export interface SpotOutcomeView {
  /** `done` takes the check mark. Everything else is set the same neutral way, a revert included. */
  mark: 'done' | 'note';
  title: string;
  line: string | null;
  facts: Array<readonly [string, string]>;
  /** Each transaction that went out, named: the approval when there was one, then the order. */
  links: Array<{ name: string; tx: TxRef }>;
}

function links(chainId: number, entries: ReadonlyArray<readonly [SpotTxKind, string | undefined]>): SpotOutcomeView['links'] {
  const out: SpotOutcomeView['links'] = [];
  for (const [kind, hash] of entries) {
    const tx = hash ? spotTx(chainId, hash) : null;
    if (tx) out.push({ name: TX_NAME[kind], tx });
  }
  return out;
}

export function filledOutcome(receipt: SpotOrderReceipt, order: SpotOrder, market: SpotMarket): SpotOutcomeView {
  const sent = links(market.chainId, [
    ['approve', receipt.approveTxHash],
    ['order', receipt.txHash],
  ]);
  if (!receipt.fill) {
    return { mark: 'note', title: 'SENT, FILL NOT READ', line: FILL_UNREAD_LINE, facts: [], links: sent };
  }
  const { fill } = receipt;
  // The size the trades filled, as the market logged it. It is not what the wallet received: the
  // fee comes out of that, which the line under the figures says.
  const facts: Array<readonly [string, string]> = [
    ['Filled size', formatSpotAmount(fill.size, market.base.symbol)],
    ['Average price', `${formatSpotPrice(floorToDecimals(fill.averagePrice, market.priceDecimals))} ${market.quote.symbol}`],
  ];
  if (fill.trades > 1) facts.push(['Trades', String(fill.trades)]);
  return {
    mark: 'done',
    title: order.side === 'buy' ? 'BUY FILLED' : 'SELL FILLED',
    line: `The ${formatBps(order.takerFeeBps)} taker fee comes out of the ${order.receiveToken.symbol} the wallet receives.`,
    facts,
    links: sent,
  };
}

const FAILURE_TITLE: Record<SpotFailure, string> = {
  no_wallet: 'NOT SENT',
  wrong_chain: 'NOT SENT',
  no_gas: 'NOT SENT',
  rejected: 'NOT SENT',
  reverted: 'NOT FILLED',
  unconfirmed: 'SENT, NOT CONFIRMED',
  failed: 'NOT COMPLETED',
};

/** What a client's failure carries: its code, its own sentence, and the transaction it is about when one went out. */
export interface SpotFailureInfo {
  code: SpotFailure;
  message: string;
  txHash?: string | undefined;
  txKind?: SpotTxKind | undefined;
}

/** An order that did not fill, said in the client's own sentence. Never an alarm: a revert is the bound working. */
export function failedOutcome(failure: SpotFailureInfo, market: SpotMarket): SpotOutcomeView {
  return {
    mark: 'note',
    title: FAILURE_TITLE[failure.code],
    line: failure.message,
    facts: [],
    links: links(market.chainId, [[failure.txKind ?? 'order', failure.txHash]]),
  };
}

/** `Get 1,000 test USDC`: the mint, named for what it gives. */
export function mintLabel(market: Pick<SpotMarket, 'quote'>): string {
  return `Get ${compactDecimal(testMintAmount(market))} test ${market.quote.symbol}`;
}

/** What a mint came to, as a sentence and its transaction. */
export interface SpotMintNote {
  line: string;
  links: SpotOutcomeView['links'];
}

export function mintedNote(market: SpotMarket, txHash: string): SpotMintNote {
  return {
    line: `${formatSpotAmount(testMintAmount(market), market.quote.name)} minted to this wallet.`,
    links: links(market.chainId, [['mint', txHash]]),
  };
}

export function mintFailedNote(failure: SpotFailureInfo, market: SpotMarket): SpotMintNote {
  return { line: failure.message, links: links(market.chainId, [['mint', failure.txHash]]) };
}

/** `tkBTC is Kanon Test BTC: test token, open mint.` A token in the gateway's own words, wherever its symbol alone would not say what it is. */
export function tokenLine(token: SpotToken): string {
  return token.kind ? `${token.symbol} is ${token.name}: ${token.kind}.` : `${token.symbol} is ${token.name}.`;
}

/** `Monad testnet`, or the chain's number where this client has no name for it: the label beside the market's name. */
export function networkLabel(market: Pick<SpotMarket, 'chainId' | 'network'>): string {
  if (market.chainId === monadTestnet.id) return 'Monad testnet';
  if (market.chainId === monad.id) return 'Monad mainnet';
  return `${market.network} chain ${market.chainId}`;
}
