import { adherenceBps } from '@kanon/spec';
import type { CopyLeadSummary, CopyLeadsState, SparklineState } from './home-types';
import { DEMO_MARKETS } from './domain-demo';

/**
 * The signed-out fixtures for Home's own hooks. Built once and shared, so a demo
 * Home re-renders on nothing and does no work per mount. Deterministic: the same
 * line every time, and a line that ends the way its pair's 24-hour move says it
 * did, so the demo never draws a rising line beside a falling figure.
 */

const POINTS = 24;

/** A small seeded generator: repeatable, and good enough to give a line some texture. */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/**
 * A line from 100 that ends at `100 * (1 + changeBps / 10_000)`: a noisy walk
 * with the drift needed to land on the move removed from it, so the endpoints
 * are exact and the middle is still lumpy.
 */
export function demoLine(seed: number, changeBps: number, points = POINTS): number[] {
  const rand = lcg(seed);
  const walk: number[] = [100];
  for (let i = 1; i < points; i++) {
    const prev = walk[i - 1] ?? 100;
    walk.push(prev * (1 + (rand() - 0.5) * 0.012));
  }
  const target = 100 * (1 + changeBps / 10_000);
  const drift = target - (walk[points - 1] ?? 100);
  return walk.map((v, i) => v + (drift * i) / (points - 1));
}

const DEMO_LINES: Record<string, number[]> =
  DEMO_MARKETS.status === 'demo'
    ? Object.fromEntries(DEMO_MARKETS.pairs.map((p, i) => [p.asset, demoLine(101 + i * 17, p.changeBps ?? 0)]))
    : {};

const NO_DEMO_LINE: SparklineState = { status: 'empty' };
const DEMO_SPARKLINES: Record<string, SparklineState> = Object.fromEntries(
  Object.entries(DEMO_LINES).map(([asset, points]) => [asset, { status: 'demo', points } satisfies SparklineState]),
);

export function demoSparkline(asset: string): SparklineState {
  return DEMO_SPARKLINES[asset.replace(/\s+/g, '').toUpperCase()] ?? NO_DEMO_LINE;
}

const lead = (
  n: number,
  name: string,
  asset: string,
  timeframe: string,
  taken: number,
  blocked: number,
  followers: number,
  profitShareBps: number,
): CopyLeadSummary => ({
  leadId: `demo-lead-${n}`,
  strategyId: `demo-strategy-${n}`,
  name,
  asset,
  timeframe,
  taken,
  blocked,
  adherenceBps: adherenceBps(taken, blocked),
  followers,
  profitShareBps,
});

export const DEMO_LEADS: CopyLeadSummary[] = [
  lead(1, 'bos_bullish + fvg_present', 'BTC/USD', '15M', 61, 3, 214, 1000),
  lead(2, 'sweep_prev_day_low + bos_bullish', 'ETH/USD', '1H', 38, 4, 97, 1500),
  lead(3, 'bos_bearish + fvg_present', 'SOL/USD', '15M', 44, 7, 63, 1000),
  lead(4, 'fvg_present + sweep_prev_day_high', 'BTC/USD', '4H', 19, 5, 41, 2000),
];

export const DEMO_COPY_LEADS: CopyLeadsState = { status: 'demo', leads: DEMO_LEADS };
