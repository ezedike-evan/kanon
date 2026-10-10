/**
 * One market order on Perpl, from request to fill, as a server runs it for a
 * caller: find the market, size the order, submit it, and read back the fill
 * that settled it. `perpl-order-cli.ts` proved each step by hand on testnet
 * (2026-10-10); this is the same sequence with nothing printed and every
 * outcome returned as a value.
 *
 * An order here is always a market order sent as `p: 0`, IOC, with a slippage
 * bound. It either fills in the next block or two, or it does not fill at all:
 * nothing is left resting on the book.
 *
 * This module is the lean entry a server imports (`@kanon/execution/perpl-trade`).
 * It pulls in the signed REST client and nothing else, so no chain SDK comes
 * with it.
 */

import { z } from 'zod';
import { PERPL_FLAG, PERPL_ORDER_TYPE, PERPL_REST_BASE_URL, type PerplNetwork } from './perpl-constants';
import {
  PerplRestError,
  isOpenPosition,
  sizeForNotional,
  type PerplAccount,
  type PerplFill,
  type PerplOrderSpec,
  type PerplPosition,
  type PerplRest,
} from './perpl-rest';

export { createEd25519Signer, normalizeEd25519Secret } from './perpl-auth';
export { PERPL_CHAIN_ID, type PerplNetwork } from './perpl-constants';
export {
  PerplRestError,
  createPerplRest,
  isOpenPosition,
  sizeForNotional,
  type PerplAccount,
  type PerplFill,
  type PerplPosition,
  type PerplRest,
} from './perpl-rest';

/** Perpl's collateral, AUSD, has six decimals on both networks. Balances, collateral and fees are in its atoms. */
export const PERPL_COLLATERAL_DECIMALS = 6;

export interface PerplMarketInfo {
  id: number;
  /** The base asset, upper case: `BTC`. */
  symbol: string;
  priceDecimals: number;
  sizeDecimals: number;
  /** The highest leverage the market opens at, in hundredths (1500 is 15x). */
  maxLeverage: number;
  open: boolean;
}

type Fetch = typeof fetch;

export interface PerplPublicOptions {
  network: PerplNetwork;
  fetchImpl?: Fetch;
  restBaseUrl?: string;
}

const ContextSchema = z.looseObject({
  markets: z.array(
    z.looseObject({
      id: z.number(),
      symbol: z.string(),
      name: z.string(),
      config: z.looseObject({
        price_decimals: z.number(),
        size_decimals: z.number(),
        is_open: z.boolean(),
        initial_margin: z.number(),
      }),
    }),
  ),
});

async function getPublic(opts: PerplPublicOptions, path: string): Promise<unknown> {
  const res = await (opts.fetchImpl ?? fetch)(`${opts.restBaseUrl ?? PERPL_REST_BASE_URL[opts.network]}${path}`);
  if (!res.ok) throw new PerplRestError(res.status, path, res.statusText || 'request failed');
  return res.json();
}

/** The venue's markets. Mainnet leaves `symbol` empty and carries the base in `name` (`BTC`, `BTC Perp`). */
export async function loadPerplMarkets(opts: PerplPublicOptions): Promise<PerplMarketInfo[]> {
  const context = ContextSchema.parse(await getPublic(opts, '/v1/pub/context'));
  return context.markets.map((m) => ({
    id: m.id,
    symbol: (m.symbol.trim() || m.name.trim().replace(/\s+perp$/i, '')).toUpperCase(),
    priceDecimals: m.config.price_decimals,
    sizeDecimals: m.config.size_decimals,
    maxLeverage: m.config.initial_margin,
    open: m.config.is_open,
  }));
}

/**
 * The market for an app asset (`BTC/USD`, or the bare base `BTC`), or null.
 * Every Perpl market is quoted in dollars, so any other quote has none.
 */
export function findPerplMarket(markets: readonly PerplMarketInfo[], asset: string): PerplMarketInfo | null {
  const [base, quote, ...rest] = asset.replace(/\s+/g, '').toUpperCase().split('/');
  if (!base || rest.length > 0) return null;
  if (quote !== undefined && quote !== 'USD') return null;
  return markets.find((m) => m.symbol === base) ?? null;
}

/** The mark price of a market, as the venue's scaled integer. */
export async function readPerplMarkPrice(opts: PerplPublicOptions, marketId: number): Promise<number> {
  const body = z
    .looseObject({ d: z.record(z.string(), z.looseObject({ mrk: z.number() })) })
    .parse(await getPublic(opts, `/v1/market-data/${marketId}/ticker`));
  const mark = body.d[String(marketId)]?.mrk;
  if (mark === undefined || !Number.isSafeInteger(mark) || mark <= 0) {
    throw new Error(`Perpl returned no mark price for market ${marketId}`);
  }
  return mark;
}

/** The first exchange account of the key's wallet, and what it holds open. Null when the wallet has no account. */
export async function readPerplAccount(
  rest: PerplRest,
): Promise<{ wallet: string; account: PerplAccount; positions: PerplPosition[] } | null> {
  let wallet;
  try {
    wallet = await rest.wallet();
  } catch (e) {
    if (e instanceof PerplRestError && e.status === 404) return null;
    throw e;
  }
  const account = wallet.as[0];
  if (!account) return null;
  const positions = (await rest.positions()).filter((p) => p.acc === account.id && isOpenPosition(p));
  return { wallet: wallet.addr, account, positions };
}

export interface VenueFill {
  /** Scaled by the market's price decimals. */
  price: number | null;
  /** Scaled by the market's size decimals. */
  size: number;
  /** Collateral atoms; negative is a rebate. */
  fee: string;
  block: number;
  /** Milliseconds. */
  time: number;
  /** The settling transaction, 0x-prefixed, when the venue reports one. */
  txHash: string | null;
}

export type MarketOrderOutcome =
  /** The order settled. */
  | { status: 'filled'; requestId: number; fill: VenueFill }
  /** The venue took the order but nothing filled in time: for an IOC order, nothing was there to trade against. */
  | { status: 'unfilled'; requestId: number }
  /** The venue would not take the order. `reason` is the venue's own wording. */
  | { status: 'refused'; code: number; reason: string };

export interface TradeDeps {
  rest: PerplRest;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the fill before reporting `unfilled`. */
  settleTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
}

const fillKey = (f: PerplFill): string => `${f.at.b}:${f.oid}:${f.s}:${f.t}`;

const toVenueFill = (f: PerplFill): VenueFill => ({
  price: f.p ?? null,
  size: f.s,
  fee: f.f,
  block: f.at.b,
  time: f.at.t,
  txHash: f.at.txid ? (f.at.txid.startsWith('0x') ? f.at.txid : `0x${f.at.txid}`) : null,
});

/**
 * Submits one order and waits for the fill it produces. The fill is the newest
 * one on that market and account that was not in the history before the order
 * went in.
 */
async function submitAndSettle(deps: TradeDeps, order: PerplOrderSpec): Promise<MarketOrderOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const before = new Set((await deps.rest.fills(20)).map(fillKey));

  let status;
  try {
    [status] = await deps.rest.submit([order]);
  } catch (e) {
    // The request as a whole was refused: bad scope, frozen account, forwarding off.
    if (e instanceof PerplRestError) return { status: 'refused', code: e.status, reason: e.message };
    throw e;
  }
  if (!status || status.code !== 0) {
    return { status: 'refused', code: status?.code ?? -1, reason: status?.error ?? 'the venue returned no status' };
  }

  const deadline = now() + (deps.settleTimeoutMs ?? 20_000);
  for (;;) {
    const fresh = (await deps.rest.fills(20)).filter(
      (f) => f.mkt === order.mkt && f.acc === order.acc && !before.has(fillKey(f)),
    );
    const fill = fresh.sort((a, b) => b.at.b - a.at.b)[0];
    if (fill) return { status: 'filled', requestId: order.rq, fill: toVenueFill(fill) };
    if (now() >= deadline) return { status: 'unfilled', requestId: order.rq };
    await sleep(deps.pollMs ?? 1_500);
  }
}

export interface OpenArgs {
  market: PerplMarketInfo;
  account: PerplAccount;
  side: 'long' | 'short';
  /** In the market's scaled size units. See `sizeForNotional`. */
  size: number;
  /** In hundredths: 200 is 2x. */
  leverage: number;
  slippageBps: number;
}

/** Opens a position at market. The caller has already checked the account may trade and holds nothing on this market. */
export function openAtMarket(deps: TradeDeps, args: OpenArgs): Promise<MarketOrderOutcome> {
  return submitAndSettle(deps, {
    rq: (args.account.lfr ?? 0) + 1,
    mkt: args.market.id,
    acc: args.account.id,
    t: args.side === 'short' ? PERPL_ORDER_TYPE.openShort : PERPL_ORDER_TYPE.openLong,
    p: 0,
    s: args.size,
    ms: args.slippageBps,
    fl: PERPL_FLAG.ioc,
    lv: args.leverage,
    lb: 0,
  });
}

/** Closes the whole of a position at market. */
export function closeAtMarket(
  deps: TradeDeps,
  args: { account: PerplAccount; position: PerplPosition; slippageBps: number },
): Promise<MarketOrderOutcome> {
  const { position } = args;
  return submitAndSettle(deps, {
    rq: (args.account.lfr ?? 0) + 1,
    mkt: position.mkt,
    acc: position.acc,
    t: position.sd === 2 ? PERPL_ORDER_TYPE.closeShort : PERPL_ORDER_TYPE.closeLong,
    p: 0,
    s: position.s,
    ms: args.slippageBps,
    fl: PERPL_FLAG.ioc,
    lv: position.lv,
    lb: 0,
  });
}
