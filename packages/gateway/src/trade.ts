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
 */

import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { createEd25519Signer, createPerplRest, normalizeEd25519Secret } from '@kanon/execution/perpl-trade';
import {
  VENUE_MESSAGES,
  createVenueService,
  type VenueAccountView,
  type VenueOrderResult,
  type VenueService,
} from '@kanon/execution/venue-service';
import type { TradeConfig } from './config';
import { createConvexRecorder, type ConvexRecorder } from './convex-recorder';
import type { Logger } from './log';

export const TRADE_PREFIX = '/trade/';
export const TRADE_NOT_CONNECTED = 'Trading is not connected on this gateway.';
const SIGN_IN_UNCHECKED = 'Your sign-in could not be checked. Try again.';
/** An order is four short fields; anything larger is not one. */
const MAX_BODY_BYTES = 2048;

const ROUTES: Record<string, 'GET' | 'POST'> = {
  '/trade/account': 'GET',
  '/trade/order': 'POST',
  '/trade/close': 'POST',
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

export interface TradeAnswer {
  status: number;
  body: unknown;
  /** The method this path takes, on a 405. */
  allow?: string;
}

export interface TradeRoutes {
  handle(req: IncomingMessage, path: string): Promise<TradeAnswer>;
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
};

export function createTradeRoutes(deps: { service: VenueService; recorder: ConvexRecorder; log: Logger }): TradeRoutes {
  const { service, recorder, log } = deps;
  const answer = (body: VenueAccountView | VenueOrderResult): TradeAnswer => ({ status: 200, body });

  return {
    async handle(req, path) {
      const wrong = routeOf(req, path);
      if (wrong) return wrong;
      const token = bearer(req);

      if (path === '/trade/account') {
        if (!token) return answer(unavailable(VENUE_MESSAGES.signIn));
        const admitted = await recorder.admit(token);
        if (!admitted.ok) {
          if (admitted.code === 'unauthenticated') return answer(unavailable(VENUE_MESSAGES.signIn));
          return answer(unavailable(admitted.code === 'rate_limited' ? admitted.message : SIGN_IN_UNCHECKED));
        }
        return answer(await service.account());
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
        log({ level: 'info', event: 'trade_order', ...body.data, result: result.status });
        return answer(result);
      }

      const body = CloseBody.safeParse(json);
      if (!body.success) return { status: 400, body: { error: 'not a close: { asset }' } };
      if (!token) return answer(unavailable(VENUE_MESSAGES.signIn));
      const result = await service.closePosition(body.data.asset, recorder.forCaller(token));
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
    ...withFetch,
  });
  const recorder = createConvexRecorder({
    siteUrl: config.convexSiteUrl,
    recorderKey: config.recorderKey,
    log,
    ...withFetch,
  });
  return createTradeRoutes({ service, recorder, log });
}
