import { describe, expect, it, vi } from 'vitest';
import { createHomeReads } from './home-reads';
import { DEMO_COPY_LEADS } from './home-demo';

// The hooks are plain functions of `useQuery` plus `useMemo`: with `useMemo` run inline, a stand-in
// `useQuery` returning a fixed value is enough to read what they decide, with no renderer.
vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), useMemo: (fn: () => unknown) => fn() }));
const renderHook = <T,>(fn: () => T): T => fn();

const REF_SPARK = { __name: 'homeFeed.sparkline' };
const REF_LEADS = { __name: 'homeFeed.leadSummaries' };

function reads(session: { pending: boolean; signedIn: boolean }, result: unknown, calls: unknown[][] = []) {
  return createHomeReads({
    useQuery: (ref, args) => {
      calls.push([ref, args]);
      return args === 'skip' ? undefined : result;
    },
    sparkline: REF_SPARK,
    leadSummaries: REF_LEADS,
    session,
  });
}

describe('createHomeReads', () => {
  it('shows a skeleton, not fixtures, while auth is unresolved', () => {
    const r = reads({ pending: true, signedIn: false }, undefined);
    expect(renderHook(() => r.useSparkline('BTC/USD')).status).toBe('loading');
    expect(renderHook(() => r.useCopyLeads()).status).toBe('loading');
  });

  it('signed out: fixtures, and no Convex call at all', () => {
    const calls: unknown[][] = [];
    const r = reads({ pending: false, signedIn: false }, undefined, calls);
    expect(renderHook(() => r.useSparkline('ETH/USD')).status).toBe('demo');
    expect(renderHook(() => r.useCopyLeads())).toBe(DEMO_COPY_LEADS);
    expect(calls.every(([, args]) => args === 'skip')).toBe(true);
  });

  it('signed in: loading until the query answers, then ready or empty', () => {
    const line = { asset: 'BTC/USD', points: [1, 2, 3] };
    expect(renderHook(() => reads({ pending: false, signedIn: true }, undefined).useSparkline('BTC/USD')).status).toBe('loading');
    expect(renderHook(() => reads({ pending: false, signedIn: true }, line).useSparkline('BTC/USD'))).toEqual({
      status: 'ready',
      points: [1, 2, 3],
    });
    expect(renderHook(() => reads({ pending: false, signedIn: true }, { asset: 'AVAX/USD', points: [] }).useSparkline('AVAX/USD')).status).toBe('empty');
    expect(renderHook(() => reads({ pending: false, signedIn: true }, []).useCopyLeads()).status).toBe('empty');
    expect(renderHook(() => reads({ pending: false, signedIn: true }, [{ leadId: 'a' }]).useCopyLeads()).status).toBe('ready');
  });

  it('sends no user id: the lead list takes no arguments and the line takes only the asset', () => {
    const calls: unknown[][] = [];
    const r = reads({ pending: false, signedIn: true }, { asset: 'SOL/USD', points: [] }, calls);
    renderHook(() => r.useSparkline('SOL/USD'));
    calls.length = 0;
    const l = reads({ pending: false, signedIn: true }, [], calls);
    renderHook(() => l.useCopyLeads());
    renderHook(() => r.useSparkline('SOL/USD'));
    expect(calls).toContainEqual([REF_SPARK, { asset: 'SOL/USD' }]);
    expect(calls).toContainEqual([REF_LEADS, {}]);
  });
});
