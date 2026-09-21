import { parseDecimal } from '@kanon/spec';
import type {
  ActivityItem,
  MarketsState,
  PairTicker,
  ProfileFollow,
  TickerState,
} from './domain-types';

/**
 * The signed-out fixtures for the per-domain hooks. Constants, built once, so
 * a demo screen re-renders on nothing and does no work per mount. They mirror
 * `lib/demo.ts` (BTC at 64,200 and a slightly negative day) so the demo reads
 * as one account across screens.
 */

const price = (value: string, decimals: number) => parseDecimal(value, decimals);
/** A fixed print time, so the fixture is stable; a demo pair is never presented as live. */
const AT = 1_790_000_000;

const pair = (asset: string, value: string, decimals: number, changeBps: number): PairTicker => {
  const [base = asset, quote = ''] = asset.split('/');
  return { asset, base, quote, price: price(value, decimals), changeBps, publishTime: AT };
};

const DEMO_PAIRS: PairTicker[] = [
  pair('BTC/USD', '64200.00', 2, -42),
  pair('ETH/USD', '3410.00', 2, 87),
  pair('SOL/USD', '162.400', 3, -131),
  pair('MON/USD', '0.03420', 5, 214),
];

export const DEMO_MARKETS: MarketsState = { status: 'demo', pairs: DEMO_PAIRS };

const DEMO_TICKERS: Record<string, TickerState> = Object.fromEntries(
  DEMO_PAIRS.map((p) => [p.asset, { status: 'demo', ticker: p } satisfies TickerState]),
);
const NO_DEMO_TICKER: TickerState = { status: 'empty' };

export function demoTicker(asset: string): TickerState {
  return DEMO_TICKERS[asset.replace(/\s+/g, '').toUpperCase()] ?? NO_DEMO_TICKER;
}

/** Times are absolute so the fixture is stable; a relative label is the screen's to write. */
const item = (
  id: string,
  kind: ActivityItem['kind'],
  direction: ActivityItem['direction'],
  entry: string,
  size: string,
  at: string,
  refusedBy?: string,
): ActivityItem => ({
  id,
  kind,
  asset: 'BTC/USD',
  direction,
  entry: price(entry, 2),
  size: price(size, 8),
  at: Date.parse(at),
  ...(refusedBy ? { refusedBy } : {}),
});

export const DEMO_ACTIVITY: ActivityItem[] = [
  item('demo-1', 'refused', 'long', '68207.30', '0.05000000', '2026-09-02T14:32:00Z', 'bos_bullish'),
  item('demo-2', 'executed', 'long', '67940.10', '0.05000000', '2026-09-02T09:15:00Z'),
  item('demo-3', 'refused', 'long', '68104.60', '0.05000000', '2026-09-01T21:04:00Z', 'fvg_present'),
  item('demo-4', 'executed', 'short', '68590.00', '0.04000000', '2026-09-01T10:41:00Z'),
  item('demo-5', 'refused', 'long', '68104.60', '0.05000000', '2026-08-31T11:47:00Z', 'sweep_prev_day_low'),
];

export const DEMO_FOLLOWS: ProfileFollow[] = [];
