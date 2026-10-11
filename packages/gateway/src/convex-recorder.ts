/**
 * The gateway's line to the backend around an order: who is asking, the
 * one-order-at-a-time lock, and the written record (`packages/backend/convex/http.ts`).
 *
 * The gateway never decides who a caller is. It passes the caller's own
 * sign-in token on, the backend verifies it, and the answer comes back as a
 * yes or a typed no. The recorder key in `X-Kanon-Recorder` tells the backend
 * the request comes from this service and not from a client.
 */

import { z } from 'zod';
import type {
  BeginResult,
  FillDetailsRecord,
  OrderOutcomeRecord,
  OrderRecord,
  VenueRecorder,
} from '@kanon/execution/venue-service';
import type { TimedRecord, TimedStore } from '@kanon/execution/timed-runner';
import type { Logger } from './log';

export const RECORDER_HEADER = 'x-kanon-recorder';
const TIMEOUT_MS = 15_000;

export type Admission =
  | { ok: true }
  | { ok: false; code: 'unauthenticated' | 'unreachable' }
  | { ok: false; code: 'rate_limited'; retryAfterMs: number; message: string };

export interface ConvexRecorder {
  /** May the holder of this token read the trading account now? */
  admit(token: string): Promise<Admission>;
  /** The recorder for one caller's order: `begin` and `settle` on that caller's behalf. */
  forCaller(token: string): VenueRecorder;
  /** The record of timed trades (`/timed/*`): whose each is, what became of it, and what is still running. */
  timed: TimedStore;
}

const RateLimited = z.looseObject({
  ok: z.literal(false),
  code: z.literal('rate_limited'),
  retryAfterMs: z.number().nonnegative(),
  message: z.string().min(1),
});
const Begun = z.looseObject({ ok: z.literal(true), orderId: z.string().min(1) });
const NotBegun = z.looseObject({ ok: z.literal(false), code: z.enum(['no_user', 'busy']) });
const Ok = z.looseObject({ ok: z.literal(true) });
const Started = z.looseObject({ ok: z.literal(true), tradeId: z.string().min(1) });
const Owns = z.looseObject({ ok: z.literal(true), owns: z.boolean() });
const Dec = z.object({ atoms: z.string().regex(/^-?\d+$/), decimals: z.number().int().min(0) });
const Running = z.looseObject({
  ok: z.literal(true),
  trades: z.array(z.unknown()),
});
const RunningTrade = z.object({
  id: z.string().min(1),
  network: z.enum(['testnet', 'mainnet']),
  asset: z.string().min(1),
  direction: z.enum(['up', 'down']),
  stakeUsd: z.number(),
  leverage: z.number(),
  seconds: z.number(),
  openedAt: z.number(),
  expiresAt: z.number(),
  size: Dec,
  entryPrice: Dec,
  openFee: Dec.optional(),
});

export function createConvexRecorder(opts: {
  siteUrl: string;
  recorderKey: string;
  log: Logger;
  fetchImpl?: typeof fetch;
}): ConvexRecorder {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.siteUrl.replace(/\/+$/, '');

  /** Null when the backend could not be reached at all. */
  async function post(path: string, token: string | null, body: unknown): Promise<{ status: number; body: unknown } | null> {
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [RECORDER_HEADER]: opts.recorderKey,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        // A body that is not JSON is read as no answer.
      }
      return { status: res.status, body: parsed };
    } catch (err) {
      opts.log({ level: 'error', event: 'recorder_unreachable', path, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /** An answer this service does not know: a wrong recorder key (403), a backend not configured (503), a fault. */
  function unexpected(path: string, res: { status: number; body: unknown }): void {
    const code = z.looseObject({ code: z.string() }).safeParse(res.body);
    opts.log({ level: 'error', event: 'recorder_refused', path, status: res.status, code: code.success ? code.data.code : null });
  }

  /** Reads the answer to a `begin`, from either route that takes the order lock. */
  function readBegin(path: string, res: { status: number; body: unknown } | null): BeginResult {
    if (!res) return { ok: false, code: 'unreachable' };
    if (res.status === 401) return { ok: false, code: 'unauthenticated' };
    if (res.status === 200) {
      const begun = Begun.safeParse(res.body);
      if (begun.success) return { ok: true, orderId: begun.data.orderId };
      const not = NotBegun.safeParse(res.body);
      if (not.success) return { ok: false, code: not.data.code };
      const limited = RateLimited.safeParse(res.body);
      if (limited.success) {
        return { ok: false, code: 'rate_limited', retryAfterMs: limited.data.retryAfterMs, message: limited.data.message };
      }
    }
    unexpected(path, res);
    return { ok: false, code: 'unreachable' };
  }

  // No token on these two: the row is named by the id `begin` returned, and the key vouches for the caller.
  async function settle(outcome: OrderOutcomeRecord): Promise<void> {
    const res = await post('/venue/settle', null, outcome);
    if (res?.status === 200 && Ok.safeParse(res.body).success) return;
    if (res) unexpected('/venue/settle', res);
    throw new Error(`the outcome of order ${outcome.orderId} could not be recorded`);
  }

  async function amend(details: FillDetailsRecord): Promise<void> {
    const res = await post('/venue/amend', null, details);
    if (res?.status === 200 && Ok.safeParse(res.body).success) return;
    if (res) unexpected('/venue/amend', res);
    throw new Error(`the fill of order ${details.orderId} could not be added to its record`);
  }

  return {
    async admit(token) {
      const res = await post('/venue/admit', token, {});
      if (!res) return { ok: false, code: 'unreachable' };
      if (res.status === 401) return { ok: false, code: 'unauthenticated' };
      if (res.status === 200) {
        if (Ok.safeParse(res.body).success) return { ok: true };
        const limited = RateLimited.safeParse(res.body);
        if (limited.success) {
          return { ok: false, code: 'rate_limited', retryAfterMs: limited.data.retryAfterMs, message: limited.data.message };
        }
      }
      unexpected('/venue/admit', res);
      return { ok: false, code: 'unreachable' };
    },

    forCaller(token) {
      return {
        async begin(order: OrderRecord): Promise<BeginResult> {
          return readBegin('/venue/begin', await post('/venue/begin', token, order));
        },
        settle,
        amend,
      };
    },

    timed: {
      async start(token, trade) {
        const res = await post('/timed/start', token, trade);
        const started = res?.status === 200 ? Started.safeParse(res.body) : null;
        if (started?.success) return started.data.tradeId;
        if (res) unexpected('/timed/start', res);
        return null;
      },

      closerFor(tradeId) {
        return {
          // No token: the trade's id and the recorder key vouch for the order the server sends when the time is up.
          async begin(order: OrderRecord): Promise<BeginResult> {
            const body = { tradeId, network: order.network, asset: order.asset };
            return readBegin('/timed/begin-close', await post('/timed/begin-close', null, body));
          },
          settle,
          amend,
        };
      },

      async update(update) {
        const res = await post('/timed/update', null, update);
        if (res?.status === 200 && Ok.safeParse(res.body).success) return;
        if (res) unexpected('/timed/update', res);
        throw new Error(`timed trade ${update.tradeId} could not be written`);
      },

      async running() {
        const res = await post('/timed/running', null, {});
        const list = res?.status === 200 ? Running.safeParse(res.body) : null;
        if (!list?.success) {
          if (res) unexpected('/timed/running', res);
          throw new Error('the running timed trades could not be read');
        }
        // A row this service cannot read is left out, not guessed at.
        const trades: TimedRecord[] = [];
        for (const row of list.data.trades) {
          const read = RunningTrade.safeParse(row);
          if (!read.success) continue;
          const { openFee, ...rest } = read.data;
          trades.push({ ...rest, ...(openFee ? { openFee } : {}) });
        }
        return trades;
      },

      async owns(token, tradeId) {
        const res = await post('/timed/owns', token, { tradeId });
        if (res?.status === 401) return false;
        const answer = res?.status === 200 ? Owns.safeParse(res.body) : null;
        if (answer?.success) return answer.data.owns;
        if (res) unexpected('/timed/owns', res);
        throw new Error('ownership of the timed trade could not be checked');
      },
    },
  };
}
