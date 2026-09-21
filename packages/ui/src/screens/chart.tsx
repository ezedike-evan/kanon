import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { Series, StrategySpec } from '@kanon/spec';
import { Screen, StatusBar, TabBar } from '../components/chrome';
import {
  ChartBottomBar,
  ChartHeader,
  DrawingToolbar,
  MarketSheet,
  OhlcReadout,
  QuickTradeBar,
  RuleLegend,
  TimeframeStrip,
  type FeedStatus,
  type Readout,
} from '../components/chart/chart-chrome';
import { ChartView, type ChartViewHandle } from '../components/chart/chart-view';
import { useChartPalette } from '../components/chart/palette';
import { Meta } from '../components/ui';
import { compactSymbol, assetTitle, normalizeSymbol, parseAssetParam } from '../lib/chart-assets';
import { formatPrice } from '../lib/chart-format';
import type { Candle5, DrawingKind, RuntimeState, StructureItem } from '../lib/chart-protocol';
import { changeOver24h, formatDecimalAt, seriesDisplayDecimals } from '../lib/chart-series';
import { resolveDrawingStore } from '../lib/chart-storage';
import { computeStructure } from '../lib/chart-structure';
import { timeframeForRule, type Timeframe } from '../lib/chart-timeframes';
import { preferredTimeframe, usePreference } from '../lib/preferences';
import { useKanonData, type SeriesState } from '../lib/data';
import { SPEC } from '../lib/demo';
import { routes } from '../lib/routes';
import { useNavigator, useRouteParam } from '../nav';
import { usePlatform } from '../platform';

/** Until the runtime reports the real one. */
const DEFAULT_AXIS_WIDTH = 72;
const NO_ITEMS: readonly StructureItem[] = [];
const NO_STATE: RuntimeState = {
  key: '',
  drawings: [],
  canUndo: false,
  canRedo: false,
  selectedId: null,
  tool: null,
};

function feedStatus(state: SeriesState): FeedStatus {
  switch (state.status) {
    case 'ready':
      return 'live';
    case 'demo':
      return 'demo';
    case 'empty':
      return 'empty';
    default:
      return 'loading';
  }
}

/**
 * 02 · CHART.
 *
 * A full charting workstation over the canonical series the contract checked
 * the rule against: candles, drawing tools, a last-price tag with the bar
 * countdown, the pinned rule as the indicator line, and trade markers (arrows
 * for executed trades, a circle in `refused` for a block).
 *
 * This screen is chrome and state. The chart itself is `ChartView`, one shared
 * runtime that runs directly on the web and inside a WebView on a device.
 * docs/DESIGN.md asks for a rule-first product; the chart tab is the one place
 * the market leads, and P&L still never appears here.
 */
export function ChartScreen() {
  const data = useKanonData();
  const { rule, mode, useSeries, useChartMarkers, requestProposal } = data;
  const nav = useNavigator();
  const platform = usePlatform();
  const palette = useChartPalette();
  const store = useMemo(() => resolveDrawingStore(platform), [platform]);

  const [asset, setAsset] = useState(() => normalizeSymbol(rule.symbol ?? rule.asset));
  // Opens on the timeframe chosen in Profile > Settings, else the rule's own.
  const [timeframe, setTimeframe] = useState<Timeframe>(() => preferredTimeframe() ?? timeframeForRule(rule.bucketSeconds));
  const preferredBucket = usePreference('chartBucketSeconds');
  useEffect(() => {
    // Stored settings are read asynchronously: apply the choice when it arrives or is changed.
    const next = preferredTimeframe();
    if (next) setTimeframe(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferredBucket]);

  // `/chart?asset=ETH/USD`: a link from another screen opens the chart on that asset.
  // Only a listed asset is accepted; anything else leaves the rule's own asset.
  const linkedAsset = parseAssetParam(useRouteParam('asset'));
  useEffect(() => {
    if (linkedAsset) setAsset(linkedAsset);
  }, [linkedAsset]);
  const state = useSeries(asset, timeframe.bucketSeconds);
  const allMarkers = useChartMarkers(asset, timeframe.bucketSeconds);

  // An empty read is a series with no candles (it clears the chart); a pending
  // one keeps the previous chart underneath a "reading" cover.
  const series = useMemo<Series | null>(() => {
    if (state.status === 'ready' || state.status === 'demo') return state.series;
    if (state.status === 'empty') return { asset, bucketSeconds: timeframe.bucketSeconds, candles: [] };
    return null;
  }, [state, asset, timeframe.bucketSeconds]);
  const last = series?.candles[series.candles.length - 1];
  // Every price on the chart is shown at this many places; the data behind it stays exact.
  const decimals = series ? seriesDisplayDecimals(series) : 2;
  const [axisWidth, setAxisWidth] = useState(DEFAULT_AXIS_WIDTH);

  const chart = useRef<ChartViewHandle>(null);
  const [runtime, setRuntime] = useState<RuntimeState>(NO_STATE);
  const [tool, setToolState] = useState<DrawingKind | null>(null);
  const [magnet, setMagnet] = useState(false);
  const [toolsCollapsed, setToolsCollapsed] = useState(false);
  const [legendCollapsed, setLegendCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [crosshair, setCrosshair] = useState<Candle5 | null>(null);

  const onState = useCallback((next: RuntimeState) => {
    setRuntime(next);
    setToolState(next.tool); // the runtime returns to the cursor once a drawing lands
  }, []);

  // The rule's structure on the tape. Only from a spec the app actually holds:
  // the demo's pinned spec, or `data.spec` once a live source exposes it.
  const spec: StrategySpec | null =
    (data as { spec?: StrategySpec | null }).spec ?? (mode === 'demo' ? SPEC : null);
  const [structureOn, setStructureOn] = useState(false);
  const [items, setItems] = useState<readonly StructureItem[]>(NO_ITEMS);
  useEffect(() => {
    if (!structureOn || !series || !spec || series.candles.length === 0) {
      setItems(NO_ITEMS);
      return;
    }
    // Debounced: a live tick moves the forming candle, and the scan need not run per tick.
    const timer = setTimeout(() => setItems(computeStructure(series, spec)), 250);
    return () => clearTimeout(timer);
  }, [structureOn, series, spec]);
  const structure = useMemo(() => ({ items, visible: structureOn }), [items, structureOn]);

  const watermark = useMemo<[string, string]>(
    () => [`${compactSymbol(asset)} · ${timeframe.label}`, assetTitle(asset)],
    [asset, timeframe.label],
  );

  // Quick entry: put the market to the rule; a proposal or a refusal is the answer.
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const quickTrade = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const out = await requestProposal();
      if (out.status === 'proposed') nav.push(routes.proposal);
      else if (out.status === 'refused') nav.push(routes.refused);
      else setNote(out.message);
    } finally {
      setBusy(false);
    }
  }, [busy, requestProposal, nav]);

  const change = useMemo(() => (series && series.candles.length > 0 ? changeOver24h(series, decimals) : null), [series, decimals]);

  const readout = useMemo<Readout | null>(() => {
    if (crosshair) {
      const [, o, h, l, c] = crosshair;
      return {
        o: formatPrice(o, decimals),
        h: formatPrice(h, decimals),
        l: formatPrice(l, decimals),
        c: formatPrice(c, decimals),
        direction: c > o ? 'up' : c < o ? 'down' : 'flat',
      };
    }
    if (!last) return null;
    const cmp = Number(last.close.atoms) - Number(last.open.atoms);
    return {
      o: formatDecimalAt(last.open, decimals),
      h: formatDecimalAt(last.high, decimals),
      l: formatDecimalAt(last.low, decimals),
      c: formatDecimalAt(last.close, decimals),
      direction: cmp > 0 ? 'up' : cmp < 0 ? 'down' : 'flat',
    };
  }, [crosshair, last, decimals]);

  const dispatch = useCallback((command: Parameters<ChartViewHandle['dispatch']>[0]) => {
    chart.current?.dispatch(command);
  }, []);

  const status = feedStatus(state);
  const covering = state.status === 'loading' || state.status === 'empty';

  return (
    <Screen label="02 · CHART">
      {fullscreen ? null : <StatusBar />}

      <View className="min-h-0 flex-1 bg-panel">
        <ChartHeader
          symbol={asset}
          price={last ? formatDecimalAt(last.close, decimals) : null}
          change={change}
          status={status}
          collapsed={legendCollapsed}
          onToggle={() => setLegendCollapsed((v) => !v)}
        />
        {legendCollapsed ? null : (
          <>
            <RuleLegend
              name={rule.name}
              predicates={rule.predicates}
              structure={{ available: spec !== null, on: structureOn, onToggle: () => setStructureOn((v) => !v) }}
            />
            <OhlcReadout readout={readout} />
          </>
        )}

        <View className="min-h-0 flex-1">
          <ChartView
            ref={chart}
            asset={asset}
            bucketSeconds={timeframe.bucketSeconds}
            series={series}
            markers={allMarkers}
            palette={palette}
            tool={tool}
            magnet={magnet}
            structure={structure}
            watermark={watermark}
            store={store}
            onCrosshair={setCrosshair}
            onState={onState}
            onPriceAxisWidth={setAxisWidth}
          />

          {covering ? (
            <View
              className="absolute inset-0 items-center justify-center gap-2 bg-panel/90 px-8"
              // A screen reader hears that something is on its way, not an empty box.
              accessibilityState={{ busy: state.status === 'loading' }}
            >
              <Meta>{state.status === 'loading' ? 'READING THE SERIES' : 'NO SAMPLES'}</Meta>
              {state.status === 'empty' ? (
                <Text className="text-center font-sans text-13 text-ash">
                  The canonical series holds no {timeframe.label} candles for {asset} yet. They appear
                  as prices are recorded. Nothing is drawn in the meantime.
                </Text>
              ) : null}
            </View>
          ) : null}

          <DrawingToolbar
            tool={tool}
            // Tapping the active tool again puts it down. `ChartView` sends the change to the runtime.
            onTool={(next) => setToolState(next === tool ? null : next)}
            magnet={magnet}
            onMagnet={() => setMagnet((v) => !v)}
            canDelete={runtime.selectedId !== null}
            onDelete={() => dispatch({ type: 'deleteSelected' })}
            collapsed={toolsCollapsed}
            onCollapsed={setToolsCollapsed}
            priceAxisWidth={axisWidth}
          />
        </View>

        {fullscreen ? null : <TimeframeStrip value={timeframe} onChange={setTimeframe} />}
        <ChartBottomBar
          symbol={asset}
          timeframe={timeframe.label}
          onOpenMarket={() => setSheet(true)}
          canUndo={runtime.canUndo}
          canRedo={runtime.canRedo}
          hasDrawings={runtime.drawings.length > 0}
          onUndo={() => dispatch({ type: 'undo' })}
          onRedo={() => dispatch({ type: 'redo' })}
          onClear={() => dispatch({ type: 'clear' })}
          fullscreen={fullscreen}
          onFullscreen={() => setFullscreen((v) => !v)}
        />
        {fullscreen ? null : <QuickTradeBar onTrade={quickTrade} busy={busy} note={note} />}
      </View>

      {fullscreen ? null : <TabBar active="chart" />}

      <MarketSheet
        open={sheet}
        onClose={() => setSheet(false)}
        symbol={asset}
        timeframe={timeframe}
        onSymbol={(next) => {
          setAsset(next);
          setSheet(false);
        }}
        onTimeframe={(next) => {
          setTimeframe(next);
          setSheet(false);
        }}
      />
    </Screen>
  );
}
