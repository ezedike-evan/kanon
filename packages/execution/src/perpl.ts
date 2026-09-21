/**
 * Perpl execution client: perps, per docs/ARCHITECTURE.md ("Perpl for perps").
 *
 * Built against Perpl's published API docs
 * (https://docs.perpl.xyz, https://github.com/PerplFoundation/api-docs),
 * re-verified 2026-09-20. Every wire fact below comes from those docs; the
 * few things they do not pin down are listed in README.md under "needs a live
 * account" rather than papered over.
 *
 * Shape of the venue:
 *   - Orders and their lifecycle travel over the trading WebSocket
 *     (`/ws/v1/trading`). The client sends an `mt: 22` command and gets, in
 *     order: an `mt: 3` StatusResponse (code 0 = accepted for forwarding,
 *     NOT a fill), then `mt: 24` order updates, then `mt: 25` fills.
 *   - Prices (`p`) and sizes (`s`) are integers scaled by the market's
 *     `price_decimals` / `size_decimals`, read from `GET /v1/pub/context`.
 *   - Stop-loss and take-profit are native trigger orders: a Close order
 *     (`t: 3/4`) with a trigger price (`tp`) and condition (`tpc`), optionally
 *     linked to the entry request (`tr`) so they activate only if the entry
 *     trades. That is why this client is `NativeTriggerCapable`: protection
 *     lives on the venue and survives this process dying.
 *   - Authentication does not create an exchange account, and an account does
 *     not by itself allow API trading. `createAccount(uint256)` and
 *     `allowOrderForwarding(true)` are separate on-chain calls from the
 *     account's own wallet; see README.md. This client can never grant itself
 *     that permission. It reads `fw` from the wallet snapshot and refuses to
 *     send orders it knows the contract will refuse.
 */

import { z } from 'zod';
import type { Decimal, PriceTick } from '@kanon/spec';
import {
  buildRestCanonical,
  buildWsSignInCanonical,
  PERPL_AUTH_HEADERS,
  randomNonce,
  sha256Hex,
  type PerplSigner,
  type PerplWsSignInFrame,
} from './perpl-auth';
import {
  PERPL_CHAIN_ID,
  PERPL_FLAG,
  PERPL_MT,
  PERPL_ORDER_STATUS,
  PERPL_ORDER_TYPE,
  PERPL_REST_BASE_URL,
  PERPL_STATUS_REASON_ORDER_FORWARDING_NOT_ALLOWED,
  PERPL_TRIGGER,
  PERPL_WS_URL,
  type PerplNetwork,
} from './perpl-constants';
import { PerplMarketRegistry, type PerplMarketInfo } from './perpl-markets';
import { fromScaled, isPositive, toScaledNumber, type RoundingMode } from './scaling';
import type {
  CancelResult,
  ExecutionClient,
  NativeTriggerCapable,
  Order,
  OrderResult,
  Position,
  TriggerOrder,
  Unsubscribe,
} from './types';

export * from './perpl-constants';
export * from './perpl-auth';
export * from './perpl-markets';
export * from './perpl-enroll';

// ---------------------------------------------------------------------------
// Wire frames
// ---------------------------------------------------------------------------

/** An `mt: 22` command. Field meanings are from websocket.md "Placing Orders". */
export interface PerplOrderFrame {
  mt: 22;
  /** Unique non-zero; echoed back as `cid` on the mt:3 ack. */
  sn: number;
  /** Request id: strictly increasing per account; it is the idempotency key. */
  rq: number;
  mkt: number;
  acc: number;
  oid?: number;
  t: number;
  /** Scaled limit price; 0 = market. */
  p: number;
  /** Scaled size. */
  s: number;
  fl: number;
  /** Leverage in hundredths (1000 = 10x). */
  lv: number;
  /** Last execution block; 0 = the market's maximum window. */
  lb: number;
  /** Max market-order slippage, bps. Omitted = the market's own default. */
  ms?: number;
  /** Trigger price and condition (stop / take-profit). */
  tp?: number;
  tpc?: number;
  /** Linked request id: activate when that request trades, cancel if it fails. */
  tr?: number;
}

const StatusResponseSchema = z.looseObject({
  mt: z.literal(PERPL_MT.commandAck),
  cid: z.number().optional(),
  status: z.looseObject({ code: z.number(), error: z.string().optional() }),
});

const OrderUpdateSchema = z.looseObject({
  rq: z.number(),
  mkt: z.number(),
  oid: z.number().optional(),
  st: z.number(),
  sr: z.number().optional(),
  fr: z.number().optional(),
  t: z.number().optional(),
  fs: z.number().optional(),
  fp: z.number().optional(),
  os: z.number().optional(),
});
export type PerplOrderUpdate = z.infer<typeof OrderUpdateSchema>;

const PositionRowSchema = z.looseObject({
  mkt: z.number(),
  pid: z.number().optional(),
  sd: z.number(), // 1 long, 2 short
  s: z.number(),
  ep: z.number(),
});
type PerplPositionRow = z.infer<typeof PositionRowSchema>;

const FillRowSchema = z.looseObject({
  mkt: z.number(),
  oid: z.number(),
  t: z.number().optional(),
  l: z.number().optional(), // 1 maker, 2 taker
  p: z.number().optional(),
  s: z.number(),
  f: z.string().optional(),
});

export interface PerplFill {
  marketId: number;
  orderId: number;
  liquidity: 'maker' | 'taker' | undefined;
  price: Decimal | undefined;
  size: Decimal;
  /** Gross fee as the venue's decimal string; protocol fee plus builder fee. */
  fee: string | undefined;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PerplClientOptions {
  network: PerplNetwork;
  /** The opaque `X-API-Key` token from enrollment. */
  apiKey: string;
  /** Signs canonical strings with the key's Ed25519 secret. */
  signer: PerplSigner;
  /** The on-chain exchange account id (from `getAccountByAddr`). */
  accountId: number;
  /** Whole-number leverage used when an order does not carry `leverageX`. Default 1. */
  defaultLeverageX?: number;
  /** Market-order slippage cap (bps) used when an order carries none. Absent
   * means the market's own default, which is the venue's, not a hidden Kanon one. */
  defaultMaxSlippageBps?: number;
  /** Milliseconds to wait for the mt:3 ack. Default 10 000. */
  ackTimeoutMs?: number;
  /** Milliseconds to wait for an mt:24 outcome after an accepted ack. Default 15 000. */
  settleTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  /** Injectable clock, unix milliseconds. */
  now?: () => number;
  nonce?: () => string;
  markets?: PerplMarketRegistry;
  restBaseUrl?: string;
  wsUrls?: { marketData: string; trading: string };
}

const WS_OPEN = 1;

interface AckOutcome {
  kind: 'ack' | 'timeout' | 'closed';
  code?: number;
  error?: string;
}

interface UpdateWaiter {
  waitTerminal: boolean;
  promise: Promise<PerplOrderUpdate | null>;
  settle: (o: PerplOrderUpdate | null) => void;
  startTimer: () => void;
  cancel: () => void;
}

function isTerminal(st: number): boolean {
  return (
    st === PERPL_ORDER_STATUS.filled ||
    st === PERPL_ORDER_STATUS.executed ||
    st === PERPL_ORDER_STATUS.canceled ||
    st === PERPL_ORDER_STATUS.expired ||
    st === PERPL_ORDER_STATUS.failed
  );
}

// ---------------------------------------------------------------------------
// Pure frame builders (exported for tests and for anyone auditing the wire)
// ---------------------------------------------------------------------------

export function perplOrderType(side: 'buy' | 'sell', reduceOnly: boolean): number {
  if (reduceOnly) return side === 'buy' ? PERPL_ORDER_TYPE.closeShort : PERPL_ORDER_TYPE.closeLong;
  return side === 'buy' ? PERPL_ORDER_TYPE.openLong : PERPL_ORDER_TYPE.openShort;
}

/** Trigger condition for a protective order. Long stop fires when mark falls
 * to the trigger; long take-profit when it rises to it; short is the mirror. */
export function perplTriggerCondition(kind: TriggerOrder['kind'], direction: TriggerOrder['direction']): number {
  const fallsTo = (kind === 'stop_loss') === (direction === 'long');
  return fallsTo ? PERPL_TRIGGER.lteMark : PERPL_TRIGGER.gteMark;
}

/** Rounding that keeps a scaled trigger on the protective side of the
 * approved price: stops round toward the current price (fire no later),
 * take-profits round toward the current price too (fire no later). */
export function perplTriggerRounding(kind: TriggerOrder['kind'], direction: TriggerOrder['direction']): RoundingMode {
  // Long stop-loss sits below price: rounding up moves it toward price.
  // Long take-profit sits above price: rounding down moves it toward price.
  const belowPrice = (kind === 'stop_loss') === (direction === 'long');
  return belowPrice ? 'ceil' : 'floor';
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class PerplClient implements ExecutionClient, NativeTriggerCapable {
  readonly venue = 'perpl' as const;
  readonly supportsNativeTriggers = true as const;

  private readonly opts: PerplClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly markets: PerplMarketRegistry;
  private readonly restBaseUrl: string;
  private readonly wsUrls: { marketData: string; trading: string };
  private readonly chainId: number;

  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private lastRq = 0;
  private lastSn = 0;

  private readonly acks = new Map<number, (o: AckOutcome) => void>();
  private readonly waiters = new Map<number, UpdateWaiter>();
  private readonly orders = new Map<number, PerplOrderUpdate>();
  private readonly rqByClientId = new Map<string, number>();
  private readonly positions = new Map<number, PerplPositionRow>();
  /** `undefined` until a wallet snapshot / account update has reported it. */
  private forwardingAllowed: boolean | undefined;
  private authError: string | undefined;

  constructor(opts: PerplClientOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
    this.now = opts.now ?? Date.now;
    this.nonce = opts.nonce ?? randomNonce;
    this.chainId = PERPL_CHAIN_ID[opts.network];
    this.restBaseUrl = opts.restBaseUrl ?? PERPL_REST_BASE_URL[opts.network];
    this.wsUrls = opts.wsUrls ?? PERPL_WS_URL[opts.network];
    this.markets =
      opts.markets ??
      new PerplMarketRegistry({ network: opts.network, restBaseUrl: this.restBaseUrl, fetchImpl: this.fetchImpl });
  }

  // ---- auth --------------------------------------------------------------

  /** The four X-API-* headers for one REST request. `target` is the path plus
   * query WITHOUT the "/api" prefix, exactly as sent. */
  async authHeaders(method: string, target: string, body = ''): Promise<Record<string, string>> {
    const timestamp = String(this.now());
    const nonce = this.nonce();
    const canonical = buildRestCanonical({
      chainId: this.chainId,
      method,
      target,
      timestamp,
      nonce,
      bodyHashHex: await sha256Hex(body),
    });
    return {
      [PERPL_AUTH_HEADERS.apiKey]: this.opts.apiKey,
      [PERPL_AUTH_HEADERS.timestamp]: timestamp,
      [PERPL_AUTH_HEADERS.nonce]: nonce,
      [PERPL_AUTH_HEADERS.signature]: await this.opts.signer(canonical),
    };
  }

  async buildSignInFrame(): Promise<PerplWsSignInFrame> {
    const timestamp = String(this.now());
    const nonce = this.nonce();
    const signature = await this.opts.signer(buildWsSignInCanonical({ chainId: this.chainId, timestamp, nonce }));
    return { mt: PERPL_MT.apiKeySignIn, chain_id: this.chainId, api_key: this.opts.apiKey, timestamp, nonce, signature };
  }

  // ---- connection --------------------------------------------------------

  private connect(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === WS_OPEN) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.wsUrls.trading);
      let opened = false;

      socket.addEventListener('open', () => {
        opened = true;
        // The first frame must be the signed ApiKeySignIn, and the server
        // closes an idle socket within 5 s (mainnet), so send it immediately.
        this.buildSignInFrame().then(
          (frame) => {
            socket.send(JSON.stringify(frame));
            this.socket = socket;
            this.authError = undefined;
            resolve(socket);
          },
          (err) => reject(err instanceof Error ? err : new Error(String(err))),
        );
      });
      socket.addEventListener('message', (event) => this.onMessage(event as MessageEvent));
      socket.addEventListener('error', () => {
        if (!opened) reject(new Error('Perpl trading WebSocket error before open'));
      });
      socket.addEventListener('close', (event) => {
        const e = event as CloseEvent;
        if (e.code === 3401) this.authError = 'Perpl closed the socket with 3401 unauthorized (bad or stale signed sign-in)';
        if (this.socket === socket) this.socket = null;
        if (!opened) reject(new Error(`Perpl trading WebSocket closed before open (${e.code ?? 'no code'})`));
        // A close carries no per-request status; anything in flight is lost
        // silently, so resolve waiters as unknown rather than as failures.
        for (const [sn, resolveAck] of this.acks) resolveAck({ kind: 'closed', error: e.reason || `closed ${e.code}` });
        this.acks.clear();
        for (const w of this.waiters.values()) w.settle(null);
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private onMessage(event: MessageEvent): void {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const mt = (msg as { mt?: unknown }).mt;

    if (mt === PERPL_MT.commandAck) {
      const parsed = StatusResponseSchema.safeParse(msg);
      if (parsed.success && parsed.data.cid !== undefined) {
        const resolveAck = this.acks.get(parsed.data.cid);
        if (resolveAck) {
          this.acks.delete(parsed.data.cid);
          resolveAck({ kind: 'ack', code: parsed.data.status.code, error: parsed.data.status.error ?? '' });
        }
      }
      return;
    }

    if (mt === PERPL_MT.orderUpdate) {
      for (const raw of arrayOf((msg as { d?: unknown }).d)) {
        const parsed = OrderUpdateSchema.safeParse(raw);
        if (parsed.success) this.onOrderUpdate(parsed.data);
      }
      return;
    }

    if (mt === PERPL_MT.positionUpdate) {
      for (const raw of arrayOf((msg as { d?: unknown }).d)) {
        const parsed = PositionRowSchema.safeParse(raw);
        if (!parsed.success) continue;
        if (parsed.data.s === 0) this.positions.delete(parsed.data.mkt);
        else this.positions.set(parsed.data.mkt, parsed.data);
      }
      return;
    }

    if (mt === PERPL_MT.walletSnapshot) {
      this.readForwardingFlag(arrayOf((msg as { as?: unknown }).as));
      return;
    }
    if (mt === PERPL_MT.accountUpdate) {
      // Documented only as "an account update (mt: 21)" carrying `fw`; read
      // it from `d` if present. See README "needs a live account".
      this.readForwardingFlag(arrayOf((msg as { d?: unknown }).d));
    }
  }

  private readForwardingFlag(accounts: unknown[]): void {
    for (const a of accounts) {
      if (typeof a === 'object' && a !== null && (a as { id?: unknown }).id === this.opts.accountId) {
        const fw = (a as { fw?: unknown }).fw;
        if (typeof fw === 'boolean') this.forwardingAllowed = fw;
      }
    }
  }

  private onOrderUpdate(o: PerplOrderUpdate): void {
    const prior = this.orders.get(o.rq);
    // Multiple updates can arrive for one rq; a terminal state is never
    // overwritten by a late non-terminal one.
    if (!prior || !isTerminal(prior.st) || isTerminal(o.st)) this.orders.set(o.rq, o);
    const waiter = this.waiters.get(o.rq);
    if (!waiter) return;
    if (isTerminal(o.st) || !waiter.waitTerminal) waiter.settle(o);
  }

  // ---- request bookkeeping ----------------------------------------------

  private nextRq(): number {
    this.lastRq = Math.max(this.lastRq + 1, this.now());
    return this.lastRq;
  }

  private nextSn(): number {
    this.lastSn += 1;
    return this.lastSn;
  }

  private awaitAck(sn: number): Promise<AckOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.acks.delete(sn);
        resolve({ kind: 'timeout' });
      }, this.opts.ackTimeoutMs ?? 10_000);
      this.acks.set(sn, (o) => {
        clearTimeout(timer);
        resolve(o);
      });
    });
  }

  private createWaiter(rq: number, waitTerminal: boolean): UpdateWaiter {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveFn!: (o: PerplOrderUpdate | null) => void;
    const promise = new Promise<PerplOrderUpdate | null>((resolve) => {
      resolveFn = resolve;
    });
    const waiter: UpdateWaiter = {
      waitTerminal,
      promise,
      settle: (o) => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(rq);
        resolveFn(o ?? this.orders.get(rq) ?? null);
      },
      startTimer: () => {
        // An update may already have landed between the ack and this call.
        const seen = this.orders.get(rq);
        if (seen && (isTerminal(seen.st) || !waitTerminal)) return waiter.settle(seen);
        timer = setTimeout(() => waiter.settle(null), this.opts.settleTimeoutMs ?? 15_000);
      },
      cancel: () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(rq);
      },
    };
    this.waiters.set(rq, waiter);
    return waiter;
  }

  private reject(clientOrderId: string, reason: string): OrderResult {
    return { venue: this.venue, clientOrderId, status: 'rejected', reason, timestamp: this.now() };
  }

  private describeFailure(o: PerplOrderUpdate): string {
    if (o.sr === PERPL_STATUS_REASON_ORDER_FORWARDING_NOT_ALLOWED) {
      return (
        'Perpl rejected the order: the account has not enabled order forwarding (sr 34, OrderForwardingNotAllowed). ' +
        'The account owner must call allowOrderForwarding(true) on the Exchange contract from their own wallet; ' +
        'this client cannot grant itself that permission.'
      );
    }
    return `Perpl order failed (sr=${o.sr ?? 'n/a'}${o.fr !== undefined ? `, fr=${o.fr}` : ''})`;
  }

  private toResult(clientOrderId: string, o: PerplOrderUpdate, market: PerplMarketInfo): OrderResult {
    const base = { venue: this.venue, clientOrderId, venueOrderId: o.oid !== undefined ? String(o.oid) : undefined, timestamp: this.now() };
    const filledSize = o.fs !== undefined && o.fs > 0 ? fromScaled(o.fs, market.sizeDecimals) : undefined;
    const avgFillPrice = o.fp !== undefined && o.fp > 0 ? fromScaled(o.fp, market.priceDecimals) : undefined;

    if (o.st === PERPL_ORDER_STATUS.failed) return { ...base, status: 'rejected', reason: this.describeFailure(o) };
    if (o.st === PERPL_ORDER_STATUS.filled || o.st === PERPL_ORDER_STATUS.executed) {
      return { ...base, status: 'filled', filledSize, avgFillPrice };
    }
    if (o.st === PERPL_ORDER_STATUS.canceled || o.st === PERPL_ORDER_STATUS.expired) {
      // IOC / FOK orders that cross only partly end "canceled" with fills.
      if (filledSize) return { ...base, status: 'filled', filledSize, avgFillPrice };
      return { ...base, status: 'rejected', reason: `Perpl order ended without a fill (st=${o.st})` };
    }
    return { ...base, status: 'pending', filledSize, avgFillPrice };
  }

  /** Sends a command and resolves it to an honest OrderResult: `pending`
   * means accepted but not yet resolved, never a guessed fill. */
  private async submit(args: {
    clientOrderId: string;
    frame: PerplOrderFrame;
    market: PerplMarketInfo;
    waitTerminal: boolean;
  }): Promise<OrderResult> {
    const { clientOrderId, frame, market, waitTerminal } = args;
    let socket: WebSocket;
    try {
      socket = await this.connect();
    } catch (err) {
      return this.reject(clientOrderId, this.authError ?? (err instanceof Error ? err.message : String(err)));
    }

    const ackP = this.awaitAck(frame.sn);
    const waiter = this.createWaiter(frame.rq, waitTerminal);
    socket.send(JSON.stringify(frame));

    const ack = await ackP;
    if (ack.kind === 'timeout' || ack.kind === 'closed') {
      waiter.cancel();
      return {
        venue: this.venue,
        clientOrderId,
        status: 'pending',
        reason:
          `no acknowledgement (${ack.kind}${ack.error ? `: ${ack.error}` : ''}); outcome unknown. ` +
          `Reconcile on the order stream before retrying, and retry with the same clientOrderId so the venue dedups on rq ${frame.rq}.`,
        timestamp: this.now(),
      };
    }
    if (ack.code !== 0) {
      waiter.cancel();
      return this.reject(clientOrderId, `Perpl rejected the command (code ${ack.code}): ${ack.error ?? ''}`.trim());
    }

    waiter.startTimer();
    const update = await waiter.promise;
    if (!update) {
      return {
        venue: this.venue,
        clientOrderId,
        status: 'pending',
        reason: 'accepted for forwarding; no order update received before the settle timeout',
        timestamp: this.now(),
      };
    }
    return this.toResult(clientOrderId, update, market);
  }

  private baseFrame(market: PerplMarketInfo, rq: number, leverageX: number): Pick<PerplOrderFrame, 'mt' | 'sn' | 'rq' | 'mkt' | 'acc' | 'lv' | 'lb'> {
    return {
      mt: PERPL_MT.command,
      sn: this.nextSn(),
      rq,
      mkt: market.id,
      acc: this.opts.accountId,
      lv: Math.round(leverageX * 100),
      lb: 0,
    };
  }

  private leverageOf(explicit: number | undefined): number | string {
    const x = explicit ?? this.opts.defaultLeverageX ?? 1;
    if (!Number.isInteger(x) || x < 1) return `leverage must be a whole number >= 1, got ${x}`;
    return x;
  }

  private async preflight(
    asset: string,
    clientOrderId: string,
  ): Promise<{ market: PerplMarketInfo } | { refusal: OrderResult }> {
    const resolved = await this.markets.resolve(asset);
    if (!resolved.ok) return { refusal: this.reject(clientOrderId, resolved.reason) };
    if (this.forwardingAllowed === false) {
      return {
        refusal: this.reject(
          clientOrderId,
          'the Perpl account has order forwarding disabled (fw: false): the contract would refuse this order. ' +
            'The account owner must call allowOrderForwarding(true) from their own wallet (One-Click Trading).',
        ),
      };
    }
    return { market: resolved.market };
  }

  // ---- ExecutionClient ---------------------------------------------------

  async placeOrder(order: Order): Promise<OrderResult> {
    const pre = await this.preflight(order.asset, order.clientOrderId);
    if ('refusal' in pre) return pre.refusal;
    const { market } = pre;

    const leverage = this.leverageOf(order.leverageX);
    if (typeof leverage === 'string') return this.reject(order.clientOrderId, leverage);
    if (order.kind === 'limit' && !order.price) return this.reject(order.clientOrderId, 'limit order requires a price');
    if (!isPositive(order.size)) return this.reject(order.clientOrderId, 'order size must be positive');

    let s: number;
    let p = 0;
    try {
      // Size rounds down so a venue lot can never make an order larger than approved.
      s = toScaledNumber(order.size, market.sizeDecimals, 'floor');
      if (order.kind === 'limit' && order.price) {
        // Never a worse price than approved: buys round down, sells round up.
        p = toScaledNumber(order.price, market.priceDecimals, order.side === 'buy' ? 'floor' : 'ceil');
      }
    } catch (err) {
      return this.reject(order.clientOrderId, err instanceof Error ? err.message : String(err));
    }
    if (s === 0) {
      return this.reject(order.clientOrderId, `size is below the ${market.symbol} minimum step (${market.sizeDecimals} decimals)`);
    }

    // Idempotent retry: the same clientOrderId reuses its rq, which the venue dedups on.
    const rq = this.rqByClientId.get(order.clientOrderId) ?? this.nextRq();
    this.rqByClientId.set(order.clientOrderId, rq);

    const slippage = order.kind === 'market' ? (order.maxSlippageBps ?? this.opts.defaultMaxSlippageBps) : undefined;
    const frame: PerplOrderFrame = {
      ...this.baseFrame(market, rq, leverage),
      t: perplOrderType(order.side, order.reduceOnly === true),
      p,
      s,
      // A market order is an IOC limit at the slippage bound (order-types docs).
      fl: order.kind === 'market' ? PERPL_FLAG.ioc : PERPL_FLAG.gtc,
      ...(slippage !== undefined ? { ms: slippage } : {}),
    };
    return this.submit({ clientOrderId: order.clientOrderId, frame, market, waitTerminal: order.kind === 'market' });
  }

  async placeTriggerOrder(order: TriggerOrder): Promise<OrderResult> {
    const pre = await this.preflight(order.asset, order.clientOrderId);
    if ('refusal' in pre) return pre.refusal;
    const { market } = pre;

    const leverage = this.leverageOf(order.leverageX);
    if (typeof leverage === 'string') return this.reject(order.clientOrderId, leverage);

    let tr: number | undefined;
    if (order.linkedToClientOrderId !== undefined) {
      tr = this.rqByClientId.get(order.linkedToClientOrderId);
      if (tr === undefined) {
        return this.reject(
          order.clientOrderId,
          `cannot link protection to unknown entry "${order.linkedToClientOrderId}": place the entry through this client first`,
        );
      }
    }

    let s: number;
    let tp: number;
    try {
      s = toScaledNumber(order.size, market.sizeDecimals, 'floor');
      tp = toScaledNumber(order.triggerPrice, market.priceDecimals, perplTriggerRounding(order.kind, order.direction));
    } catch (err) {
      return this.reject(order.clientOrderId, err instanceof Error ? err.message : String(err));
    }
    if (s === 0 || tp === 0) return this.reject(order.clientOrderId, 'trigger size or price scales to zero at this market\'s precision');

    const rq = this.rqByClientId.get(order.clientOrderId) ?? this.nextRq();
    this.rqByClientId.set(order.clientOrderId, rq);

    const slippage = order.maxSlippageBps ?? this.opts.defaultMaxSlippageBps;
    const frame: PerplOrderFrame = {
      ...this.baseFrame(market, rq, leverage),
      t: order.direction === 'long' ? PERPL_ORDER_TYPE.closeLong : PERPL_ORDER_TYPE.closeShort,
      p: 0, // stop-market: becomes a market order (with slippage protection) when triggered
      s,
      fl: PERPL_FLAG.ioc,
      tp,
      tpc: perplTriggerCondition(order.kind, order.direction),
      ...(tr !== undefined ? { tr } : {}),
      ...(slippage !== undefined ? { ms: slippage } : {}),
    };
    // An untriggered protective order is "placed": Untriggered (8) settles it as pending.
    return this.submit({ clientOrderId: order.clientOrderId, frame, market, waitTerminal: false });
  }

  async cancelOrder(clientOrderId: string): Promise<CancelResult> {
    const rq = this.rqByClientId.get(clientOrderId);
    const tracked = rq !== undefined ? this.orders.get(rq) : undefined;
    if (!tracked || tracked.oid === undefined) {
      return { clientOrderId, cancelled: false, reason: 'no venue order id known for this clientOrderId (no mt:24 update seen)' };
    }
    const market = this.markets.get(tracked.mkt);
    if (!market) return { clientOrderId, cancelled: false, reason: `unknown Perpl market id ${tracked.mkt}` };

    let socket: WebSocket;
    try {
      socket = await this.connect();
    } catch (err) {
      return { clientOrderId, venueOrderId: String(tracked.oid), cancelled: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const frame: PerplOrderFrame = {
      ...this.baseFrame(market, this.nextRq(), 1),
      oid: tracked.oid,
      t: PERPL_ORDER_TYPE.cancel,
      p: 0,
      s: 0,
      fl: PERPL_FLAG.gtc,
      lv: 0,
    };
    const ackP = this.awaitAck(frame.sn);
    socket.send(JSON.stringify(frame));
    const ack = await ackP;
    if (ack.kind !== 'ack') {
      return { clientOrderId, venueOrderId: String(tracked.oid), cancelled: false, reason: `no acknowledgement (${ack.kind}); outcome unknown` };
    }
    return {
      clientOrderId,
      venueOrderId: String(tracked.oid),
      cancelled: ack.code === 0,
      reason: ack.code === 0 ? 'cancel accepted for forwarding; the final state arrives on the order stream' : ack.error,
    };
  }

  /** The open position from the trading stream's `mt: 27` updates. A position
   * that existed before this session appears once the venue next reports it. */
  async getPosition(asset: string): Promise<Position | null> {
    const resolved = await this.markets.resolve(asset);
    if (!resolved.ok) return null;
    try {
      await this.connect();
    } catch {
      return null;
    }
    const row = this.positions.get(resolved.market.id);
    if (!row) return null;
    const size = fromScaled(row.sd === 2 ? -row.s : row.s, resolved.market.sizeDecimals);
    return { venue: this.venue, asset, size, entryPrice: fromScaled(row.ep, resolved.market.priceDecimals) };
  }

  subscribeMarketData(asset: string, onTick: (tick: PriceTick) => void): Unsubscribe {
    let closed = false;
    let socket: WebSocket | null = null;
    void (async () => {
      const resolved = await this.markets.resolve(asset);
      if (!resolved.ok || closed) return;
      const { market } = resolved;
      socket = new this.WebSocketImpl(this.wsUrls.marketData);
      socket.addEventListener('open', () => {
        // Market data is a separate server with its own (tight) limits: one
        // subscribe request, no application pings (10 requests/min).
        socket?.send(JSON.stringify({ mt: PERPL_MT.subscribe, subs: [{ stream: `trades@${market.id}`, subscribe: true }] }));
      });
      socket.addEventListener('message', (event) => {
        let msg: { mt?: number; d?: Array<{ p?: number; at?: { t?: number } }> };
        try {
          msg = JSON.parse(String((event as MessageEvent).data));
        } catch {
          return;
        }
        if (msg.mt !== PERPL_MT.tradesSnapshot && msg.mt !== PERPL_MT.tradesUpdate) return;
        for (const trade of msg.d ?? []) {
          if (typeof trade.p !== 'number' || trade.p <= 0) continue;
          const ms = trade.at?.t ?? this.now();
          onTick({ timestamp: Math.floor(ms / 1000), price: fromScaled(trade.p, market.priceDecimals) });
        }
      });
    })();
    return () => {
      closed = true;
      socket?.close();
    };
  }

  // ---- REST history ------------------------------------------------------

  /** `GET /v1/trading/fills`, signed. Returns fills with prices and sizes
   * converted from venue integers to `Decimal`. */
  async getFills(count = 50): Promise<PerplFill[]> {
    const target = `/v1/trading/fills?count=${Math.min(Math.max(1, count), 100)}`;
    const res = await this.fetchImpl(`${this.restBaseUrl}${target}`, { headers: await this.authHeaders('GET', target) });
    if (!res.ok) throw new Error(`Perpl fills request failed: HTTP ${res.status}`);
    const body = z.looseObject({ d: z.array(z.unknown()) }).parse(await res.json());
    await this.markets.load();
    const out: PerplFill[] = [];
    for (const raw of body.d) {
      const row = FillRowSchema.parse(raw);
      const market = this.markets.get(row.mkt);
      if (!market) continue; // cannot scale a fill for a market the context did not list
      out.push({
        marketId: row.mkt,
        orderId: row.oid,
        liquidity: row.l === 1 ? 'maker' : row.l === 2 ? 'taker' : undefined,
        price: row.p !== undefined ? fromScaled(row.p, market.priceDecimals) : undefined,
        size: fromScaled(row.s, market.sizeDecimals),
        fee: row.f,
      });
    }
    return out;
  }

  /** Closes the trading socket. Pending waiters resolve as unknown, not failed. */
  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

function arrayOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
