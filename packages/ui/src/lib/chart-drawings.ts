/**
 * Chart drawings, as pure geometry.
 *
 * A drawing is a kind plus one or two anchor points in (time, price) space.
 * Everything here turns that into screen shapes, hit tests it, edits it and
 * validates it, with no DOM and no lightweight-charts, so the whole model can
 * be tested in node. The runtime supplies a `Projector` (time/price -> pixels)
 * and paints the shapes this file returns; it owns no geometry of its own.
 */
import { formatPercent, formatPrice, formatSigned, formatSpan } from './chart-format';
import type { Candle5, ChartPoint, Drawing, DrawingKind } from './chart-protocol';

export type { ChartPoint, Drawing, DrawingKind } from './chart-protocol';

export const DRAWING_KINDS: readonly DrawingKind[] = [
  'trend',
  'hray',
  'hline',
  'vline',
  'rect',
  'fib',
  'measure',
];

/** How many anchor points finish a drawing of this kind. */
export const POINTS_REQUIRED: Record<DrawingKind, 1 | 2> = {
  trend: 2,
  hray: 1,
  hline: 1,
  vline: 1,
  rect: 2,
  fib: 2,
  measure: 2,
};

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

export const TOOL_LABEL: Record<DrawingKind, string> = {
  trend: 'Trend line',
  hray: 'Horizontal ray',
  hline: 'Horizontal line',
  vline: 'Vertical line',
  rect: 'Rectangle',
  fib: 'Fib retracement',
  measure: 'Measure',
};

/** Time and price to pixels in the pane. `null` when the chart has no scale for it yet. */
export interface Projector {
  x(time: number): number | null;
  y(price: number): number | null;
}

export interface Bounds {
  width: number;
  height: number;
}

export type ShapeRole = 'main' | 'level' | 'guide' | 'fill';

export type Shape =
  | { t: 'seg'; x1: number; y1: number; x2: number; y2: number; role: ShapeRole; dash: boolean }
  | { t: 'rect'; x: number; y: number; w: number; h: number; role: ShapeRole }
  | {
      t: 'label';
      x: number;
      y: number;
      text: string;
      anchor: 'left' | 'right' | 'center';
      role: ShapeRole;
    };

export interface ShapeOptions {
  /** Decimals for prices in labels. */
  decimals: number;
  bucketSeconds: number;
}

const DEFAULT_OPTIONS: ShapeOptions = { decimals: 2, bucketSeconds: 60 };

interface Px {
  x: number;
  y: number;
}

function project(p: ChartPoint, proj: Projector): Px | null {
  const x = proj.x(p.time);
  const y = proj.y(p.price);
  if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

const seg = (
  a: Px,
  b: Px,
  role: ShapeRole = 'main',
  dash = false,
): Shape => ({ t: 'seg', x1: a.x, y1: a.y, x2: b.x, y2: b.y, role, dash });

/** Fibonacci level price: level 0 sits at the end point, level 1 at the start. */
export function fibPrice(start: ChartPoint, end: ChartPoint, level: number): number {
  return end.price + (start.price - end.price) * level;
}

export interface MeasureStats {
  dPrice: number;
  /** Percent move from the start price. */
  percent: number;
  seconds: number;
  bars: number;
}

export function measureStats(a: ChartPoint, b: ChartPoint, bucketSeconds: number): MeasureStats {
  const dPrice = b.price - a.price;
  const seconds = b.time - a.time;
  return {
    dPrice,
    percent: a.price === 0 ? 0 : (dPrice / a.price) * 100,
    seconds,
    bars: Math.round(Math.abs(seconds) / bucketSeconds),
  };
}

/** The screen shapes for one drawing. Empty when it cannot be placed. */
export function drawingShapes(
  d: Drawing,
  proj: Projector,
  bounds: Bounds,
  options: ShapeOptions = DEFAULT_OPTIONS,
): Shape[] {
  const a = d.points[0] ? project(d.points[0], proj) : null;
  if (!a) return [];
  const b = d.points[1] ? project(d.points[1], proj) : null;

  switch (d.kind) {
    case 'hline':
      return [seg({ x: 0, y: a.y }, { x: bounds.width, y: a.y })];
    case 'hray':
      return [seg(a, { x: bounds.width, y: a.y })];
    case 'vline':
      return [seg({ x: a.x, y: 0 }, { x: a.x, y: bounds.height })];
    case 'trend':
      return b ? [seg(a, b)] : [];
    case 'rect': {
      if (!b) return [];
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      return [{ t: 'rect', x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), role: 'main' }];
    }
    case 'fib': {
      if (!b || !d.points[0] || !d.points[1]) return [];
      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, b.x);
      const out: Shape[] = [seg(a, b, 'guide', true)];
      for (const level of FIB_LEVELS) {
        const price = fibPrice(d.points[0], d.points[1], level);
        const y = proj.y(price);
        if (y === null) continue;
        out.push(seg({ x: left, y }, { x: right, y }, level === 0 || level === 1 ? 'main' : 'level'));
        out.push({
          t: 'label',
          x: left + 4,
          y: y - 3,
          text: `${level} (${formatPrice(price, options.decimals)})`,
          anchor: 'left',
          role: 'level',
        });
      }
      return out;
    }
    case 'measure': {
      if (!b || !d.points[0] || !d.points[1]) return [];
      const stats = measureStats(d.points[0], d.points[1], options.bucketSeconds);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      const up = stats.dPrice >= 0;
      const cx = x + w / 2;
      return [
        { t: 'rect', x, y, w, h, role: 'fill' },
        seg({ x: cx, y: a.y }, { x: cx, y: b.y }, 'guide'),
        seg({ x: a.x, y: b.y }, { x: b.x, y: b.y }, 'guide'),
        {
          t: 'label',
          x: cx,
          y: up ? y - 22 : y + h + 14,
          text: `${formatSigned(stats.dPrice, options.decimals)} (${formatPercent(stats.percent, { signed: true })})`,
          anchor: 'center',
          role: 'main',
        },
        {
          t: 'label',
          x: cx,
          y: up ? y - 8 : y + h + 28,
          text: `${stats.bars} bars · ${formatSpan(Math.abs(stats.seconds))}`,
          anchor: 'center',
          role: 'level',
        },
      ];
    }
  }
}

export interface Handle {
  /** Index into the handle list; for a rectangle 0..3 are its corners. */
  index: number;
  x: number;
  y: number;
}

/** Where the drag handles of a selected drawing sit. */
export function handlesOf(d: Drawing, proj: Projector, bounds: Bounds): Handle[] {
  const p0 = d.points[0];
  const p1 = d.points[1];
  const a = p0 ? project(p0, proj) : null;
  if (!a) return [];
  switch (d.kind) {
    case 'hline':
      return [{ index: 0, x: bounds.width - 24, y: a.y }];
    case 'vline':
      return [{ index: 0, x: a.x, y: bounds.height / 2 }];
    case 'hray':
      return [{ index: 0, x: a.x, y: a.y }];
    case 'rect': {
      const b = p1 ? project(p1, proj) : null;
      if (!b) return [];
      return [
        { index: 0, x: a.x, y: a.y },
        { index: 1, x: b.x, y: b.y },
        { index: 2, x: b.x, y: a.y },
        { index: 3, x: a.x, y: b.y },
      ];
    }
    default: {
      const b = p1 ? project(p1, proj) : null;
      if (!b) return [];
      return [
        { index: 0, x: a.x, y: a.y },
        { index: 1, x: b.x, y: b.y },
      ];
    }
  }
}

export function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export type Hit = { part: 'handle'; index: number } | { part: 'body' };

/**
 * What is under the pointer. Handles win over the body, and only count for a
 * drawing that is selected: an unselected drawing is grabbed by its body.
 */
export function hitTest(
  d: Drawing,
  proj: Projector,
  bounds: Bounds,
  x: number,
  y: number,
  tolerance: number,
  opts: { selected: boolean; options?: ShapeOptions } = { selected: false },
): Hit | null {
  if (opts.selected) {
    for (const h of handlesOf(d, proj, bounds)) {
      if (Math.hypot(x - h.x, y - h.y) <= tolerance * 1.4) return { part: 'handle', index: h.index };
    }
  }
  for (const s of drawingShapes(d, proj, bounds, opts.options)) {
    if (s.t === 'seg') {
      if (s.role === 'fill') continue;
      if (distToSegment(x, y, s.x1, s.y1, s.x2, s.y2) <= tolerance) return { part: 'body' };
    } else if (s.t === 'rect') {
      if (x >= s.x - tolerance && x <= s.x + s.w + tolerance && y >= s.y - tolerance && y <= s.y + s.h + tolerance) {
        return { part: 'body' };
      }
    }
  }
  return null;
}

/**
 * The drawing under a pointer. The selected drawing's handles win over every
 * other drawing's body, however they are stacked (a rectangle's corner can sit
 * inside a later drawing and must still be grabbable); after that the topmost
 * drawing whose body is under the pointer wins.
 */
export function pickDrawing(
  drawings: readonly Drawing[],
  selectedId: string | null,
  proj: Projector,
  bounds: Bounds,
  x: number,
  y: number,
  tolerance: number,
  options?: ShapeOptions,
): { drawing: Drawing; hit: Hit } | null {
  const selected = selectedId ? drawings.find((d) => d.id === selectedId) : undefined;
  if (selected) {
    const hit = hitTest(selected, proj, bounds, x, y, tolerance, { selected: true, ...(options ? { options } : {}) });
    if (hit?.part === 'handle') return { drawing: selected, hit };
  }
  for (let i = drawings.length - 1; i >= 0; i--) {
    const drawing = drawings[i]!;
    const hit = hitTest(drawing, proj, bounds, x, y, tolerance, {
      selected: drawing.id === selectedId,
      ...(options ? { options } : {}),
    });
    if (hit) return { drawing, hit };
  }
  return null;
}

/** Moves a point of a drawing to `to`, respecting what each kind lets a handle change. */
function movePoint(d: Drawing, index: number, to: ChartPoint): Drawing {
  const points = d.points.map((p) => ({ ...p }));
  const p0 = points[0];
  const p1 = points[1];
  switch (d.kind) {
    case 'hline':
      if (p0) p0.price = to.price;
      break;
    case 'vline':
      if (p0) p0.time = to.time;
      break;
    case 'rect':
      if (!p0 || !p1) break;
      if (index === 0) {
        p0.time = to.time;
        p0.price = to.price;
      } else if (index === 1) {
        p1.time = to.time;
        p1.price = to.price;
      } else if (index === 2) {
        p1.time = to.time;
        p0.price = to.price;
      } else {
        p0.time = to.time;
        p1.price = to.price;
      }
      break;
    default: {
      const p = points[index];
      if (p) {
        p.time = to.time;
        p.price = to.price;
      }
    }
  }
  return { ...d, points };
}

/**
 * The drawing after a drag. `from` is where the drag began and `to` where the
 * pointer is now: a handle drag moves that anchor to `to`, a body drag shifts
 * every anchor by the same (time, price) delta.
 */
export function applyEdit(d: Drawing, hit: Hit, from: ChartPoint, to: ChartPoint): Drawing {
  if (hit.part === 'handle') return movePoint(d, hit.index, to);
  const dt = to.time - from.time;
  const dp = to.price - from.price;
  return {
    ...d,
    points: d.points.map((p) => ({ time: p.time + dt, price: p.price + dp })),
  };
}

/** A drawing that collapsed to a point is discarded rather than kept invisible. */
export function isDegenerate(d: Drawing, proj: Projector, minPixels = 4): boolean {
  if (POINTS_REQUIRED[d.kind] === 1) return d.points.length < 1;
  const a = d.points[0] ? project(d.points[0], proj) : null;
  const b = d.points[1] ? project(d.points[1], proj) : null;
  if (!a || !b) return true;
  return Math.hypot(a.x - b.x, a.y - b.y) < minPixels;
}

/**
 * Magnet: the bar under the pointer and, when a price of that bar's OHLC lies
 * within `thresholdPx` of the pointer, that price. The time always snaps to the
 * bar; the price falls back to the raw pointer price when nothing is close.
 */
export function snapToCandle(
  candles: readonly Candle5[],
  logical: number,
  pointerY: number,
  rawPrice: number,
  priceToY: (price: number) => number | null,
  thresholdPx: number,
): ChartPoint | null {
  if (candles.length === 0) return null;
  const index = Math.min(candles.length - 1, Math.max(0, Math.round(logical)));
  const c = candles[index]!;
  let best = rawPrice;
  let bestDist = thresholdPx;
  for (let k = 1; k <= 4; k++) {
    const price = c[k]!;
    const y = priceToY(price);
    if (y === null) continue;
    const dist = Math.abs(y - pointerY);
    if (dist <= bestDist) {
      best = price;
      bestDist = dist;
    }
  }
  return { time: c[0], price: best };
}

let counter = 0;

/** A drawing id unique within a session and across reloads. */
export function newDrawingId(): string {
  counter += 1;
  return `d${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

const KIND_SET = new Set<string>(DRAWING_KINDS);

/**
 * Reads drawings back from storage. Storage is a trust boundary: it may hold
 * anything, from an older shape to a hand-edited string, so each entry is
 * checked and a bad one is dropped rather than thrown.
 */
export function parseDrawings(raw: unknown): Drawing[] {
  if (!Array.isArray(raw)) return [];
  const out: Drawing[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, kind, points } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    if (typeof kind !== 'string' || !KIND_SET.has(kind)) continue;
    if (!Array.isArray(points)) continue;
    const need = POINTS_REQUIRED[kind as DrawingKind];
    if (points.length !== need) continue;
    const clean: ChartPoint[] = [];
    for (const p of points) {
      const t = (p as ChartPoint | null)?.time;
      const v = (p as ChartPoint | null)?.price;
      if (typeof t !== 'number' || typeof v !== 'number' || !Number.isFinite(t) || !Number.isFinite(v)) break;
      clean.push({ time: t, price: v });
    }
    if (clean.length !== need) continue;
    seen.add(id);
    out.push({ id, kind: kind as DrawingKind, points: clean });
  }
  return out;
}
