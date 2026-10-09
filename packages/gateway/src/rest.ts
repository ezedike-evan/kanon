/**
 * Read-only proxy for Perpl's public REST endpoints, with a small cache.
 *
 * A browser on our domain cannot call Perpl directly (no CORS header), so the
 * chart's history comes through here. Only the public market-data paths are
 * served, each validated before it is forwarded, so this is not an open proxy.
 *
 * Candles that have closed never change, so a range that ended in the past is
 * kept for hours and many viewers share one upstream request. Anything that
 * includes the candle still forming is kept for about a second.
 */

import type { Logger } from './log';
import { CANDLE_RESOLUTIONS } from './streams';

export interface Route {
  /** Path and query to request from the venue, relative to its REST base. */
  upstream: string;
  /** How long the gateway reuses the answer. */
  ttlMs: number;
  /** `max-age` the browser or a CDN in front may apply. */
  maxAgeSeconds: number;
}

export type Routed = { ok: true; route: Route } | { ok: false; status: 400 | 404; error: string };

/** Venue limit on candles per request. */
export const MAX_CANDLES_PER_REQUEST = 1024;
/** Allowance for a trade indexed a little after its candle's end. */
const CLOSE_MARGIN_MS = 10_000;

const LIVE = { ttlMs: 1_000, maxAgeSeconds: 1 };
const SLOW = { ttlMs: 15_000, maxAgeSeconds: 10 };
const CLOSED = { ttlMs: 6 * 3_600_000, maxAgeSeconds: 3_600 };

const bad = (error: string): Routed => ({ ok: false, status: 400, error });
const NOT_FOUND: Routed = { ok: false, status: 404, error: 'not found' };

const parseRange = (from: string, to: string): { from: number; to: number } | null => {
  const f = Number(from);
  const t = Number(to);
  return Number.isSafeInteger(f) && Number.isSafeInteger(t) && f >= 0 && t > f ? { from: f, to: t } : null;
};

/**
 * Maps a request path to the venue request it stands for, or refuses it.
 * `isKnownMarket` answers null until the market list has loaded, in which case
 * the venue is left to judge the id.
 */
export function route(
  pathname: string,
  search: URLSearchParams,
  nowMs: number,
  isKnownMarket: (marketId: number) => boolean | null,
): Routed {
  if (pathname === '/v1/pub/context') return { ok: true, route: { upstream: pathname, ...SLOW } };
  if (pathname === '/v1/market-data/ticker') return { ok: true, route: { upstream: pathname, ...LIVE } };

  const allFunding = /^\/v1\/market-data\/funding\/(\d{1,15})-(\d{1,15})$/.exec(pathname);
  if (allFunding) {
    if (!parseRange(allFunding[1]!, allFunding[2]!)) return bad('from must be before to');
    return { ok: true, route: { upstream: pathname, ...SLOW } };
  }

  const m = /^\/v1\/market-data\/(\d{1,9})\/(ticker|book|candles|funding)(?:\/(.+))?$/.exec(pathname);
  if (!m) return NOT_FOUND;
  const marketId = Number(m[1]);
  const kind = m[2]!;
  const rest = m[3];
  if (isKnownMarket(marketId) === false) return bad('unknown market');

  if (kind === 'ticker') {
    return rest === undefined ? { ok: true, route: { upstream: pathname, ...LIVE } } : NOT_FOUND;
  }
  if (kind === 'book') {
    if (rest !== undefined) return NOT_FOUND;
    const levels = search.get('levels');
    if (levels === null) return { ok: true, route: { upstream: pathname, ...LIVE } };
    if (!/^\d{1,3}$/.test(levels) || Number(levels) < 1 || Number(levels) > 100) {
      return bad('levels must be an integer from 1 to 100');
    }
    return { ok: true, route: { upstream: `${pathname}?levels=${Number(levels)}`, ...LIVE } };
  }
  if (kind === 'funding') {
    const r = /^(\d{1,15})-(\d{1,15})$/.exec(rest ?? '');
    if (!r) return NOT_FOUND;
    if (!parseRange(r[1]!, r[2]!)) return bad('from must be before to');
    return { ok: true, route: { upstream: pathname, ...SLOW } };
  }

  const c = /^(\d{1,6})\/(\d{1,15})-(\d{1,15})$/.exec(rest ?? '');
  if (!c) return NOT_FOUND;
  const resolution = Number(c[1]);
  if (!(CANDLE_RESOLUTIONS as readonly number[]).includes(resolution)) return bad('unsupported resolution');
  const range = parseRange(c[2]!, c[3]!);
  if (!range) return bad('from must be before to');
  const stepMs = resolution * 1000;
  if ((range.to - range.from) / stepMs > MAX_CANDLES_PER_REQUEST) {
    return bad(`a request may span at most ${MAX_CANDLES_PER_REQUEST} candles`);
  }
  // A candle that opens at or before `to` ends by `to + step`. Past that, nothing in the range can change.
  const closed = range.to + stepMs + CLOSE_MARGIN_MS <= nowMs;
  return { ok: true, route: { upstream: pathname, ...(closed ? CLOSED : LIVE) } };
}

export interface RestResponse {
  status: number;
  body: string;
  cacheControl: string;
  /** Set when the answer came from the gateway's memory rather than a venue request. */
  cached?: true;
}

export interface RestProxyOptions {
  baseUrl: string;
  log: Logger;
  isKnownMarket(marketId: number): boolean | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxEntries?: number;
  /** Upstream requests allowed in a burst, and per second after that. */
  burst?: number;
  perSecond?: number;
}

const json = (status: number, error: string): RestResponse => ({
  status,
  body: JSON.stringify({ error }),
  cacheControl: 'no-store',
});

export class RestProxy {
  private readonly cache = new Map<string, { expires: number; response: RestResponse }>();
  private readonly inFlight = new Map<string, Promise<RestResponse>>();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxEntries: number;
  private readonly burst: number;
  private readonly perSecond: number;
  private tokens: number;
  private refilledAt = Date.now();

  constructor(private readonly opts: RestProxyOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxEntries = opts.maxEntries ?? 300;
    this.burst = opts.burst ?? 30;
    this.perSecond = opts.perSecond ?? 10;
    this.tokens = this.burst;
  }

  /** Whether one more upstream request fits the budget; spends it if so. */
  private spend(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.refilledAt) / 1000) * this.perSecond);
    this.refilledAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  async get(pathname: string, search: URLSearchParams): Promise<RestResponse> {
    const now = Date.now();
    const routed = route(pathname, search, now, this.opts.isKnownMarket);
    if (!routed.ok) return json(routed.status, routed.error);
    const { upstream, ttlMs, maxAgeSeconds } = routed.route;

    const hit = this.cache.get(upstream);
    if (hit && hit.expires > now) {
      // Re-insert so the entries used least recently are the first evicted.
      this.cache.delete(upstream);
      this.cache.set(upstream, hit);
      return { ...hit.response, cached: true };
    }
    const pending = this.inFlight.get(upstream);
    if (pending) return pending;
    if (!this.spend(now)) return json(429, 'gateway is busy, retry shortly');

    const request = this.fetchUpstream(upstream, maxAgeSeconds)
      .then((response) => {
        if (response.status === 200) {
          this.cache.delete(upstream);
          this.cache.set(upstream, { expires: Date.now() + ttlMs, response });
          while (this.cache.size > this.maxEntries) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.cache.delete(oldest);
          }
        }
        return response;
      })
      .finally(() => this.inFlight.delete(upstream));
    this.inFlight.set(upstream, request);
    return request;
  }

  private async fetchUpstream(upstream: string, maxAgeSeconds: number): Promise<RestResponse> {
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}${upstream}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = await res.text();
      if (res.status === 200) return { status: 200, body, cacheControl: `public, max-age=${maxAgeSeconds}` };
      this.opts.log({ level: 'warn', event: 'rest_upstream_status', path: upstream, status: res.status });
      // The venue's 4xx and 503 mean something to the caller, so they pass through as they are.
      const passes = (res.status >= 400 && res.status < 500) || res.status === 503;
      return passes ? { status: res.status, body, cacheControl: 'no-store' } : json(502, 'venue error');
    } catch (err) {
      // `fetch` reports every network failure as "fetch failed"; the cause says which.
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      this.opts.log({
        level: 'warn',
        event: 'rest_upstream_failed',
        path: upstream,
        error: err instanceof Error ? err.message : String(err),
        ...(cause ? { cause } : {}),
      });
      return json(502, 'venue unreachable');
    }
  }
}
