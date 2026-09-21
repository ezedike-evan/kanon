/**
 * The chart runtime: one implementation, two transports.
 *
 * It owns the lightweight-charts instance and everything drawn on it (candles,
 * trade markers, the user's drawings, the rule's structure, the last-price tag,
 * the watermark) and is driven only by `RuntimeCommand`s, reporting back only
 * `RuntimeEvent`s (`lib/chart-protocol.ts` documents the wire format). It knows
 * nothing about React, the platform or the data source.
 *
 *   web     `engine.web.tsx` calls `createChartRuntime` on a DOM node.
 *   native  `webview-entry.ts` calls it inside a react-native-webview; the
 *           bundle script (`scripts/build-chart-runtime.mjs`) turns that entry
 *           into `runtime-bundle.generated.ts`.
 *
 * The chart is created once. A new asset or timeframe arrives as a `data`
 * command and re-uses the chart; a live tick arrives as a `patch` that updates
 * only the last bar.
 */
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  createSeriesMarkers,
  createTextWatermark,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type ITextWatermarkPluginApi,
  type Logical,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { TimeAxis } from '../../../lib/chart-axis';
import { applyPatch } from '../../../lib/chart-candles';
import {
  POINTS_REQUIRED,
  applyEdit,
  hitTest,
  isDegenerate,
  pickDrawing,
  newDrawingId,
  snapToCandle,
  type Hit,
  type Projector,
} from '../../../lib/chart-drawings';
import { formatPrice, formatStamp, withAlpha } from '../../../lib/chart-format';
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  undoHistory,
  type History,
} from '../../../lib/chart-history';
import { showsTimeOfDay } from '../../../lib/chart-timeframes';
import type {
  Candle5,
  ChartPalette,
  Drawing,
  DrawingKind,
  RuntimeCommand,
  RuntimeEvent,
  RuntimeInit,
} from '../../../lib/chart-protocol';
import {
  DrawingsPrimitive,
  PriceTagPrimitive,
  StructurePrimitive,
  type Scene,
} from './primitives';

export interface ChartRuntime {
  dispatch(command: RuntimeCommand): void;
  destroy(): void;
}

/** Crosshair events per second, at most. The bridge never carries a per-frame message. */
const CROSSHAIR_MIN_INTERVAL_MS = 33;
const TOUCH_TOLERANCE = 16;
const MOUSE_TOLERANCE = 9;
const DRAG_THRESHOLD_PX = 6;
const SNAP_THRESHOLD_PX = 28;
const INITIAL_BAR_SPACING = 6;
const RIGHT_OFFSET_BARS = 12;
/** The price axis never narrows below this. The host learns its real width from `layout` events. */
const PRICE_AXIS_WIDTH = 72;

const BLOCKED_EVENTS = [
  'mousedown',
  'mousemove',
  'mouseup',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
  'contextmenu',
] as const;

type Gesture =
  | { kind: 'create'; tool: DrawingKind; startX: number; startY: number; first: ChartPointLike; moved: boolean; secondTap: boolean }
  | { kind: 'edit'; id: string; hit: Hit; orig: Drawing; from: ChartPointLike; startX: number; startY: number; moved: boolean }
  | { kind: 'tap'; startX: number; startY: number };

interface ChartPointLike {
  time: number;
  price: number;
}

export function createChartRuntime(
  container: HTMLElement,
  init: RuntimeInit,
  emit: (event: RuntimeEvent) => void,
): ChartRuntime {
  let palette: ChartPalette = init.palette;
  const fontFamily = init.fontFamily;
  let destroyed = false;

  // ---- data ---------------------------------------------------------------
  let key = '';
  let bucketSeconds = 60;
  let decimals = 2;
  const rows: Candle5[] = [];
  const times: number[] = [];
  const axis = new TimeAxis(times, bucketSeconds);

  // ---- interaction state --------------------------------------------------
  let history: History<Drawing[]> = createHistory<Drawing[]>([]);
  let selectedId: string | null = null;
  let tool: DrawingKind | null = null;
  let magnet = false;
  let draft: Drawing | null = null;
  let pendingFirst: ChartPointLike | null = null;
  let gesture: Gesture | null = null;
  let blocking = false;

  const chart: IChartApi = createChart(container, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: palette.background },
      textColor: palette.text,
      fontFamily,
      fontSize: 11,
      attributionLogo: true,
    },
    grid: {
      vertLines: { color: withAlpha(palette.grid, 0.5) },
      horzLines: { color: withAlpha(palette.grid, 0.5) },
    },
    rightPriceScale: {
      borderColor: palette.border,
      scaleMargins: { top: 0.1, bottom: 0.12 },
      minimumWidth: PRICE_AXIS_WIDTH,
    },
    timeScale: {
      borderColor: palette.border,
      timeVisible: true,
      secondsVisible: false,
      barSpacing: INITIAL_BAR_SPACING,
      minBarSpacing: 0.4,
      rightOffset: RIGHT_OFFSET_BARS,
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: palette.crosshair, labelBackgroundColor: palette.crosshairLabel, style: LineStyle.Dashed },
      horzLine: { color: palette.crosshair, labelBackgroundColor: palette.crosshairLabel, style: LineStyle.Dashed },
    },
    localization: {
      priceFormatter: (price: number) => formatPrice(price, decimals),
      timeFormatter: (time: Time) => formatStamp(time as number),
    },
  });

  const series: ISeriesApi<'Candlestick'> = chart.addSeries(CandlestickSeries, {
    upColor: palette.up,
    downColor: palette.down,
    wickUpColor: palette.up,
    wickDownColor: palette.down,
    borderVisible: false,
    lastValueVisible: false,
    priceLineVisible: true,
    priceLineStyle: LineStyle.Dotted,
    priceLineWidth: 1,
    priceLineColor: withAlpha(palette.textStrong, 0.7),
  });

  const markersApi: ISeriesMarkersPluginApi<Time> = createSeriesMarkers(series, []);
  const watermark: ITextWatermarkPluginApi<Time> = createTextWatermark(chart.panes()[0]!, {
    horzAlign: 'center',
    vertAlign: 'center',
    lines: [],
  });

  // ---- projection -----------------------------------------------------------
  const proj: Projector = {
    x: (time) => {
      const x = chart.timeScale().logicalToCoordinate(axis.toLogical(time) as Logical);
      return x === null ? null : x;
    },
    y: (price) => {
      const y = series.priceToCoordinate(price);
      return y === null ? null : y;
    },
  };
  const bounds = () => {
    const size = chart.paneSize();
    return { width: size.width, height: size.height };
  };
  const scene = (): Scene => ({
    palette,
    fontFamily,
    proj,
    bounds,
    shapeOptions: () => ({ decimals, bucketSeconds }),
    barsToPx: (bars) => {
      const a = chart.timeScale().logicalToCoordinate(0 as Logical);
      const b = chart.timeScale().logicalToCoordinate(bars as Logical);
      return a === null || b === null ? bars * INITIAL_BAR_SPACING : b - a;
    },
  });

  const drawingsPrimitive = new DrawingsPrimitive(scene, () => {
    const all = history.present;
    if (!draft) return { drawings: all, selectedId, draft: null };
    // An edit replaces its original while it is dragged; a new drawing is added.
    const replaced = all.some((d) => d.id === draft!.id);
    return {
      drawings: replaced ? all.map((d) => (d.id === draft!.id ? draft! : d)) : all,
      selectedId,
      draft: replaced ? null : draft,
    };
  });
  const structurePrimitive = new StructurePrimitive(scene);
  const tagPrimitive = new PriceTagPrimitive(scene, (p) => proj.y(p));
  series.attachPrimitive(structurePrimitive);
  series.attachPrimitive(drawingsPrimitive);
  series.attachPrimitive(tagPrimitive);

  // The price axis grows and shrinks with its labels. Chrome floating over the plot
  // (the tool rail) needs the real width so it never sits on a label.
  let lastAxisWidth = -1;
  function reportLayout(): void {
    const width = Math.ceil(chart.priceScale('right').width());
    if (width > 0 && width !== lastAxisWidth) {
      lastAxisWidth = width;
      emit({ type: 'layout', priceAxisWidth: width });
    }
  }
  let layoutTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleLayout = () => {
    if (layoutTimer) return;
    layoutTimer = setTimeout(() => {
      layoutTimer = null;
      if (!destroyed) reportLayout();
    }, 60);
  };
  chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleLayout);

  const tagTimer = setInterval(() => {
    if (destroyed) return;
    tagPrimitive.tick();
    reportLayout();
  }, 1000);

  // ---- state out ------------------------------------------------------------
  function emitState(persist: boolean): void {
    emit({
      type: 'state',
      persist,
      state: {
        key,
        drawings: history.present as Drawing[],
        canUndo: canUndo(history),
        canRedo: canRedo(history),
        selectedId,
        tool,
      },
    });
  }

  function commit(next: Drawing[], select: string | null = selectedId): void {
    history = pushHistory(history, next);
    selectedId = select && next.some((d) => d.id === select) ? select : null;
    draft = null;
    drawingsPrimitive.redraw();
    emitState(true);
  }

  function setTool(next: DrawingKind | null): void {
    tool = next;
    draft = null;
    pendingFirst = null;
    gesture = null;
    if (next) selectedId = null;
    container.style.cursor = next ? 'crosshair' : '';
    drawingsPrimitive.redraw();
    emitState(false);
  }

  // ---- crosshair out, throttled --------------------------------------------
  let lastCrosshairAt = 0;
  let lastCrosshairTime: number | null | undefined;
  let crosshairTimer: ReturnType<typeof setTimeout> | null = null;
  let crosshairPending: Candle5 | null = null;

  const sendCrosshair = () => {
    crosshairTimer = null;
    lastCrosshairAt = Date.now();
    emit({ type: 'crosshair', candle: crosshairPending });
  };
  const onCrosshair = (param: MouseEventParams<Time>) => {
    let candle: Candle5 | null = null;
    if (param.time !== undefined) {
      const bar = param.seriesData.get(series) as
        | { open: number; high: number; low: number; close: number }
        | undefined;
      if (bar) candle = [param.time as number, bar.open, bar.high, bar.low, bar.close];
    }
    const t = candle ? candle[0] : null;
    if (t === lastCrosshairTime) return; // same bar: nothing new to say
    lastCrosshairTime = t;
    crosshairPending = candle;
    if (crosshairTimer) return; // a trailing send is already queued and will read the latest
    const wait = CROSSHAIR_MIN_INTERVAL_MS - (Date.now() - lastCrosshairAt);
    if (wait <= 0) sendCrosshair();
    else crosshairTimer = setTimeout(sendCrosshair, wait);
  };
  chart.subscribeCrosshairMove(onCrosshair);

  // ---- pointer -> drawings --------------------------------------------------
  const local = (e: PointerEvent) => {
    const rect = container.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const inPlot = (x: number, y: number) => {
    const b = bounds();
    return x >= 0 && y >= 0 && x <= b.width && y <= b.height;
  };
  const tolerance = (e: PointerEvent) => (e.pointerType === 'mouse' ? MOUSE_TOLERANCE : TOUCH_TOLERANCE);

  /** Chart point under a pixel. `snap` applies the magnet when it is on. */
  function pointAt(x: number, y: number, snap: boolean): ChartPointLike | null {
    const logical = chart.timeScale().coordinateToLogical(x);
    const price = series.coordinateToPrice(y);
    if (logical === null || price === null) return null;
    if (snap && magnet) {
      const hit = snapToCandle(rows, logical, y, price, proj.y, SNAP_THRESHOLD_PX);
      if (hit) return hit;
    }
    return { time: axis.toTime(logical), price };
  }

  function finishCreate(d: Drawing): void {
    tool = null;
    pendingFirst = null;
    container.style.cursor = '';
    if (isDegenerate(d, proj)) {
      draft = null;
      drawingsPrimitive.redraw();
      emitState(false);
      return;
    }
    commit([...history.present, d], d.id);
  }

  function onPointerDown(e: PointerEvent): void {
    if (!e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const { x, y } = local(e);
    if (!inPlot(x, y)) return; // the axes belong to lightweight-charts

    if (tool) {
      const p = pointAt(x, y, true);
      if (!p) return;
      capture(e);
      const need = POINTS_REQUIRED[tool];
      if (need === 2 && pendingFirst) {
        gesture = { kind: 'create', tool, startX: x, startY: y, first: pendingFirst, moved: true, secondTap: true };
        draft = { id: draft?.id ?? newDrawingId(), kind: tool, points: [pendingFirst, p] };
      } else {
        gesture = { kind: 'create', tool, startX: x, startY: y, first: p, moved: false, secondTap: false };
        draft = { id: newDrawingId(), kind: tool, points: need === 1 ? [p] : [p, p] };
      }
      drawingsPrimitive.redraw();
      return;
    }

    // Cursor mode: grab a drawing if one is under the pointer, else let the chart pan.
    const tol = tolerance(e);
    const options = { decimals, bucketSeconds };
    const picked = pickDrawing(history.present, selectedId, proj, bounds(), x, y, tol, options);
    if (picked) {
      const { drawing: d, hit } = picked;
      const from = pointAt(x, y, false);
      if (!from) return;
      capture(e);
      if (selectedId !== d.id) {
        selectedId = d.id;
        emitState(false);
      }
      gesture = { kind: 'edit', id: d.id, hit, orig: d, from, startX: x, startY: y, moved: false };
      drawingsPrimitive.redraw();
      return;
    }
    gesture = { kind: 'tap', startX: x, startY: y };
  }

  function onPointerMove(e: PointerEvent): void {
    const { x, y } = local(e);
    const g = gesture;
    if (!g) {
      if (pendingFirst && tool && draft) {
        const p = pointAt(x, y, true);
        if (p) {
          draft = { ...draft, points: [pendingFirst, p] };
          drawingsPrimitive.redraw();
        }
      } else if (e.pointerType === 'mouse' && !tool && history.present.length > 0) {
        const over = pickDrawing(history.present, selectedId, proj, bounds(), x, y, MOUSE_TOLERANCE, { decimals, bucketSeconds }) !== null;
        container.style.cursor = over ? 'pointer' : '';
      }
      return;
    }
    const moved = g.kind === 'tap' ? false : g.moved || Math.hypot(x - g.startX, y - g.startY) > DRAG_THRESHOLD_PX;
    if (g.kind === 'create') {
      g.moved = moved;
      const p = pointAt(x, y, true);
      if (p && draft) {
        draft = { ...draft, points: POINTS_REQUIRED[g.tool] === 1 ? [p] : [g.first, p] };
        drawingsPrimitive.redraw();
      }
    } else if (g.kind === 'edit') {
      g.moved = moved;
      if (!moved) return;
      const to = pointAt(x, y, g.hit.part === 'handle');
      if (to) {
        draft = applyEdit(g.orig, g.hit, g.from, to);
        drawingsPrimitive.redraw();
      }
    } else if (Math.hypot(x - g.startX, y - g.startY) > DRAG_THRESHOLD_PX) {
      gesture = null; // the chart is panning, not tapping
    }
  }

  function onPointerUp(e: PointerEvent): void {
    const g = gesture;
    gesture = null;
    release(e);
    if (!g) return;
    const { x, y } = local(e);
    if (g.kind === 'tap') {
      if (selectedId && Math.hypot(x - g.startX, y - g.startY) <= DRAG_THRESHOLD_PX) {
        selectedId = null;
        drawingsPrimitive.redraw();
        emitState(false);
      }
      return;
    }
    if (g.kind === 'create') {
      const p = pointAt(x, y, true);
      if (!draft || !p) return;
      if (POINTS_REQUIRED[g.tool] === 1) {
        finishCreate({ ...draft, points: [p] });
      } else if (g.moved || g.secondTap) {
        finishCreate({ ...draft, points: [g.first, p] });
      } else {
        // A tap places the first anchor; the next tap places the second.
        pendingFirst = g.first;
        draft = { ...draft, points: [g.first, p] };
        drawingsPrimitive.redraw();
      }
      return;
    }
    // edit
    if (g.moved && draft) commit(history.present.map((d) => (d.id === draft!.id ? draft! : d)), g.id);
    else draft = null;
    drawingsPrimitive.redraw();
  }

  function onPointerCancel(e: PointerEvent): void {
    gesture = null;
    draft = pendingFirst ? draft : null;
    release(e);
    drawingsPrimitive.redraw();
  }

  function capture(e: PointerEvent): void {
    blocking = true; // lightweight-charts listens to mouse and touch, not pointer, events
    try {
      container.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer has nothing to capture. The gesture still works.
    }
  }
  function release(e: PointerEvent): void {
    try {
      container.releasePointerCapture(e.pointerId);
    } catch {
      // Not captured.
    }
    setTimeout(() => {
      blocking = false;
    }, 0);
  }
  const block = (e: Event) => {
    if (blocking) e.stopPropagation();
  };
  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
    if (e.key === 'Escape') {
      if (draft || pendingFirst || tool) setTool(null);
      else if (selectedId) {
        selectedId = null;
        drawingsPrimitive.redraw();
        emitState(false);
      }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      deleteSelected();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
  };

  // The container is a full-bleed drawing surface: the browser must never take
  // a touch drag for a page scroll, and a drag must never select text.
  container.style.touchAction = 'none';
  container.style.userSelect = 'none';
  container.addEventListener('pointerdown', onPointerDown, true);
  container.addEventListener('pointermove', onPointerMove, true);
  container.addEventListener('pointerup', onPointerUp, true);
  container.addEventListener('pointercancel', onPointerCancel, true);
  for (const name of BLOCKED_EVENTS) container.addEventListener(name, block, true);
  window.addEventListener('keydown', onKey);

  // ---- commands ---------------------------------------------------------------
  function undo(): void {
    if (!canUndo(history)) return;
    history = undoHistory(history);
    if (selectedId && !history.present.some((d) => d.id === selectedId)) selectedId = null;
    draft = null;
    drawingsPrimitive.redraw();
    emitState(true);
  }
  function redo(): void {
    if (!canRedo(history)) return;
    history = redoHistory(history);
    if (selectedId && !history.present.some((d) => d.id === selectedId)) selectedId = null;
    draft = null;
    drawingsPrimitive.redraw();
    emitState(true);
  }
  function deleteSelected(): void {
    if (!selectedId) return;
    commit(history.present.filter((d) => d.id !== selectedId), null);
  }

  function refreshTag(): void {
    const last = rows[rows.length - 1];
    tagPrimitive.set(
      last ? { price: last[4], lastCandleStart: last[0], bucketSeconds, decimals } : null,
    );
  }

  const bar = (c: Candle5) => ({
    time: c[0] as UTCTimestamp,
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
  });

  let watermarkLines: [string, string] | null = null;
  function applyWatermark(): void {
    if (!watermarkLines) return;
    const [title, subtitle] = watermarkLines;
    watermark.applyOptions({
      lines: [
        { text: title, color: withAlpha(palette.text, 0.13), fontSize: 40, fontFamily, fontStyle: '600' },
        { text: subtitle, color: withAlpha(palette.text, 0.1), fontSize: 18, fontFamily, fontStyle: '400' },
      ],
    });
  }

  function applyPalette(next: ChartPalette): void {
    palette = next;
    applyWatermark();
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: next.background }, textColor: next.text },
      grid: { vertLines: { color: withAlpha(next.grid, 0.5) }, horzLines: { color: withAlpha(next.grid, 0.5) } },
      rightPriceScale: { borderColor: next.border },
      timeScale: { borderColor: next.border },
      crosshair: {
        vertLine: { color: next.crosshair, labelBackgroundColor: next.crosshairLabel },
        horzLine: { color: next.crosshair, labelBackgroundColor: next.crosshairLabel },
      },
    });
    series.applyOptions({
      upColor: next.up,
      downColor: next.down,
      wickUpColor: next.up,
      wickDownColor: next.down,
      priceLineColor: withAlpha(next.textStrong, 0.7),
    });
    drawingsPrimitive.redraw();
    structurePrimitive.redraw();
    tagPrimitive.redraw();
  }

  function dispatch(command: RuntimeCommand): void {
    if (destroyed) return;
    try {
      switch (command.type) {
        case 'theme':
          applyPalette(command.palette);
          break;
        case 'data': {
          const fresh = command.key !== key;
          key = command.key;
          bucketSeconds = command.bucketSeconds;
          axis.bucketSeconds = bucketSeconds;
          decimals = command.decimals;
          rows.length = 0;
          rows.push(...command.candles);
          times.length = 0;
          for (const c of rows) times.push(c[0]);
          series.applyOptions({
            priceFormat: { type: 'price', precision: decimals, minMove: 1 / 10 ** decimals },
          });
          chart.timeScale().applyOptions({ timeVisible: showsTimeOfDay(bucketSeconds) });
          series.setData(rows.map(bar));
          if (fresh) {
            history = createHistory<Drawing[]>([]);
            selectedId = null;
            draft = null;
            pendingFirst = null;
            gesture = null;
            chart.timeScale().applyOptions({ barSpacing: INITIAL_BAR_SPACING });
            chart.timeScale().scrollToRealTime();
            emitState(false);
          }
          refreshTag();
          drawingsPrimitive.redraw();
          scheduleLayout();
          break;
        }
        case 'patch': {
          applyPatch(rows, command.candles);
          for (const c of command.candles) {
            series.update(bar(c));
            if (times.length === 0 || c[0] > times[times.length - 1]!) times.push(c[0]);
          }
          refreshTag();
          break;
        }
        case 'markers':
          markersApi.setMarkers(command.markers.map((m) => ({ ...m, time: m.time as UTCTimestamp })));
          break;
        case 'watermark':
          watermarkLines = command.lines;
          applyWatermark();
          break;
        case 'tool':
          setTool(command.tool);
          break;
        case 'magnet':
          magnet = command.on;
          break;
        case 'drawings':
          if (command.key !== key) break; // a restore for a chart the user already left
          history = createHistory<Drawing[]>(command.drawings);
          selectedId = null;
          draft = null;
          drawingsPrimitive.redraw();
          emitState(false);
          break;
        case 'undo':
          undo();
          break;
        case 'redo':
          redo();
          break;
        case 'clear':
          if (history.present.length > 0) commit([], null);
          break;
        case 'deleteSelected':
          deleteSelected();
          break;
        case 'structure':
          structurePrimitive.set(command.items, command.visible);
          break;
        case 'fit':
          chart.timeScale().fitContent();
          break;
        case 'latest':
          chart.timeScale().scrollToRealTime();
          break;
      }
    } catch (error) {
      emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  emit({ type: 'ready' });

  return {
    dispatch,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(tagTimer);
      if (crosshairTimer) clearTimeout(crosshairTimer);
      if (layoutTimer) clearTimeout(layoutTimer);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleLayout);
      window.removeEventListener('keydown', onKey);
      container.removeEventListener('pointerdown', onPointerDown, true);
      container.removeEventListener('pointermove', onPointerMove, true);
      container.removeEventListener('pointerup', onPointerUp, true);
      container.removeEventListener('pointercancel', onPointerCancel, true);
      for (const name of BLOCKED_EVENTS) container.removeEventListener(name, block, true);
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
    },
  };
}
