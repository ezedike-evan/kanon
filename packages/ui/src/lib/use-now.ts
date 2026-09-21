import { useSyncExternalStore } from 'react';

/**
 * One shared clock for every relative time on screen ("5m", "Today"): a single
 * 30-second interval that runs only while something is subscribed, instead of a
 * timer per row. Reads the clock afresh each tick rather than counting.
 *
 * On the server it reports 0, meaning "no clock yet": `relativeTime` and
 * `dayLabel` then print dates, so server render and hydration agree and the
 * relative form arrives with the first client tick.
 */
const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let current = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      listeners.forEach((l) => l());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const getSnapshot = () => (current === 0 ? (current = Date.now()) : current);
const getServerSnapshot = () => 0;

/** Milliseconds now, refreshed every 30s; 0 on the server. */
export function useNowMs(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
