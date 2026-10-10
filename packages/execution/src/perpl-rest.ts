/**
 * Perpl's signed REST endpoints: the trading state of a wallet and order
 * submission over HTTP. Verified against
 * https://github.com/PerplFoundation/api-docs (rest-endpoints.md, types.md) on
 * 2026-10-10.
 *
 * `PerplClient` (perpl.ts) trades over the trading WebSocket, which suits a
 * long-running process. This is the same exchange over plain requests, for a
 * script or a server route that places an order and returns: an `OrderSpec`
 * posted here is validated, forwarded and settled exactly as an `mt: 22` frame.
 *
 * A zero status from `submit` means "accepted for forwarding", never "filled".
 * The outcome is settled a block later and read back from `positions`, `orders`
 * or `fills`.
 */

import { z } from 'zod';
import { PERPL_AUTH_HEADERS, buildRestCanonical, randomNonce, sha256Hex, type PerplSigner } from './perpl-auth';
import { PERPL_CHAIN_ID, PERPL_REST_BASE_URL, type PerplNetwork } from './perpl-constants';

/** An order as the client describes it (types.md "OrderSpec"). Prices and sizes are scaled integers. */
export interface PerplOrderSpec {
  /** Request id: must be strictly greater than the account's `lfr`. Re-sending the same one is the retry. */
  rq: number;
  mkt: number;
  acc: number;
  oid?: number;
  /** `PERPL_ORDER_TYPE`. */
  t: number;
  /** Limit price; 0 for a market order. */
  p?: number;
  s: number;
  /** Max market-order slippage, bps. */
  ms?: number;
  /** `PERPL_FLAG`. */
  fl: number;
  /** Leverage in hundredths: 200 is 2x. */
  lv: number;
  /** Last execution block, or 0 for the market's maximum window. */
  lb: number;
}

const Amount = z.union([z.string(), z.number()]).transform((v) => String(v));
const Timestamp = z.looseObject({ b: z.number(), t: z.number(), txid: z.string().optional() });

const AccountSchema = z.looseObject({
  id: z.number(),
  /** Frozen. */
  fr: z.boolean().optional(),
  /** Order forwarding ("One-Click Trading") is allowed. Orders are refused without it. */
  fw: z.boolean().optional(),
  /** Last forwarded request id. */
  lfr: z.number().optional(),
  /** Balance, in collateral token atoms. */
  b: Amount,
  /** Locked balance. */
  lb: Amount.optional(),
});
export type PerplAccount = z.infer<typeof AccountSchema>;

const WalletSchema = z.looseObject({ sn: z.number(), addr: z.string(), as: z.array(AccountSchema) });
export type PerplWallet = z.infer<typeof WalletSchema>;

/**
 * A time the venue may leave blank. The docs give a position's `at` a block
 * and a time; the live REST snapshot sends `at: {}` and puts the open time in
 * `ots` (seen on testnet, 2026-10-10).
 */
const BlankableTimestamp = z.looseObject({ b: z.number().optional(), t: z.number().optional() });

const PositionSchema = z.looseObject({
  at: BlankableTimestamp.optional(),
  /** When it was opened. */
  ots: BlankableTimestamp.optional(),
  mkt: z.number(),
  acc: z.number(),
  pid: z.number(),
  /** `PositionStatus`: 1 open, 2 closed, 3 liquidated, 4 deleveraged, 5 unwound, 6 failed. */
  st: z.number().optional(),
  /** 1 long, 2 short. */
  sd: z.number(),
  /** Entry price, scaled. */
  ep: z.number(),
  s: z.number(),
  lv: z.number(),
  /** Collateral. */
  c: Amount,
});
export type PerplPosition = z.infer<typeof PositionSchema>;

/** A position that is still held: status open (or unstated) with a size. */
export const isOpenPosition = (p: PerplPosition): boolean => (p.st === undefined || p.st === 1) && p.s > 0;

const FillSchema = z.looseObject({
  at: Timestamp,
  mkt: z.number(),
  acc: z.number(),
  oid: z.number(),
  t: z.number(),
  p: z.number().optional(),
  s: z.number(),
  /** Fee; negative is a rebate. */
  f: Amount,
});
export type PerplFill = z.infer<typeof FillSchema>;

const Status = z.looseObject({ code: z.number(), error: z.string().optional() });
const BatchStatusSchema = z.looseObject({ status: Status, statuses: z.array(Status).optional() });
export type PerplOrderStatus = z.infer<typeof Status>;

export class PerplRestError extends Error {
  constructor(
    readonly status: number,
    readonly target: string,
    detail: string,
  ) {
    super(`Perpl ${target} answered HTTP ${status}: ${detail}`);
    this.name = 'PerplRestError';
  }
}

export interface PerplRestOptions {
  network: PerplNetwork;
  /** The opaque `X-API-Key` token. */
  apiKey: string;
  signer: PerplSigner;
  fetchImpl?: typeof fetch;
  restBaseUrl?: string;
  now?: () => number;
  nonce?: () => string;
}

export interface PerplRest {
  /** The wallet and its exchange accounts. HTTP 404 means the wallet has no exchange account. */
  wallet(): Promise<PerplWallet>;
  positions(): Promise<PerplPosition[]>;
  /** The most recent fills, newest first as the venue returns them. */
  fills(count: number): Promise<PerplFill[]>;
  /**
   * Submits orders in the sequence given. Returns one status per order, at the
   * position of the order it answers; code 0 is accepted for forwarding.
   * Throws when the request as a whole was refused.
   */
  submit(orders: PerplOrderSpec[]): Promise<PerplOrderStatus[]>;
}

export function createPerplRest(opts: PerplRestOptions): PerplRest {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.restBaseUrl ?? PERPL_REST_BASE_URL[opts.network];
  const chainId = PERPL_CHAIN_ID[opts.network];
  const now = opts.now ?? Date.now;
  const nonce = opts.nonce ?? randomNonce;

  /** `target` is the path and query as sent, without the "/api" prefix: that is what gets signed. */
  async function request(method: 'GET' | 'POST', target: string, body?: unknown): Promise<unknown> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(now());
    const requestNonce = nonce();
    const canonical = buildRestCanonical({
      chainId,
      method,
      target,
      timestamp,
      nonce: requestNonce,
      bodyHashHex: await sha256Hex(payload),
    });
    const res = await fetchImpl(`${base}${target}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        [PERPL_AUTH_HEADERS.apiKey]: opts.apiKey,
        [PERPL_AUTH_HEADERS.timestamp]: timestamp,
        [PERPL_AUTH_HEADERS.nonce]: requestNonce,
        [PERPL_AUTH_HEADERS.signature]: await opts.signer(canonical),
      },
      ...(body === undefined ? {} : { body: payload }),
    });
    const text = await res.text();
    if (!res.ok) throw new PerplRestError(res.status, target, text.slice(0, 300) || res.statusText);
    return JSON.parse(text);
  }

  return {
    async wallet() {
      return WalletSchema.parse(await request('GET', '/v1/trading/wallet'));
    },
    async positions() {
      const page = z.looseObject({ d: z.array(PositionSchema) }).parse(await request('GET', '/v1/trading/positions'));
      return page.d;
    },
    async fills(count) {
      const page = z.looseObject({ d: z.array(FillSchema) }).parse(await request('GET', `/v1/trading/fills?count=${count}`));
      return page.d;
    },
    async submit(orders) {
      if (orders.length === 0 || orders.length > 100) throw new Error('a batch carries 1 to 100 orders');
      const answer = BatchStatusSchema.parse(await request('POST', '/v1/trading/orders', { d: orders }));
      if (answer.status.code !== 0 || !answer.statuses) {
        throw new PerplRestError(answer.status.code, '/v1/trading/orders', answer.status.error ?? 'refused');
      }
      return answer.statuses;
    },
  };
}

/**
 * The size, in the market's scaled units, that `usdNotional` buys at
 * `scaledPrice`. Rounded down, so the order never exceeds the notional asked
 * for. Integer arithmetic throughout.
 */
export function sizeForNotional(args: {
  usdNotional: number;
  scaledPrice: number;
  priceDecimals: number;
  sizeDecimals: number;
}): number {
  const { usdNotional, scaledPrice, priceDecimals, sizeDecimals } = args;
  if (!Number.isInteger(usdNotional) || usdNotional <= 0) throw new Error('notional must be a positive whole number of dollars');
  if (!Number.isInteger(scaledPrice) || scaledPrice <= 0) throw new Error('price must be a positive scaled integer');
  const scale = 10n ** BigInt(priceDecimals + sizeDecimals);
  return Number((BigInt(usdNotional) * scale) / BigInt(scaledPrice));
}
