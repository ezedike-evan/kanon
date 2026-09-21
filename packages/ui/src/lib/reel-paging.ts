/**
 * Paging the Predict reel from a mouse wheel or a keyboard, on a desktop.
 *
 * A wheel is a stream of events, not a gesture: a trackpad flick sends dozens
 * over a second, and a physical wheel sends one per notch. The reel moves one
 * page per gesture, so a flick is one page and each notch is one page. Pure and
 * clock-free (the time comes in with each event), so it is tested without a DOM.
 */

/** After a page turn, no further one for this long: the page is still settling. */
export const TURN_LOCK_MS = 450;
/** Events closer together than this belong to one stream (a trackpad flick or its inertia tail). */
export const STREAM_GAP_MS = 100;
/** A smaller vertical delta than this is a resting finger, not a scroll. */
export const MIN_DELTA = 4;

export interface WheelSample {
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages, as `WheelEvent.deltaMode`. */
  deltaMode: number;
  /** Milliseconds, any monotonic clock. */
  time: number;
}

/** `1` for the next page, `-1` for the previous one, `0` for nothing. */
export type Step = -1 | 0 | 1;

/**
 * A stateful judge of wheel events. Call it with every event; it says which page
 * turn, if any, the event begins. An event turns a page only when it is not part
 * of the stream that turned the last one and the lock has run out.
 */
export function createWheelPager(): (sample: WheelSample) => Step {
  let lastAt = Number.NEGATIVE_INFINITY;
  let lockedUntil = Number.NEGATIVE_INFINITY;
  return (sample) => {
    const gap = sample.time - lastAt;
    lastAt = sample.time;
    // A sideways scroll (or a mostly sideways one) is not a page turn.
    if (Math.abs(sample.deltaX) > Math.abs(sample.deltaY)) return 0;
    const dy = sample.deltaMode === 0 ? sample.deltaY : sample.deltaY * 16;
    if (Math.abs(dy) < MIN_DELTA) return 0;
    if (sample.time < lockedUntil) return 0;
    // Still the same stream as the turn that just happened: its inertia tail.
    if (gap <= STREAM_GAP_MS && sample.time - lockedUntil < 1_500) return 0;
    lockedUntil = sample.time + TURN_LOCK_MS;
    return dy > 0 ? 1 : -1;
  };
}

/** What an arrow or page key means to the reel, or `0`. */
export function keyStep(key: string): Step {
  if (key === 'ArrowDown' || key === 'PageDown') return 1;
  if (key === 'ArrowUp' || key === 'PageUp') return -1;
  return 0;
}

/** The index a step lands on, never past either end. `from` is where the reel is, or was last sent. */
export function stepIndex(from: number, step: Step, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, from + step));
}
