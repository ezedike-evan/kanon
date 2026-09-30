import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHealth, evaluateHealth, newHealthState, recordPass, staleAfterMs, startHealthServer } from './health';

const T0 = 1_700_000_000_000;

describe('health state', () => {
  it('counts consecutive failures and resets on success', () => {
    let s = newHealthState(T0);
    s = recordPass(s, false, T0 + 1000);
    s = recordPass(s, false, T0 + 2000);
    expect(s.consecutiveFailures).toBe(2);
    expect(s.lastSuccessAt).toBeNull();
    s = recordPass(s, true, T0 + 3000);
    expect(s).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: T0 + 3000, passes: 3 });
  });

  it('is healthy within one window of start before any success, then stale', () => {
    const s = newHealthState(T0);
    expect(evaluateHealth(s, T0 + 30_000, 60_000).status).toBe(200);
    expect(evaluateHealth(s, T0 + 61_000, 60_000).status).toBe(503);
  });

  it('goes 503 when the last success is older than the window, and recovers', () => {
    let s = recordPass(newHealthState(T0), true, T0);
    expect(evaluateHealth(s, T0 + 59_000, 60_000).status).toBe(200);
    const stale = evaluateHealth(s, T0 + 120_000, 60_000);
    expect(stale.status).toBe(503);
    expect(stale.body).toMatchObject({ ok: false, secondsSinceSuccess: 120, staleAfterSeconds: 60 });
    s = recordPass(s, true, T0 + 120_000);
    expect(evaluateHealth(s, T0 + 121_000, 60_000).status).toBe(200);
  });

  it('failures alone do not refresh the success time', () => {
    let s = recordPass(newHealthState(T0), true, T0);
    s = recordPass(s, false, T0 + 50_000);
    expect(evaluateHealth(s, T0 + 70_000, 60_000).status).toBe(503);
    expect(evaluateHealth(s, T0 + 70_000, 60_000).body.consecutiveFailures).toBe(1);
  });

  it('stale window is three intervals, at least a minute', () => {
    expect(staleAfterMs(5)).toBe(60_000);
    expect(staleAfterMs(60)).toBe(180_000);
  });
});

describe('health server', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it('serves /healthz with the status from the state, and 404 elsewhere', async () => {
    let t = T0;
    const health = createHealth(15, () => t);
    server = startHealthServer(health, 0, '127.0.0.1');
    await new Promise((r) => server!.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    health.pass(true);
    const ok = await fetch(`${base}/healthz`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, consecutiveFailures: 0 });

    t += 10 * 60_000;
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });
});
