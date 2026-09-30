/**
 * Liveness for a long-running pass loop. Pure state plus a tiny HTTP server.
 *
 * `GET /healthz` answers 200 while the loop has completed a successful pass
 * recently and 503 once it has not (stale), so a supervisor or load balancer
 * can restart a process that is alive but stuck or failing. It reports times
 * and counts only: no addresses, keys or balances.
 *
 * Copied, not imported, into `@kanon/relayer`: the two packages share no code.
 */

import { createServer, type Server } from 'node:http';

export interface HealthState {
  startedAt: number;
  lastSuccessAt: number | null;
  lastPassAt: number | null;
  consecutiveFailures: number;
  passes: number;
}

export const newHealthState = (nowMs: number): HealthState => ({
  startedAt: nowMs,
  lastSuccessAt: null,
  lastPassAt: null,
  consecutiveFailures: 0,
  passes: 0,
});

export function recordPass(state: HealthState, ok: boolean, nowMs: number): HealthState {
  return {
    ...state,
    passes: state.passes + 1,
    lastPassAt: nowMs,
    lastSuccessAt: ok ? nowMs : state.lastSuccessAt,
    consecutiveFailures: ok ? 0 : state.consecutiveFailures + 1,
  };
}

/** No success for three intervals (and never under a minute) is stale. */
export const staleAfterMs = (intervalSeconds: number): number => Math.max(60_000, intervalSeconds * 3_000);

export interface HealthReport {
  status: 200 | 503;
  body: {
    ok: boolean;
    lastSuccessAt: string | null;
    lastPassAt: string | null;
    secondsSinceSuccess: number | null;
    consecutiveFailures: number;
    passes: number;
    staleAfterSeconds: number;
  };
}

/**
 * Before the first pass finishes the process gets one stale window from its
 * start to produce a success; after that, silence longer than the window is stale.
 */
export function evaluateHealth(state: HealthState, nowMs: number, staleMs: number): HealthReport {
  const reference = state.lastSuccessAt ?? state.startedAt;
  const ok = nowMs - reference <= staleMs;
  return {
    status: ok ? 200 : 503,
    body: {
      ok,
      lastSuccessAt: state.lastSuccessAt === null ? null : new Date(state.lastSuccessAt).toISOString(),
      lastPassAt: state.lastPassAt === null ? null : new Date(state.lastPassAt).toISOString(),
      secondsSinceSuccess: state.lastSuccessAt === null ? null : Math.floor((nowMs - state.lastSuccessAt) / 1000),
      consecutiveFailures: state.consecutiveFailures,
      passes: state.passes,
      staleAfterSeconds: Math.floor(staleMs / 1000),
    },
  };
}

/** A mutable holder the loop updates and the server reads. */
export interface Health {
  pass(ok: boolean): void;
  report(): HealthReport;
}

export function createHealth(intervalSeconds: number, now: () => number = Date.now): Health {
  let state = newHealthState(now());
  const stale = staleAfterMs(intervalSeconds);
  return {
    pass(ok) {
      state = recordPass(state, ok, now());
    },
    report: () => evaluateHealth(state, now(), stale),
  };
}

/** Serves `GET /healthz` (and nothing else) on `port`. */
export function startHealthServer(health: Health, port: number, host = '0.0.0.0'): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/healthz' || req.url?.startsWith('/healthz?'))) {
      const r = health.report();
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, host);
  server.unref();
  return server;
}
