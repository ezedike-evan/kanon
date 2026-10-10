import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react';
import { View } from 'react-native';
import type { Series } from '@kanon/spec';
import { diffCandles } from '../../lib/chart-candles';
import type { DrawingStore } from '../../lib/chart-storage';
import { drawingsKey } from '../../lib/chart-storage';
import type {
  Candle5,
  ChartPalette,
  DrawingKind,
  RuntimeCommand,
  RuntimeEvent,
  RuntimeState,
  StructureItem,
} from '../../lib/chart-protocol';
import { seriesDisplayDecimals, seriesToCandle5, toEnginePriceLines, type PriceLevel } from '../../lib/chart-series';
import { Meta } from '../ui';
import { CHART_FONT } from './palette';
import type { ChartEngineHandle, ChartEngineProps } from './engine-types';
import { toEngineMarkers, type TradeMarker } from './markers';

type EngineComponent = ForwardRefExoticComponent<ChartEngineProps & RefAttributes<ChartEngineHandle>>;

export interface ChartViewHandle {
  dispatch(command: RuntimeCommand): void;
}

export interface ChartViewProps {
  asset: string;
  bucketSeconds: number;
  /** `null` while loading: the previous chart stays until the next series arrives. An empty series clears it. */
  series: Series | null;
  markers: readonly TradeMarker[];
  /**
   * Horizontal levels the screen owns, such as an open position's entry, for the
   * asset in `asset`. Not drawings: they are never saved, undone or selected.
   */
  priceLevels?: readonly PriceLevel[];
  palette: ChartPalette;
  tool: DrawingKind | null;
  magnet: boolean;
  structure: { items: readonly StructureItem[]; visible: boolean };
  /** `[title, subtitle]` of the faint watermark. */
  watermark: [string, string];
  store: DrawingStore;
  onCrosshair?: (candle: Candle5 | null) => void;
  onState?: (state: RuntimeState) => void;
  /** The price axis width in px, as measured by the runtime. */
  onPriceAxisWidth?: (width: number) => void;
}

/**
 * The chart, without chrome: creates the engine once and keeps it in step with
 * props by sending commands, never by re-creating it.
 *
 * What crosses to the runtime, and when:
 *  - candles: a `data` command on a new asset/timeframe or a non-tail change,
 *    a `patch` (the changed tail only) on a live tick. Never a full `setData`
 *    per tick.
 *  - drawings: loaded from the store for the asset+timeframe after `data`, and
 *    saved when the runtime reports a committed change.
 *  - price levels: the whole list as one `priceLines` command when it changes,
 *    and an empty list while the candles drawn are not yet this asset's.
 *  - everything else (theme, markers, tool, magnet, structure, watermark): one
 *    command each, only when its prop actually changed.
 *
 * The engine module is loaded with a dynamic `import()` so the DOM-touching
 * runtime never reaches the Next.js server bundle.
 */
const NO_LEVELS: readonly PriceLevel[] = [];
/** A runtime that has been sent no price lines holds none. */
const NO_LINES_SIG = '[]';

export const ChartView = forwardRef<ChartViewHandle, ChartViewProps>(function ChartView(
  {
    asset,
    bucketSeconds,
    series,
    markers,
    priceLevels = NO_LEVELS,
    palette,
    tool,
    magnet,
    structure,
    watermark,
    store,
    onCrosshair,
    onState,
    onPriceAxisWidth,
  },
  ref,
) {
  const [Engine, setEngine] = useState<EngineComponent | null>(null);
  useEffect(() => {
    let cancelled = false;
    import('./engine').then((mod) => {
      if (!cancelled) setEngine(() => mod.default as EngineComponent);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const engine = useRef<ChartEngineHandle | null>(null);
  // Bumped on every `ready`: a first mount, a strict-mode remount, or a WebView
  // the OS killed and reloaded. Each one is a runtime that knows nothing, and
  // every sync effect below depends on it so it resends what it holds.
  const [epoch, setEpoch] = useState(0);
  const ready = epoch > 0;
  const readyRef = useRef(false);

  const key = drawingsKey(asset, bucketSeconds);
  const keyRef = useRef(key);
  keyRef.current = key;

  /** What the runtime currently holds, so a change can be sent as the smallest command. */
  const sent = useRef<{
    key: string | null;
    rows: Candle5[] | null;
    palette: ChartPalette | null;
    markers: unknown;
    priceLines: string;
    tool: DrawingKind | null | undefined;
    magnet: boolean | undefined;
    structure: unknown;
    watermark: string;
  }>({ key: null, rows: null, palette: null, markers: null, priceLines: NO_LINES_SIG, tool: undefined, magnet: undefined, structure: null, watermark: '' });
  const runtimeState = useRef<RuntimeState | null>(null);
  // The palette the runtime was *created* with. The theme can resolve after the first render
  // (it is read from storage), so the palette now in use may already differ from it.
  const initPalette = useRef(palette);

  const send = useCallback((command: RuntimeCommand) => engine.current?.dispatch(command), []);

  useImperativeHandle(ref, () => ({ dispatch: send }), [send]);

  const onCrosshairRef = useRef(onCrosshair);
  onCrosshairRef.current = onCrosshair;
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const onAxisRef = useRef(onPriceAxisWidth);
  onAxisRef.current = onPriceAxisWidth;
  const storeRef = useRef(store);
  storeRef.current = store;

  const onEvent = useCallback((event: RuntimeEvent) => {
    switch (event.type) {
      case 'ready':
        // A fresh runtime (first mount, a strict-mode remount, or a WebView the OS
        // killed) knows nothing: forget what was sent so the effects resend it all.
        sent.current = { key: null, rows: null, palette: initPalette.current, markers: null, priceLines: NO_LINES_SIG, tool: undefined, magnet: undefined, structure: null, watermark: '' };
        readyRef.current = true;
        runtimeState.current = null;
        setEpoch((n) => n + 1);
        break;
      case 'crosshair':
        onCrosshairRef.current?.(event.candle);
        break;
      case 'state':
        runtimeState.current = event.state;
        // Saved under the key the drawings belong to, not the one now on screen.
        if (event.persist) storeRef.current.save(event.state.key, event.state.drawings);
        onStateRef.current?.(event.state);
        break;
      case 'layout':
        onAxisRef.current?.(event.priceAxisWidth);
        break;
      case 'error':
        // A runtime error is a bug, not a state the user can act on: surface it to the console.
        console.warn('[chart]', event.message);
        break;
    }
  }, []);

  const init = useMemo(() => ({ palette: initPalette.current, fontFamily: CHART_FONT }), []);

  // Candles.
  useEffect(() => {
    if (epoch === 0 || !series) return;
    const rows = seriesToCandle5(series);
    const s = sent.current;
    const diff = s.key === key && s.rows ? diffCandles(s.rows, rows) : ({ kind: 'reset' } as const);
    if (diff.kind === 'reset') {
      send({ type: 'data', key, bucketSeconds, decimals: seriesDisplayDecimals(series), candles: rows });
      if (s.key !== key) {
        // A new chart: restore what the person drew on it last time.
        void storeRef.current.load(key).then((drawings) => {
          if (keyRef.current === key && readyRef.current) send({ type: 'drawings', key, drawings });
        });
      }
    } else if (diff.kind === 'patch') {
      send({ type: 'patch', candles: diff.candles });
    }
    s.key = key;
    s.rows = rows;
  }, [epoch, series, key, bucketSeconds, send]);

  useEffect(() => {
    if (epoch === 0 || sent.current.palette === palette) return;
    send({ type: 'theme', palette });
    sent.current.palette = palette;
  }, [epoch, palette, send]);

  // Markers: a marker with no candle at its start has no bar to sit on, so it is not drawn.
  const engineMarkers = useMemo(() => {
    if (!series) return null;
    const starts = new Set(series.candles.map((c) => c.timestamp));
    return toEngineMarkers(
      markers.filter((m) => starts.has(m.timestamp)),
      // A close takes the neutral ink, never a direction colour: see `markers.ts`.
      { up: palette.up, down: palette.down, refused: palette.refused, closed: palette.textStrong },
    );
  }, [series, markers, palette]);
  // A live tick rebuilds the array; only a real change in the markers crosses the bridge.
  const markerSig = engineMarkers ? JSON.stringify(engineMarkers) : null;
  useEffect(() => {
    if (epoch === 0 || !engineMarkers || sent.current.markers === markerSig) return;
    sent.current.markers = markerSig;
    send({ type: 'markers', markers: engineMarkers });
  }, [epoch, engineMarkers, markerSig, send]);

  // Price levels. The float boundary is here, as it is for candles. A level belongs to the
  // asset it was read for, so while another chart's candles are still drawn (a new asset or
  // timeframe on its way, under the cover) the runtime holds none. The candles effect above
  // has already run in this commit, so `sent.key` names what is drawn now.
  const engineLines = useMemo(() => toEnginePriceLines(priceLevels), [priceLevels]);
  const lineSig = JSON.stringify(engineLines);
  useEffect(() => {
    if (epoch === 0) return;
    const drawn = sent.current.key === key;
    const sig = drawn ? lineSig : NO_LINES_SIG;
    if (sent.current.priceLines === sig) return;
    sent.current.priceLines = sig;
    send({ type: 'priceLines', lines: drawn ? engineLines : [] });
    // `series` is a dependency so this runs again when the candles for `key` land.
  }, [epoch, series, key, lineSig, engineLines, send]);

  useEffect(() => {
    if (epoch === 0 || sent.current.tool === tool) return;
    sent.current.tool = tool;
    // The runtime ends a tool itself when a drawing completes; do not echo that back.
    if (runtimeState.current && runtimeState.current.tool === tool) return;
    send({ type: 'tool', tool });
  }, [epoch, tool, send]);

  useEffect(() => {
    if (epoch === 0 || sent.current.magnet === magnet) return;
    sent.current.magnet = magnet;
    send({ type: 'magnet', on: magnet });
  }, [epoch, magnet, send]);

  useEffect(() => {
    if (epoch === 0 || sent.current.structure === structure) return;
    sent.current.structure = structure;
    send({ type: 'structure', items: [...structure.items], visible: structure.visible });
  }, [epoch, structure, send]);

  const watermarkSig = watermark.join('|');
  useEffect(() => {
    if (epoch === 0 || sent.current.watermark === watermarkSig) return;
    sent.current.watermark = watermarkSig;
    send({ type: 'watermark', lines: watermark });
  }, [epoch, watermarkSig, watermark, send]);

  return (
    <View className="flex-1 bg-panel">
      {Engine ? (
        <Engine ref={engine} init={init} onEvent={onEvent} />
      ) : (
        <View className="flex-1 items-center justify-center">
          <Meta>LOADING CHART…</Meta>
        </View>
      )}
    </View>
  );
});

