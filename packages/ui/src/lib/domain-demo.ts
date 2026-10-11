import { parseDecimal, type Decimal } from '@kanon/spec';
import { demoQuote } from './chart-fixtures';
import { displayDecimals } from './chart-format';
import type {
  ActivityItem,
  MarketsState,
  PairTicker,
  ProfileFollow,
  TickerState,
} from './domain-types';

/**
 * The signed-out fixtures for the per-domain hooks. Built once and shared, so a
 * demo screen re-renders on nothing and does no work per mount.
 *
 * A demo pair has one price, and it is the demo chart's: the close of the demo
 * series (`chart-fixtures.ts`), stated at the places the chart's header states
 * it. Nothing here invents a second figure, so a pair row, a Predict slide and
 * the chart beside them cannot disagree.
 */

const price = (value: string, decimals: number) => parseDecimal(value, decimals);
/** A fixed print time, so the fixture is stable; a demo pair is never presented as live. */
const AT = 1_790_000_000;

/** The pairs the demo lists, in the order every list shows them. */
export const DEMO_ASSETS: readonly string[] = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'MON/USD'];

/** A price at `dp` places, rounded half up on its integer atoms as `formatAtoms` rounds it for the chart. */
export function atPlaces(value: Decimal, dp: number): Decimal {
  if (dp >= value.decimals) return value;
  const divisor = 10n ** BigInt(value.decimals - dp);
  return { atoms: ((BigInt(value.atoms) + divisor / 2n) / divisor).toString(), decimals: dp };
}

/**
 * A move in whole basis points of the earlier price, truncated on the integers
 * exactly as the chart's header works out its own 24-hour figure
 * (`changeOver24h`), so the two agree to the last digit.
 */
export function moveBps(now: Decimal, earlier: Decimal): number {
  const scale = Math.max(now.decimals, earlier.decimals);
  const a = BigInt(now.atoms) * 10n ** BigInt(scale - now.decimals);
  const b = BigInt(earlier.atoms) * 10n ** BigInt(scale - earlier.decimals);
  return b === 0n ? 0 : Number(((a - b) * 10_000n) / b);
}

function demoPair(asset: string): PairTicker | null {
  const quote = demoQuote(asset);
  if (!quote) return null;
  const [base = asset, counter = ''] = asset.split('/');
  const dp = displayDecimals(Number(quote.price.atoms) / 10 ** quote.price.decimals, quote.price.decimals);
  return {
    asset,
    base,
    quote: counter,
    price: atPlaces(quote.price, dp),
    changeBps: quote.dayAgo ? moveBps(quote.price, quote.dayAgo) : null,
    publishTime: AT,
  };
}

// Read on first use, never at import: the tape behind a quote is some tens of thousands of
// prints per pair, and a signed-in session never asks for a demo price.
let pairs: PairTicker[] | null = null;
const demoPairs = (): PairTicker[] =>
  (pairs ??= DEMO_ASSETS.flatMap((asset) => {
    const row = demoPair(asset);
    return row ? [row] : [];
  }));

export const DEMO_MARKETS: MarketsState = {
  status: 'demo',
  get pairs() {
    return demoPairs();
  },
};

let tickers: Record<string, TickerState> | null = null;
const NO_DEMO_TICKER: TickerState = { status: 'empty' };

export function demoTicker(asset: string): TickerState {
  tickers ??= Object.fromEntries(demoPairs().map((p) => [p.asset, { status: 'demo', ticker: p } satisfies TickerState]));
  return tickers[asset.replace(/\s+/g, '').toUpperCase()] ?? NO_DEMO_TICKER;
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
