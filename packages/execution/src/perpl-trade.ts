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
  // Asked together: each is a round trip, and neither needs the other's answer to be asked.
  const positionsRead = rest.positions().then(
    (list) => ({ list }),
    (error: unknown) => ({ error }),
  );
  let wallet;
  try {
    wallet = await rest.wallet();
  } catch (e) {
    if (e instanceof PerplRestError && e.status === 404) return null;
    throw e;
  }
  const account = wallet.as[0];
  if (!account) return null;
  const read = await positionsRead;
  if ('error' in read) throw read.error;
  const positions = read.list.filter((p) => p.acc === account.id && isOpenPosition(p));
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
  /**
   * The order took effect: the account's position on the market changed the way
   * the order asked. `fill` is the venue's own record of it (price, fee, block,
   * transaction), or null when its history had not reported the fill yet, which
   * it does seconds after the position moves. `findFill` looks again.
   */
  | {
      status: 'filled';
      requestId: number;
      fill: VenueFill | null;
      /** The position on the market after the order. Null when the order closed it. */
      position: PerplPosition | null;
      findFill: () => Promise<VenueFill | null>;
    }
  /** The venue forwarded the order and the position did not change: nothing was there to trade against, or the exchange rejected it. */
  | { status: 'unfilled'; requestId: number }
  /** The venue took the order and had not said what became of it when the wait ran out. It may still fill. */
  | { status: 'pending'; requestId: number }
  /** The venue would not take the order. `reason` is the venue's own wording. */
  | { status: 'refused'; code: number; reason: string };

export interface TradeDeps {
  rest: PerplRest;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the order to take effect before reporting `pending`. */
  settleTimeoutMs?: number;
  /** The pause between looks at the position. Each look is one request; the venue's rate limit is not published. */
  pollMs?: number;
  now?: () => number;
}

/** How far back the fill history is read. An order produces one fill, or a few. */
const HISTORY_DEPTH = 20;
/** The request counter is read on every third look, and once more when the wait runs out. */
const FORWARD_CHECK_EVERY = 3;
/** Once the venue says it forwarded the order, the position is given this many more looks to move. */
const LOOKS_AFTER_FORWARD = 2;

const fillKey = (f: PerplFill): string => `${f.at.b}:${f.oid}:${f.s}:${f.t}`;

const toVenueFill = (f: PerplFill): VenueFill => ({
  price: f.p ?? null,
  size: f.s,
  fee: f.f,
  block: f.at.b,
  time: f.at.t,
  txHash: f.at.txid ? (f.at.txid.startsWith('0x') ? f.at.txid : `0x${f.at.txid}`) : null,
});

interface Watch {
  /** The account's fills as read just before the order, when the caller already has them. */
  history?: readonly PerplFill[] | undefined;
  /** Whether the position on the order's market, as it now stands (null: none), shows the order took effect. */
  took(position: PerplPosition | null): boolean;
}

/**
 * Submits one order and waits for it to take effect.
 *
 * Acceptance is only an acknowledgement: the venue forwards the order to the
 * exchange and it settles a block or two later. What tells us it settled is the
 * account's position, which the venue serves as live state. The fill history is
 * a separate record that trails the position by seconds (once by more than
 * twenty, 2026-10-10), so it is read for the fill's details and never waited on
 * to decide whether the order filled.
 *
 * If the position has not moved, the account's request counter says whether the
 * venue has forwarded the order yet. Forwarded and unmoved a few looks later is
 * `unfilled`. Not known to be forwarded when the wait runs out is `pending`:
 * nothing here claims an order did not fill without evidence that it did not.
 */
async function submitAndSettle(deps: TradeDeps, order: PerplOrderSpec, watch: Watch): Promise<MarketOrderOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const before = new Set((watch.history ?? (await deps.rest.fills(HISTORY_DEPTH))).map(fillKey));

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

  /** The newest fill on the order's market and account that was not in the history before it went in. */
  const findFill = async (): Promise<VenueFill | null> => {
    const fresh = (await deps.rest.fills(HISTORY_DEPTH)).filter(
      (f) => f.mkt === order.mkt && f.acc === order.acc && !before.has(fillKey(f)),
    );
    const fill = fresh.sort((a, b) => b.at.b - a.at.b)[0];
    return fill ? toVenueFill(fill) : null;
  };

  const deadline = now() + (deps.settleTimeoutMs ?? 20_000);
  /** Looks at the position since the venue said it forwarded the order. Zero: not known to be forwarded. */
  let sinceForward = 0;
  for (let look = 1; ; look++) {
    await sleep(deps.pollMs ?? 600);
    const position =
      (await deps.rest.positions()).find((p) => p.acc === order.acc && p.mkt === order.mkt && isOpenPosition(p)) ?? null;
    if (watch.took(position)) {
      // One look at the history now. It often has nothing yet, and that is not a failure.
      const fill = await findFill().catch(() => null);
      return { status: 'filled', requestId: order.rq, fill, position, findFill };
    }

    const late = now() >= deadline;
    if (sinceForward > 0) sinceForward++;
    else if (look % FORWARD_CHECK_EVERY === 0 || late) {
      const lfr = (await deps.rest.wallet()).as.find((a) => a.id === order.acc)?.lfr ?? 0;
      if (lfr >= order.rq) sinceForward = 1;
    }
    if (sinceForward > LOOKS_AFTER_FORWARD) {
      // Forwarded, and blocks later the position is as it was. A fill in the history would still be a fill.
      const fill = await findFill();
      return fill
        ? { status: 'filled', requestId: order.rq, fill, position, findFill }
        : { status: 'unfilled', requestId: order.rq };
    }
    if (late && sinceForward === 0) return { status: 'pending', requestId: order.rq };
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
  /** The position the account already holds on this market, on the same side, when the order adds to one. */
  held?: PerplPosition | null | undefined;
  /** The account's fills as read just before, when the caller already has them. Read here otherwise. */
  history?: readonly PerplFill[] | undefined;
}

/**
 * Opens a position at market, or adds to the one held on the same side. The
 * caller has already checked the account may trade. It took effect when the
 * position is larger than it was.
 */
export function openAtMarket(deps: TradeDeps, args: OpenArgs): Promise<MarketOrderOutcome> {
  const sizeBefore = args.held?.s ?? 0;
  return submitAndSettle(
    deps,
    {
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
    },
    { history: args.history, took: (position) => position !== null && position.s > sizeBefore },
  );
}

/** Closes the whole of a position at market. It took effect when the position is gone, or smaller than it was. */
export function closeAtMarket(
  deps: TradeDeps,
  args: {
    account: PerplAccount;
    position: PerplPosition;
    slippageBps: number;
    history?: readonly PerplFill[] | undefined;
  },
): Promise<MarketOrderOutcome> {
  const { position } = args;
  return submitAndSettle(
    deps,
    {
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
    },
    { history: args.history, took: (now) => now === null || now.s < position.s },
  );
}
