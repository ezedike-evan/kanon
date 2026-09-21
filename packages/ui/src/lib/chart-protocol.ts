/**
 * The message protocol between the chart host (React Native chrome) and the
 * chart runtime (`components/chart/runtime`, lightweight-charts underneath).
 *
 * There is one runtime and two transports:
 *
 *   web     `engine.web.tsx` imports the runtime and calls it directly:
 *             host -> runtime   runtime.dispatch(command)
 *             runtime -> host   the `emit` callback given to createChartRuntime
 *
 *   native  `engine.tsx` runs the same runtime, bundled into one IIFE string
 *           (`runtime-bundle.generated.ts`), inside a react-native-webview:
 *             host -> runtime   webview.injectJavaScript(
 *                                 `window.__kanonChart(${JSON.stringify(cmd)});true;`)
 *             runtime -> host   window.ReactNativeWebView.postMessage(
 *                                 JSON.stringify(event))
 *
 * Both directions carry exactly the JSON-serialisable types below, so the
 * native bridge is just `JSON.stringify` on one side and `JSON.parse` on the
 * other. Nothing here may hold a function, a Date, a bigint or a class.
 *
 * Numbers crossing the bridge are floats: a lightweight-charts series is a
 * float coordinate space, and the conversion from `Decimal` happens once, in
 * `chart-series.ts`, at the last step before drawing. Nothing on this bridge
 * is ever fed back into spec or contract arithmetic.
 *
 * Ordering: commands are applied in the order sent. The host queues them
 * until the runtime has emitted `ready`. A `data` command with a new `key`
 * resets the drawing state; the host then sends the drawings it restored for
 * that key. Events for drawings carry the `key` they belong to so a late
 * event can never be saved under the wrong asset or timeframe.
 *
 * Throttling: `crosshair` events are rate-limited inside the runtime (about
 * 30 per second, and only when the hovered bar actually changes). The bridge
 * never carries a per-frame message.
 */

/** [time (unix seconds), open, high, low, close]. Compact on purpose: 2000 candles must stay cheap to serialise. */
export type Candle5 = readonly [number, number, number, number, number];

export type DrawingKind = 'trend' | 'hray' | 'hline' | 'vline' | 'rect' | 'fib' | 'measure';

export interface ChartPoint {
  /** Unix seconds. May lie beyond the last candle: drawings extend into the future. */
  time: number;
  price: number;
}

export interface Drawing {
  id: string;
  kind: DrawingKind;
  points: ChartPoint[];
}

/** Every colour the runtime draws with, resolved by the host from the theme tokens. */
export interface ChartPalette {
  background: string;
  text: string;
  textStrong: string;
  grid: string;
  border: string;
  up: string;
  down: string;
  crosshair: string;
  crosshairLabel: string;
  /** Default stroke of a user drawing and of the selection handles. */
  drawing: string;
  /** The last-price tag and its dotted line. */
  tagBackground: string;
  tagText: string;
  /** Rule structure overlays. */
  rule: string;
  refused: string;
  verified: string;
}

export interface EngineMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  color: string;
}

/** What the pinned rule's predicates found on the visible series, in time/price space. */
export type StructureItem =
  | { kind: 'swing'; side: 'high' | 'low'; time: number; endTime: number; price: number }
  | {
      kind: 'fvg';
      side: 'bull' | 'bear';
      time: number;
      endTime: number;
      top: number;
      bottom: number;
    }
  | {
      kind: 'sweep';
      side: 'high' | 'low';
      time: number;
      /** The wick that traded through the reference. */
      price: number;
      refTime: number;
      refPrice: number;
    };

export interface RuntimeInit {
  palette: ChartPalette;
  /** Font stack for axis labels. Must be monospace. */
  fontFamily: string;
}

export type RuntimeCommand =
  | { type: 'theme'; palette: ChartPalette }
  | {
      type: 'data';
      /** `asset|bucketSeconds`. A new key resets drawings, history and the view. */
      key: string;
      bucketSeconds: number;
      /** Decimal places every price on the chart is *shown* at (see `displayDecimals`); the candles stay exact. */
      decimals: number;
      candles: Candle5[];
    }
  /** Upsert candles at the tail: the live last-candle update. Never a mid-series edit. */
  | { type: 'patch'; candles: Candle5[] }
  | { type: 'markers'; markers: EngineMarker[] }
  | { type: 'watermark'; lines: [string, string] }
  | { type: 'tool'; tool: DrawingKind | null }
  | { type: 'magnet'; on: boolean }
  /** Replace all drawings (a restore). Resets history. */
  | { type: 'drawings'; key: string; drawings: Drawing[] }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'clear' }
  | { type: 'deleteSelected' }
  | { type: 'structure'; items: StructureItem[]; visible: boolean }
  | { type: 'fit' }
  | { type: 'latest' };

export interface RuntimeState {
  key: string;
  drawings: Drawing[];
  canUndo: boolean;
  canRedo: boolean;
  selectedId: string | null;
  tool: DrawingKind | null;
}

export type RuntimeEvent =
  | { type: 'ready' }
  /** Throttled. `null` when the crosshair leaves the chart. */
  | { type: 'crosshair'; candle: Candle5 | null }
  /** Emitted after every change to drawings, history, selection or tool. */
  | { type: 'state'; state: RuntimeState; persist: boolean }
  /** The measured width of the price axis, in px. It changes as labels get wider, so chrome can stay clear of it. */
  | { type: 'layout'; priceAxisWidth: number }
  | { type: 'error'; message: string };

/** Parses one bridge message defensively. A malformed message is dropped, never thrown. */
export function parseRuntimeEvent(raw: string): RuntimeEvent | null {
  try {
    const value = JSON.parse(raw) as { type?: unknown } | null;
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') return null;
    switch (value.type) {
      case 'ready':
      case 'crosshair':
      case 'state':
      case 'layout':
      case 'error':
        return value as RuntimeEvent;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
