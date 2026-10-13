/**
 * `/trade`: real orders on Perpl, sent from this process with ONE API key.
 *
 *   GET  /trade/account   the trading account: balance, open positions, markets, limits
 *   POST /trade/order     { asset, side, usd, leverage }   open at market
 *   POST /trade/close     { asset }                         close the whole position at market
 *
 * Every signed-in user trades the same exchange account, on testnet, inside the
 * small limits `@kanon/execution` states (`venue-policy.ts`). The order logic is
 * there too (`venue-service.ts`); this file is only the HTTP face of it.
 *
 * Why here and not in the backend: Perpl answers its trading API with HTTP 451
 * from regions it does not serve, and the backend's host is in one. This
 * service runs where its operator is.
 *
 * Who may call: a request carries the caller's own sign-in token in
 * `Authorization: Bearer`. This service does not judge the token. It hands it
 * to the backend, which verifies it, applies the rate limit, keeps the
 * one-order-at-a-time lock and writes each order down (`convex-recorder.ts`).
 * With no token, or one the backend turns away, nothing is read and nothing is
 * sent.
 *
 * Every answer the ticket is meant to show comes back as HTTP 200 with a typed
 * body, a refusal included: a refusal is an answer, not a fault. Other statuses
 * are for requests that are not one of the three above.
 *
 * Autopilot has no path here. Nobody calls it: this process asks the backend
 * what the rule passed and opens it (`autopilot.ts`), starting and stopping
 * with the timed trades it shares a runner with.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import {
  createEd25519Signer,
  createPerplRest,
  loadPerplMarkets,
  normalizeEd25519Secret,
  readPerplMarkPrice,
  type PerplMarketInfo,
} from '@kanon/execution/perpl-trade';
import { createTimedRunner, type TimedRunner } from '@kanon/execution/timed-runner';
import {
  VENUE_MESSAGES,
  createVenueService,
  type VenueAccountView,
  type VenueOrderResult,
  type VenueService,
} from '@kanon/execution/venue-service';
import { createAutopilotPoller, type AutopilotPoller } from './autopilot';
import type { TradeConfig } from './config';
import { createConvexRecorder, type Admission, type ConvexRecorder } from './convex-recorder';
import type { Logger } from './log';

export const TRADE_PREFIX = '/trade/';
/** Predict's timed trades, served by the same routes object as the ticket's orders. */
export const PREDICT_PREFIX = '/predict/';
export const TRADE_NOT_CONNECTED = 'Trading is not connected on this gateway.';
const SIGN_IN_UNCHECKED = 'Your sign-in could not be checked. Try again.';
/** An order is four short fields; anything larger is not one. */
const MAX_BODY_BYTES = 2048;
/**
 * How long a yes from the backend about a token is taken as read for reading
 * the account. An order is always put to the backend again. Without this every
 * read of the account is two round trips before the venue is even asked.
 */
const ADMISSION_TTL_MS = 60_000;
const MAX_ADMISSIONS = 2_000;
/**
 * One read of the account serves every caller for this long. It is one shared
 * account, so ten tickets open at once must not be ten times the requests to
 * the venue, whose rate limit is not published.
 */
const ACCOUNT_TTL_MS = 2_000;

const ROUTES: Record<string, 'GET' | 'POST'> = {
  '/trade/account': 'GET',
  '/trade/order': 'POST',
  '/trade/close': 'POST',
  // Predict: a timed trade is a position the server closes when its time is up.
  '/predict/state': 'GET',
  '/predict/open': 'POST',
  '/predict/close': 'POST',
};

const asset = z.string().trim().min(1).max(32);
const OrderBody = z.strictObject({
  asset,
  side: z.enum(['long', 'short']),
  // The bounds on these are the policy's to state, with a reason. Here they only have to be numbers.
  usd: z.number(),
  leverage: z.number(),
});
const CloseBody = z.strictObject({ asset });
const TimedOpenBody = z.strictObject({
  asset,
  direction: z.enum(['up', 'down']),
  // What is on offer is the policy's to state, with a reason. Here these only have to be numbers.
  stakeUsd: z.number(),
  seconds: z.number(),
});
const TimedCloseBody = z.strictObject({ tradeId: z.string().min(1).max(64) });

export interface TradeAnswer {
  status: number;
  body: unknown;
  /** The method this path takes, on a 405. */
  allow?: string;
}

export interface TradeRoutes {
  handle(req: IncomingMessage, path: string): Promise<TradeAnswer>;
  /** Picks up the timed trades an earlier process left running, then starts asking for autopilot's proposals. Does nothing when none are served. */
  resume(): Promise<void>;
  /** Stops asking for proposals, and the timers of running timed trades. They stay in the backend for the next process. */
  stop(): void;
}

const unavailable = (message: string): { status: 'unavailable'; message: string } => ({ status: 'unavailable', message });

/** A sign-in token has three dot-separated parts. Anything else is not sent to the backend to be judged. */
function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
  return match?.[1] && match[1].length <= 4096 ? match[1] : null;
}

/** The request body as text. Null when it is larger than an order can be. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) over = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function routeOf(req: IncomingMessage, path: string): TradeAnswer | null {
  const method = ROUTES[path];
  if (!method) return { status: 404, body: { error: 'not found' } };
  if (req.method !== method) return { status: 405, body: { error: 'method not allowed' }, allow: method };
  return null;
}

/** What `/trade` answers while no key is configured: the same paths, and a plain line for the ticket. */
export const disconnectedTrade: TradeRoutes = {
  async handle(req, path) {
    return routeOf(req, path) ?? { status: 200, body: unavailable(TRADE_NOT_CONNECTED) };
  },
  async resume() {},
  stop() {},
};

export function createTradeRoutes(deps: {
  service: VenueService;
  recorder: ConvexRecorder;
  log: Logger;
  now?: () => number;
  /** Runs Predict's timed trades. Without it the `/predict` routes say trading is not connected. */
  timed?: TimedRunner;
  /** Opens the proposals autopilot wrote, through the same runner. Without it none are opened. */
  autopilot?: AutopilotPoller;
}): TradeRoutes {
  const { service, recorder, log, timed, autopilot } = deps;
  const now = deps.now ?? Date.now;
  const answer = (body: VenueAccountView | VenueOrderResult): TradeAnswer => ({ status: 200, body });

  /** Tokens the backend said yes to, by digest, and until when. A token itself is never kept. */
  const admitted = new Map<string, number>();
  async function admit(token: string): Promise<Admission> {
    const key = createHash('sha256').update(token).digest('base64');
    const until = admitted.get(key);
    if (until !== undefined && now() < until) return { ok: true };
    const answered = await recorder.admit(token);
    if (answered.ok) {
      if (admitted.size >= MAX_ADMISSIONS) admitted.clear();
      admitted.set(key, now() + ADMISSION_TTL_MS);
    } else {
      admitted.delete(key);
    }
    return answered;
  }

  /** The read of the account now in hand, shared by callers that arrive while it is fresh. */
  let held: { at: number; view: Promise<VenueAccountView> } | null = null;
  function readAccount(): Promise<VenueAccountView> {
    const at = now();
    if (held && at >= held.at && at - held.at < ACCOUNT_TTL_MS) return held.view;
    const view = service.account();
    const mine = { at, view };
    held = mine;
    // Only an account that was read is worth handing to the next caller.
    const drop = (): void => {
      if (held === mine) held = null;
    };
    view.then((v) => (v.status === 'ready' ? undefined : drop()), drop);
    return view;
  }

  /** The Predict state now in hand, shared the same way the account is. */
  let stateHeld: { at: number; view: ReturnType<TimedRunner['state']> } | null = null;
  function readState(runner: TimedRunner): ReturnType<TimedRunner['state']> {
    const at = now();
    if (stateHeld && at >= stateHeld.at && at - stateHeld.at < ACCOUNT_TTL_MS) return stateHeld.view;
    const view = runner.state();
    const mine = { at, view };
    stateHeld = mine;
    const drop = (): void => {
      if (stateHeld === mine) stateHeld = null;
    };
    view.then((v) => (v.status === 'ready' ? undefined : drop()), drop);
    return view;
  }

  /** The three `/predict` paths. The caller is put to the backend as for the ticket: by their own token. */
  async function predict(req: IncomingMessage, path: string, token: string | null): Promise<TradeAnswer> {
    const say = (body: unknown): TradeAnswer => ({ status: 200, body });
    if (!timed) return say(unavailable(TRADE_NOT_CONNECTED));

    if (path === '/predict/state') {
      if (!token) return say(unavailable(VENUE_MESSAGES.signIn));
      const admission = await admit(token);
      if (!admission.ok) {
        if (admission.code === 'unauthenticated') return say(unavailable(VENUE_MESSAGES.signIn));
        return say(unavailable(admission.code === 'rate_limited' ? admission.message : SIGN_IN_UNCHECKED));
      }
      return say(await readState(timed));
    }

    const text = await readBody(req);
    if (text === null) return { status: 413, body: { error: 'body too large' } };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: 400, body: { error: 'body is not JSON' } };
    }

    if (path === '/predict/open') {
      const body = TimedOpenBody.safeParse(json);
      if (!body.success) return { status: 400, body: { error: 'not a timed trade: { asset, direction, stakeUsd, seconds }' } };
      if (!token) return say(unavailable(VENUE_MESSAGES.signIn));
      const result = await timed.open(body.data, { token });
      held = null;
      stateHeld = null;
      log({ level: 'info', event: 'timed_open', ...body.data, result: result.status });
      return say(result);
    }

    const body = TimedCloseBody.safeParse(json);
    if (!body.success) return { status: 400, body: { error: 'not a close: { tradeId }' } };
    if (!token) return say(unavailable(VENUE_MESSAGES.signIn));
    const result = await timed.close(body.data.tradeId, token);
    held = null;
    stateHeld = null;
    log({ level: 'info', event: 'timed_close', result: result.status });
    return say(result);
  }

  return {
    async resume() {
      // The runner first: it has to know which markets its own running trades hold before anything new is opened.
      await timed?.resume();
      autopilot?.start();
    },
    stop() {
      autopilot?.stop();
      timed?.stop();
    },

    async handle(req, path) {
      const wrong = routeOf(req, path);
      if (wrong) return wrong;
      const token = bearer(req);
      if (path.startsWith(PREDICT_PREFIX)) return predict(req, path, token);

      if (path === '/trade/account') {
        if (!token) return answer(unavailable(VENUE_MESSAGES.signIn));
        const admission = await admit(token);
        if (!admission.ok) {
          if (admission.code === 'unauthenticated') return answer(unavailable(VENUE_MESSAGES.signIn));
          return answer(unavailable(admission.code === 'rate_limited' ? admission.message : SIGN_IN_UNCHECKED));
        }
        return answer(await readAccount());
      }

      const text = await readBody(req);
      if (text === null) return { status: 413, body: { error: 'body too large' } };
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { status: 400, body: { error: 'body is not JSON' } };
      }

      if (path === '/trade/order') {
        const body = OrderBody.safeParse(json);
        if (!body.success) return { status: 400, body: { error: 'not an order: { asset, side, usd, leverage }' } };
        if (!token) return answer(unavailable(VENUE_MESSAGES.signIn));
        const result = await service.placeOrder(body.data, recorder.forCaller(token));
        // What the account held a moment ago is no longer what it holds.
        held = null;
        log({ level: 'info', event: 'trade_order', ...body.data, result: result.status });
        return answer(result);
      }

      const body = CloseBody.safeParse(json);
      if (!body.success) return { status: 400, body: { error: 'not a close: { asset }' } };
      if (!token) return answer(unavailable(VENUE_MESSAGES.signIn));
      const result = await service.closePosition(body.data.asset, recorder.forCaller(token));
      held = null;
      log({ level: 'info', event: 'trade_close', asset: body.data.asset, result: result.status });
      return answer(result);
    },
  };
}

/**
 * The routes for a configured key. Throws, naming the problem and never the
 * value, when the secret is not an Ed25519 key in a form it reads.
 */
export async function connectTrade(config: TradeConfig, log: Logger, fetchImpl?: typeof fetch): Promise<TradeRoutes> {
  const seed = await normalizeEd25519Secret(config.secret);
  const withFetch = fetchImpl ? { fetchImpl } : {};
  const rest = createPerplRest({
    network: config.network,
    apiKey: config.apiKey,
    signer: createEd25519Signer(seed),
    ...withFetch,
  });
  const service = createVenueService({
    network: config.network,
    rest,
    // A venue error carries a path and a status, never a key.
    onError: (scope, err) =>
      log({ level: 'error', event: 'venue_error', scope, error: err instanceof Error ? err.message : String(err) }),
    // Where each order's time went: the backend, the reads, and the wait for the position to move.
    onTiming: (timing) => log({ level: 'info', event: 'trade_timing', ...timing }),
    ...withFetch,
  });
  const recorder = createConvexRecorder({
    siteUrl: config.convexSiteUrl,
    recorderKey: config.recorderKey,
    log,
    ...withFetch,
  });

  // The market list changes rarely: one read serves a minute of checks on running trades.
  const publicOpts = { network: config.network, ...withFetch };
  let listed: { at: number; markets: Promise<PerplMarketInfo[]> } | null = null;
  const loadMarkets = (): Promise<PerplMarketInfo[]> => {
    const at = Date.now();
    if (listed && at - listed.at < 60_000) return listed.markets;
    const markets = loadPerplMarkets(publicOpts);
    const mine = { at, markets };
    listed = mine;
    markets.catch(() => {
      if (listed === mine) listed = null;
    });
    return markets;
  };
  const timed = createTimedRunner({
    network: config.network,
    service,
    // A person's order is recorded on their own token; a proposal's, in the proposal's name.
    recorderFor: (caller) => ('token' in caller ? recorder.forCaller(caller.token) : recorder.forProposal(caller.proposalId)),
    store: recorder.timed,
    loadMarkets,
    readMarkPrice: (marketId) => readPerplMarkPrice(publicOpts, marketId),
    onError: (scope, err) =>
      log({ level: 'error', event: 'timed_error', scope, error: err instanceof Error ? err.message : String(err) }),
  });
  const autopilot = createAutopilotPoller({ runner: timed, store: recorder.autopilot, log });
  return createTradeRoutes({ service, recorder, log, timed, autopilot });
}
