import type { TradeMarker } from '../components/chart/markers';
import { normalizeSymbol } from './chart-assets';
import type { PriceLevel } from './chart-series';
import { bucketStartOf } from './chart-timeframes';
import { formatSize } from './home-format';
import type { VenueOrder, VenuePositionView } from './venue-types';

/**
 * What the trading venue puts on the chart: the open position's entry as a
 * level, and the viewer's own fills as markers on the candles they landed in.
 *
 * Pure, so every rule here is pinned down in `venue-chart-overlays.test.ts`.
 * A price stays a `Decimal` all the way through; `chart-series.ts` turns it into
 * a chart coordinate at the last step. Nothing here is a result: a position is
 * its side, its size and where it was entered, and a fill is where it happened.
 */

/** All of a position the chart reads: where it is, which way, how much, and where it was entered. */
export type ChartPosition = Pick<VenuePositionView, 'asset' | 'side' | 'size' | 'entryPrice'>;

/** All of an order the chart reads: whether it filled, on what, which way, and when. */
export type ChartOrder = Pick<VenueOrder, 'asset' | 'action' | 'side' | 'status' | 'createdAt' | 'settledAt'>;

/** `LONG 0.0003`. The side is a word, so the line's colour is never the only thing saying it. */
export function positionLabel(position: Pick<ChartPosition, 'side' | 'size'>): string {
  return `${position.side.toUpperCase()} ${formatSize(position.size)}`;
}

/** The entry of the open position on the chart's asset, or nothing when there is none. */
export function positionLevels(position: ChartPosition | null): PriceLevel[] {
  if (!position) return [];
  return [
    {
      id: `entry:${normalizeSymbol(position.asset)}`,
      price: position.entryPrice,
      label: positionLabel(position),
      tone: position.side,
    },
  ];
}

/**
 * The viewer's filled orders on `asset`, each on the candle that holds its fill
 * time. An open is an executed trade on its side; a close is its own kind, on
 * the side of the position it closed. Anything that did not fill draws nothing.
 */
export function fillMarkers(orders: readonly ChartOrder[], asset: string, bucketSeconds: number): TradeMarker[] {
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0) return [];
  const symbol = normalizeSymbol(asset);
  const markers: TradeMarker[] = [];
  for (const order of orders) {
    // A fill with no side has no bar edge to sit on. The server sets one on every fill.
    if (order.status !== 'filled' || order.side === null) continue;
    if (normalizeSymbol(order.asset) !== symbol) continue;
    const atMs = order.settledAt ?? order.createdAt;
    if (!Number.isFinite(atMs)) continue;
    markers.push({
      timestamp: bucketStartOf(Math.floor(atMs / 1000), bucketSeconds),
      side: order.side,
      kind: order.action === 'close' ? 'closed' : 'executed',
    });
  }
  return markers;
}

const markOf = (m: TradeMarker): string => `${m.timestamp}|${m.side}|${m.kind}`;

/**
 * Rule trades and venue fills on one tape. The rule's markers are kept exactly
 * as they came. A fill that would draw the mark a candle already carries (same
 * candle, side and kind) is not drawn twice: a marker is a fact about a candle,
 * not a count.
 */
export function mergeMarkers(
  ruleMarkers: readonly TradeMarker[],
  fills: readonly TradeMarker[],
): readonly TradeMarker[] {
  // The same array when there is nothing to add, so the chart sees no change.
  if (fills.length === 0) return ruleMarkers;
  const seen = new Set(ruleMarkers.map(markOf));
  const merged = [...ruleMarkers];
  for (const fill of fills) {
    const mark = markOf(fill);
    if (seen.has(mark)) continue;
    seen.add(mark);
    merged.push(fill);
  }
  return merged;
}
