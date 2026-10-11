import { SIGN_IN_TO_TRADE } from './venue-trade';
import type { VenueTradeActions } from './venue-trade-reads';

/**
 * The order ticket's three calls, made to the gateway's `/trade` routes
 * (`packages/gateway/src/trade.ts`), and Predict's three, made to its
 * `/predict` routes. Orders leave from the gateway and not from the backend
 * because the venue does not serve the region the backend is hosted in.
 *
 * Each call carries the caller's own sign-in token and nothing else that names
 * them: the gateway hands the token to the backend, which decides who is
 * asking. With no token nothing is called.
 *
 * What comes back is read by shape further up (`venue-trade.ts`), so this file
 * only moves bytes. A read of the account that cannot reach the gateway says
 * so in a line. An order that cannot be read throws instead: the order may have
 * gone out, and the layer above says exactly that rather than "try again".
 */

export const TRADE_NOT_CONNECTED = 'Trading is not connected in this build.';
export const TRADE_UNREACHABLE = 'The trading service could not be reached. Try again.';

/** A read of the account is three requests to the venue behind one of ours. */
const ACCOUNT_TIMEOUT_MS = 30_000;
const PUBLIC_TIMEOUT_MS = 15_000;
/** An order waits for its fill, which the gateway gives twenty seconds, plus the calls around it. */
const ORDER_TIMEOUT_MS = 75_000;

export interface VenueTradeClientOptions {
  /** The gateway's address, as for market data. */
  baseUrl: string;
  /** The caller's sign-in token, or null when nobody is signed in. Must not throw. */
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export function createVenueTradeActions(opts: VenueTradeClientOptions): VenueTradeActions {
  const base = opts.baseUrl.trim().replace(/\/+$/, '');

  async function call(path: string, timeoutMs: number, body?: unknown): Promise<unknown> {
    const token = await opts.getToken();
    if (!token) return { status: 'unavailable', message: SIGN_IN_TO_TRADE };
    // `AbortSignal.timeout` is not on every device this runs on.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await (opts.fetchImpl ?? fetch)(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`the gateway answered ${res.status}`);
      return (await res.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async account() {
      try {
        return await call('/trade/account', ACCOUNT_TIMEOUT_MS);
      } catch {
        return { status: 'unavailable', message: TRADE_UNREACHABLE };
      }
    },
    placeOrder: (args) => call('/trade/order', ORDER_TIMEOUT_MS, args),
    closePosition: (args) => call('/trade/close', ORDER_TIMEOUT_MS, args),
    async timedState() {
      try {
        return await call('/predict/state', ACCOUNT_TIMEOUT_MS);
      } catch {
        return { status: 'unavailable', message: TRADE_UNREACHABLE };
      }
    },
    // Opening waits for the entry fill, as an order does. Only the fields the route takes are sent.
    openTimed: ({ asset, direction, stakeUsd, seconds }) =>
      call('/predict/open', ORDER_TIMEOUT_MS, { asset, direction, stakeUsd, seconds }),
    closeTimed: ({ tradeId }) => call('/predict/close', ORDER_TIMEOUT_MS, { tradeId }),
    // Market data is public: no token is read and none is sent.
    async publicGet(path) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PUBLIC_TIMEOUT_MS);
      try {
        const res = await (opts.fetchImpl ?? fetch)(`${base}${path}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`the gateway answered ${res.status}`);
        return (await res.json()) as unknown;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** What a ticket is told in a build with no gateway address: nothing is called, and it says why. */
export const disconnectedVenueTrade: VenueTradeActions = {
  account: async () => ({ status: 'unavailable', message: TRADE_NOT_CONNECTED }),
  placeOrder: async () => ({ status: 'unavailable', message: TRADE_NOT_CONNECTED }),
  closePosition: async () => ({ status: 'unavailable', message: TRADE_NOT_CONNECTED }),
  timedState: async () => ({ status: 'unavailable', message: TRADE_NOT_CONNECTED }),
  openTimed: async () => ({ status: 'unavailable', message: TRADE_NOT_CONNECTED }),
  closeTimed: async () => ({ status: 'unavailable', message: TRADE_NOT_CONNECTED }),
};

/**
 * The trade calls for a configured gateway address, or `undefined` when none is
 * set, in which case the ticket says trading is not connected. Each app passes
 * its own `*_PUBLIC_GATEWAY_URL`, already checked by `assertPublicEnv`.
 */
export function resolveVenueTrade(
  gatewayUrl: string | undefined,
  getToken: () => Promise<string | null>,
): VenueTradeActions | undefined {
  const baseUrl = gatewayUrl?.trim();
  return baseUrl ? createVenueTradeActions({ baseUrl, getToken }) : undefined;
}
