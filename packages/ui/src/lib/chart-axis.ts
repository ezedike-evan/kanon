/**
 * Time <-> logical-index mapping for drawings.
 *
 * A drawing is anchored in (time, price), not in pixels, so it stays put when
 * the user pans or zooms. lightweight-charts positions things by *logical
 * index* (the position of a bar in the data array) and only converts a time
 * to a coordinate for times that have a bar. Drawings routinely sit beyond the
 * last bar (a ray running into the future) or between bars, and a canonical
 * series may be sparse, so a bar's index is not `(t - t0) / bucket`.
 *
 * `TimeAxis` bridges that: it holds the bar times, interpolates linearly
 * between neighbouring bars, and extrapolates past either end at the bucket
 * width. It reads the array it is given by reference, so the runtime can
 * append live candles without rebuilding it.
 */
export class TimeAxis {
  constructor(
    private readonly times: readonly number[],
    /** Candle width, used to extrapolate past either end. Set when the timeframe changes. */
    public bucketSeconds: number,
  ) {}

  get length(): number {
    return this.times.length;
  }

  /** Fractional logical index of `time`. */
  toLogical(time: number): number {
    const n = this.times.length;
    if (n === 0) return 0;
    const first = this.times[0]!;
    const last = this.times[n - 1]!;
    if (time <= first) return (time - first) / this.bucketSeconds;
    if (time >= last) return n - 1 + (time - last) / this.bucketSeconds;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid]! <= time) lo = mid;
      else hi = mid;
    }
    const a = this.times[lo]!;
    const b = this.times[lo + 1]!;
    return lo + (time - a) / (b - a);
  }

  /** Inverse of `toLogical`. */
  toTime(logical: number): number {
    const n = this.times.length;
    if (n === 0) return 0;
    const first = this.times[0]!;
    const last = this.times[n - 1]!;
    if (logical <= 0) return first + logical * this.bucketSeconds;
    if (logical >= n - 1) return last + (logical - (n - 1)) * this.bucketSeconds;
    const i = Math.floor(logical);
    const a = this.times[i]!;
    const b = this.times[i + 1]!;
    return a + (logical - i) * (b - a);
  }

  /** Index of the bar nearest `logical`, or -1 when there is no bar there. */
  nearestIndex(logical: number): number {
    const n = this.times.length;
    if (n === 0) return -1;
    return Math.min(n - 1, Math.max(0, Math.round(logical)));
  }
}
