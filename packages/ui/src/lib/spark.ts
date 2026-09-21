/**
 * Geometry for the small SVG visuals. Pure, so it is tested.
 */

export interface SparkGeometry {
  /** SVG path for the line, `M x y L x y ...`. */
  line: string;
  /** Closed path under the line, for a wash. */
  area: string;
  /** Last point, where the end dot goes. */
  last: { x: number; y: number };
  /** Direction from first to last value. */
  direction: 'up' | 'down' | 'flat';
}

const r = (n: number) => Math.round(n * 100) / 100;

/**
 * Maps a series into a `width` x `height` box with `pad` px on every side.
 * A flat series draws a centred line, not a divide-by-zero.
 */
export function sparkGeometry(
  data: readonly number[],
  width: number,
  height: number,
  pad = 2,
): SparkGeometry | null {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const pts = data.map((v, i) => ({
    x: r(pad + (i / (data.length - 1)) * innerW),
    y: r(span === 0 ? height / 2 : pad + (1 - (v - min) / span) * innerH),
  }));
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const area = `${line} L${last.x} ${height} L${first.x} ${height} Z`;
  const delta = (data[data.length - 1] ?? 0) - (data[0] ?? 0);
  return { line, area, last, direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat' };
}

export interface RingGeometry {
  radius: number;
  circumference: number;
  /** stroke-dasharray for the filled arc. */
  dash: string;
  /** Value clamped to 0..1. */
  value: number;
}

/** Ring maths: `size` outer diameter, `thickness` stroke, `value` 0..1 (clamped, NaN is 0). */
export function ringGeometry(size: number, thickness: number, value: number): RingGeometry {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  return {
    radius,
    circumference,
    dash: `${r(circumference * v)} ${r(circumference)}`,
    value: v,
  };
}
