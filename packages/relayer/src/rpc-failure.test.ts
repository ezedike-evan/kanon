import { describe, expect, it } from 'vitest';
import { PYTH_FEEDS } from '@kanon/spec';
import { loadConfig } from './config';
import { withTimeout } from './http';
import { relayOnce, reportOk } from './relay';
import type { ChainPort } from './port';

const SERIES = '0x1111111111111111111111111111111111111111' as const;
const BTC = PYTH_FEEDS['BTC/USD']!;
const cfg = () => loadConfig({ RPC_URL: 'https://rpc.example', SERIES_ADDRESSES: `BTC/USD=${SERIES}` });

const timeout = () => Object.assign(new Error('The request took too long to respond.'), { name: 'TimeoutError' });

function port(over: Partial<ChainPort> = {}): ChainPort {
  return {
    chainId: async () => 143,
    latestBlockTimestamp: async () => 1_760_000_000n,
    read: async (c) => {
      if (c.functionName === 'feedId') return BTC;
      if (c.functionName === 'cadenceSeconds') return 60n;
      if (c.functionName === 'lastSampleTimestamp') return 0n;
      return 1n;
    },
    simulate: async () => undefined,
    send: async () => ({ hash: `0x${'1'.repeat(64)}`, success: true }),
    ...over,
  } as ChainPort;
}

describe('withTimeout', () => {
  it('aborts a request that never answers', async () => {
    const hung = ((_input: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(init.signal!.reason));
      })) as unknown as typeof fetch;
    await expect(withTimeout(hung, 20)('http://hermes.test')).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('passes a prompt answer through', async () => {
    const fast = (async () => new Response('ok')) as unknown as typeof fetch;
    expect(await (await withTimeout(fast, 1000)('http://hermes.test')).text()).toBe('ok');
  });
});

describe('RPC and Hermes failure paths', () => {
  it('a Hermes timeout fails the due series, not the process, and the pass is not ok', async () => {
    const hung = (async () => {
      throw timeout();
    }) as unknown as typeof fetch;
    const report = await relayOnce(cfg(), { port: port(), fetchFn: hung });
    expect(report.update.status).toBe('failed');
    expect(report.update.detail).toMatch(/hermes: /);
    expect(reportOk(report)).toBe(false);
  });

  it('a Hermes 5xx fails the pass the same way', async () => {
    const bad = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const report = await relayOnce(cfg(), { port: port(), fetchFn: bad });
    expect(report.update.status).toBe('failed');
    expect(reportOk(report)).toBe(false);
  });

  it('an RPC that times out on the chain id read rejects the pass so the loop counts a failure', async () => {
    await expect(
      relayOnce(cfg(), {
        port: port({
          chainId: async () => {
            throw timeout();
          },
        }),
        fetchFn: fetch,
      }),
    ).rejects.toThrow(/took too long/);
  });

  it('a series whose reads time out is reported failed with the cause, and nothing is sent', async () => {
    let sends = 0;
    const report = await relayOnce(cfg(), {
      port: port({
        read: async () => {
          throw timeout();
        },
        send: async () => {
          sends++;
          return { hash: `0x${'1'.repeat(64)}`, success: true };
        },
      }),
      fetchFn: fetch,
    });
    expect(sends).toBe(0);
    expect(report.series[0]).toMatchObject({ state: 'failed' });
    expect(report.series[0]!.detail).toContain('could not read series');
    expect(reportOk(report)).toBe(false);
  });
});
