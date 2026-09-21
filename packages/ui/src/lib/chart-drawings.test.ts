import { describe, expect, it } from 'vitest';
import {
  FIB_LEVELS,
  POINTS_REQUIRED,
  applyEdit,
  distToSegment,
  drawingShapes,
  fibPrice,
  handlesOf,
  hitTest,
  isDegenerate,
  measureStats,
  parseDrawings,
  pickDrawing,
  snapToCandle,
  type Bounds,
  type Drawing,
  type Projector,
} from './chart-drawings';
import type { Candle5 } from './chart-protocol';

// 1 second = 0.1 px, price 100 = 100 px, y grows downward from 1000.
const proj: Projector = { x: (t) => t / 10, y: (p) => 1000 - p };
const bounds: Bounds = { width: 400, height: 800 };

const line = (kind: Drawing['kind'], ...pts: Array<[number, number]>): Drawing => ({
  id: kind,
  kind,
  points: pts.map(([time, price]) => ({ time, price })),
});

describe('shapes', () => {
  it('a horizontal line spans the pane at the price', () => {
    const [s] = drawingShapes(line('hline', [500, 700]), proj, bounds);
    expect(s).toMatchObject({ t: 'seg', x1: 0, x2: 400, y1: 300, y2: 300 });
  });

  it('a horizontal ray starts at its anchor and runs to the right edge', () => {
    const [s] = drawingShapes(line('hray', [500, 700]), proj, bounds);
    expect(s).toMatchObject({ t: 'seg', x1: 50, x2: 400, y1: 300, y2: 300 });
  });

  it('a vertical line spans the pane height at the time', () => {
    const [s] = drawingShapes(line('vline', [500, 700]), proj, bounds);
    expect(s).toMatchObject({ t: 'seg', x1: 50, x2: 50, y1: 0, y2: 800 });
  });

  it('a trend line joins its two anchors and does not extend', () => {
    const [s] = drawingShapes(line('trend', [500, 700], [1500, 900]), proj, bounds);
    expect(s).toMatchObject({ x1: 50, y1: 300, x2: 150, y2: 100 });
  });

  it('a rectangle is normalised whichever corner was placed first', () => {
    const a = drawingShapes(line('rect', [500, 700], [1500, 900]), proj, bounds)[0];
    const b = drawingShapes(line('rect', [1500, 900], [500, 700]), proj, bounds)[0];
    expect(a).toMatchObject({ t: 'rect', x: 50, y: 100, w: 100, h: 200 });
    expect(b).toEqual(a);
  });

  it('a drawing whose anchor cannot be projected draws nothing', () => {
    const none: Projector = { x: () => null, y: () => null };
    expect(drawingShapes(line('trend', [1, 1], [2, 2]), none, bounds)).toEqual([]);
  });

  it('a two-point drawing missing its second point draws nothing rather than throwing', () => {
    expect(drawingShapes(line('trend', [1, 1]), proj, bounds)).toEqual([]);
  });
});

describe('fib retracement', () => {
  const start = { time: 0, price: 1000 };
  const end = { time: 1000, price: 800 };

  it('level 0 sits at the end point and level 1 at the start', () => {
    expect(fibPrice(start, end, 0)).toBe(800);
    expect(fibPrice(start, end, 1)).toBe(1000);
    expect(fibPrice(start, end, 0.5)).toBe(900);
    expect(fibPrice(start, end, 0.618)).toBeCloseTo(923.6, 6);
  });

  it('draws one line and one label per level, between the anchors', () => {
    const shapes = drawingShapes(line('fib', [0, 1000], [1000, 800]), proj, bounds, { decimals: 2, bucketSeconds: 60 });
    const levels = shapes.filter((s) => s.t === 'seg' && s.role !== 'guide');
    const labels = shapes.filter((s) => s.t === 'label');
    expect(levels).toHaveLength(FIB_LEVELS.length);
    expect(labels).toHaveLength(FIB_LEVELS.length);
    for (const s of levels) {
      if (s.t === 'seg') expect([s.x1, s.x2]).toEqual([0, 100]);
    }
  });

  it('labels carry the level and its price to the requested decimals', () => {
    const shapes = drawingShapes(line('fib', [0, 1000], [1000, 800]), proj, bounds, { decimals: 2, bucketSeconds: 60 });
    const texts = shapes.flatMap((s) => (s.t === 'label' ? [s.text] : []));
    expect(texts).toContain('0.618 (923.60)');
    expect(texts).toContain('0 (800.00)');
  });
});

describe('measure', () => {
  it('reports the move, the percentage, the bars and the span', () => {
    const stats = measureStats({ time: 0, price: 200 }, { time: 3600, price: 250 }, 900);
    expect(stats).toEqual({ dPrice: 50, percent: 25, seconds: 3600, bars: 4 });
  });

  it('a downward measure is negative and still counts bars positively', () => {
    const stats = measureStats({ time: 3600, price: 250 }, { time: 0, price: 200 }, 900);
    expect(stats.dPrice).toBe(-50);
    expect(stats.bars).toBe(4);
  });

  it('a zero start price does not divide by zero', () => {
    expect(measureStats({ time: 0, price: 0 }, { time: 60, price: 5 }, 60).percent).toBe(0);
  });

  it('labels the box with signed change and bar count', () => {
    const shapes = drawingShapes(line('measure', [0, 200], [3600, 250]), proj, bounds, { decimals: 2, bucketSeconds: 900 });
    const texts = shapes.flatMap((s) => (s.t === 'label' ? [s.text] : []));
    expect(texts[0]).toBe('+50.00 (+25.00%)');
    expect(texts[1]).toBe('4 bars · 1h');
  });
});

describe('hit testing', () => {
  const trend = line('trend', [0, 900], [1000, 800]); // px (0,100) -> (100,200)

  it('hits the body of a segment within tolerance and misses beyond it', () => {
    expect(hitTest(trend, proj, bounds, 50, 150, 8)).toEqual({ part: 'body' });
    expect(hitTest(trend, proj, bounds, 50, 170, 8)).toBeNull();
  });

  it('a segment does not extend past its endpoints', () => {
    expect(hitTest(trend, proj, bounds, 200, 300, 8)).toBeNull();
  });

  it('a horizontal line is hit anywhere along it', () => {
    const h = line('hline', [0, 700]);
    expect(hitTest(h, proj, bounds, 333, 302, 8)).toEqual({ part: 'body' });
    expect(hitTest(h, proj, bounds, 333, 320, 8)).toBeNull();
  });

  it('handles win over the body, but only for a selected drawing', () => {
    expect(hitTest(trend, proj, bounds, 1, 101, 8, { selected: true })).toEqual({ part: 'handle', index: 0 });
    expect(hitTest(trend, proj, bounds, 99, 199, 8, { selected: true })).toEqual({ part: 'handle', index: 1 });
    expect(hitTest(trend, proj, bounds, 1, 101, 8, { selected: false })).toEqual({ part: 'body' });
  });

  it('the inside of a rectangle is its body', () => {
    const r = line('rect', [0, 900], [1000, 700]);
    expect(hitTest(r, proj, bounds, 50, 200, 4)).toEqual({ part: 'body' });
    expect(hitTest(r, proj, bounds, 300, 200, 4)).toBeNull();
  });

  it('rectangle handles are its four corners', () => {
    const r = line('rect', [0, 900], [1000, 700]);
    const hs = handlesOf(r, proj, bounds);
    expect(hs.map((h) => [h.index, h.x, h.y])).toEqual([
      [0, 0, 100],
      [1, 100, 300],
      [2, 100, 100],
      [3, 0, 300],
    ]);
  });

  it('distance to a segment clamps to its ends', () => {
    expect(distToSegment(0, 0, 10, 0, 20, 0)).toBe(10);
    expect(distToSegment(15, 5, 10, 0, 20, 0)).toBe(5);
    expect(distToSegment(3, 4, 0, 0, 0, 0)).toBe(5); // a zero-length segment is a point
  });
});

describe('editing', () => {
  const from = { time: 500, price: 850 };
  const to = { time: 700, price: 900 };

  it('a body drag shifts every anchor by the same delta', () => {
    const d = applyEdit(line('trend', [0, 900], [1000, 800]), { part: 'body' }, from, to);
    expect(d.points).toEqual([
      { time: 200, price: 950 },
      { time: 1200, price: 850 },
    ]);
  });

  it('a handle drag moves only that anchor', () => {
    const d = applyEdit(line('trend', [0, 900], [1000, 800]), { part: 'handle', index: 1 }, from, to);
    expect(d.points).toEqual([
      { time: 0, price: 900 },
      { time: 700, price: 900 },
    ]);
  });

  it('a horizontal line only moves in price; a vertical line only in time', () => {
    const h = applyEdit(line('hline', [500, 700]), { part: 'handle', index: 0 }, from, to);
    expect(h.points[0]).toEqual({ time: 500, price: 900 });
    const v = applyEdit(line('vline', [500, 700]), { part: 'handle', index: 0 }, from, to);
    expect(v.points[0]).toEqual({ time: 700, price: 700 });
  });

  it('a rectangle corner handle moves the two edges it touches', () => {
    const r = line('rect', [0, 900], [1000, 700]);
    const top = applyEdit(r, { part: 'handle', index: 2 }, from, to); // corner (p1.time, p0.price)
    expect(top.points).toEqual([
      { time: 0, price: 900 },
      { time: 700, price: 700 },
    ]);
    const bottomLeft = applyEdit(r, { part: 'handle', index: 3 }, from, to);
    expect(bottomLeft.points).toEqual([
      { time: 700, price: 900 },
      { time: 1000, price: 900 },
    ]);
  });

  it('never mutates the drawing it was given', () => {
    const original = line('trend', [0, 900], [1000, 800]);
    const snapshot = JSON.stringify(original);
    applyEdit(original, { part: 'body' }, from, to);
    applyEdit(original, { part: 'handle', index: 0 }, from, to);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('a two-point drawing squashed to a dot is degenerate; a one-point drawing never is', () => {
    expect(isDegenerate(line('trend', [0, 900], [10, 900]), proj)).toBe(true);
    expect(isDegenerate(line('trend', [0, 900], [1000, 900]), proj)).toBe(false);
    expect(isDegenerate(line('hline', [0, 900]), proj)).toBe(false);
  });
});

describe('magnet', () => {
  const candles: Candle5[] = [
    [0, 100, 110, 95, 105],
    [60, 105, 120, 100, 115],
    [120, 115, 118, 90, 92],
  ];
  const y = (p: number) => 1000 - p;

  it('snaps time to the nearest bar and price to the nearest OHLC within the threshold', () => {
    const p = snapToCandle(candles, 0.9, y(119), 119, y, 10);
    expect(p).toEqual({ time: 60, price: 120 });
  });

  it('keeps the raw price when no OHLC value is close enough, but still snaps time', () => {
    const p = snapToCandle(candles, 1.2, y(200), 200, y, 10);
    expect(p).toEqual({ time: 60, price: 200 });
  });

  it('clamps past the last bar rather than extrapolating', () => {
    expect(snapToCandle(candles, 9, y(92), 92, y, 10)).toEqual({ time: 120, price: 92 });
  });

  it('has nothing to snap to on an empty series', () => {
    expect(snapToCandle([], 0, 0, 0, y, 10)).toBeNull();
  });
});

describe('storage boundary', () => {
  it('keeps well-formed drawings', () => {
    const ok = [line('trend', [1, 2], [3, 4]), line('hline', [5, 6])];
    expect(parseDrawings(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
  });

  it('drops anything malformed instead of throwing', () => {
    const raw = [
      null,
      'x',
      { id: 'a', kind: 'circle', points: [{ time: 1, price: 1 }] },
      { id: 'b', kind: 'trend', points: [{ time: 1, price: 1 }] }, // wrong arity
      { id: 'c', kind: 'hline', points: [{ time: 'x', price: 1 }] },
      { id: 'd', kind: 'hline', points: [{ time: 1, price: Infinity }] },
      { id: '', kind: 'hline', points: [{ time: 1, price: 1 }] },
      { id: 'e', kind: 'hline', points: [{ time: 1, price: 1 }] },
      { id: 'e', kind: 'hline', points: [{ time: 2, price: 2 }] }, // duplicate id
    ];
    expect(parseDrawings(raw)).toEqual([{ id: 'e', kind: 'hline', points: [{ time: 1, price: 1 }] }]);
    expect(parseDrawings('nope')).toEqual([]);
    expect(parseDrawings(undefined)).toEqual([]);
  });

  it('every kind states how many points it needs', () => {
    expect(POINTS_REQUIRED).toMatchObject({ hline: 1, vline: 1, hray: 1, trend: 2, rect: 2, fib: 2, measure: 2 });
  });
});

describe('picking', () => {
  const rect = { ...line('rect', [0, 900], [1000, 700]), id: 'rect' }; // px (0,100)-(100,300)
  const cover = { ...line('measure', [500, 900], [1500, 700]), id: 'cover' }; // px (50,100)-(150,300), stacked above
  const list = [rect, cover];

  it('the topmost drawing under the pointer wins', () => {
    expect(pickDrawing(list, null, proj, bounds, 75, 200, 6)?.drawing.id).toBe('cover');
    expect(pickDrawing(list, null, proj, bounds, 10, 200, 6)?.drawing.id).toBe('rect');
  });

  it('nothing under the pointer is null', () => {
    expect(pickDrawing(list, null, proj, bounds, 300, 500, 6)).toBeNull();
  });

  it('a selected drawing handle beats another drawing stacked over it', () => {
    // rect corner 1 is at px (100,300), inside `cover`'s box.
    const picked = pickDrawing(list, 'rect', proj, bounds, 100, 300, 6);
    expect(picked?.drawing.id).toBe('rect');
    expect(picked?.hit).toEqual({ part: 'handle', index: 1 });
    // Unselected, the same point belongs to the drawing on top.
    expect(pickDrawing(list, null, proj, bounds, 100, 300, 6)?.drawing.id).toBe('cover');
  });

  it('a selected drawing does not out-rank one above it for a body hit', () => {
    expect(pickDrawing(list, 'rect', proj, bounds, 75, 200, 6)?.drawing.id).toBe('cover');
  });
});
