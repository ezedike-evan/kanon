import { useMemo } from 'react';
import { View } from 'react-native';
import type { Series } from '@kanon/spec';
import { assetTitle, compactSymbol } from '../../lib/chart-assets';
import { createMemoryStore } from '../../lib/chart-storage';
import { timeframeByBucket } from '../../lib/chart-timeframes';
import { ChartView } from './chart-view';
import { useChartPalette } from './palette';
import type { TradeMarker } from './markers';

const NO_MARKERS: readonly TradeMarker[] = [];
const NO_STRUCTURE = { items: [], visible: false } as const;

export interface CandlestickChartProps {
  series: Series;
  height: number;
  /** Executed and refused trades to draw on their buckets. */
  markers?: readonly TradeMarker[];
}

/**
 * A plain candlestick chart over a `Series`, no chrome: the embeddable form of
 * the shared runtime for screens that want a chart and not the workstation
 * (`screens/chart.tsx`). Drawing tools are off and nothing is persisted.
 *
 * It is always fed from `series`, never from a symbol lookup: the chart has to
 * be able to be the same canonical, Pyth-sourced series the contract checked a
 * rule against (docs/ARCHITECTURE.md).
 */
export function CandlestickChart({ series, height, markers = NO_MARKERS }: CandlestickChartProps) {
  const palette = useChartPalette();
  const store = useMemo(() => createMemoryStore(), []);
  const label = timeframeByBucket(series.bucketSeconds)?.label ?? `${series.bucketSeconds}s`;
  const watermark = useMemo<[string, string]>(
    () => [`${compactSymbol(series.asset)} · ${label}`, assetTitle(series.asset)],
    [series.asset, label],
  );
  return (
    <View style={{ height }} className="overflow-hidden border border-hairline">
      <ChartView
        asset={series.asset}
        bucketSeconds={series.bucketSeconds}
        series={series}
        markers={markers}
        palette={palette}
        tool={null}
        magnet={false}
        structure={NO_STRUCTURE}
        watermark={watermark}
        store={store}
      />
    </View>
  );
}
