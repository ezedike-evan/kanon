import { useEffect, useState } from 'react';

/**
 * The two clocks a countdown needs. `use-now.ts` is the slow shared one, for
 * "5m ago"; these are per deadline, and each reads the clock afresh rather
 * than counting, so a tab that slept comes back on the right second.
 */

/** The longest a timer can be set for. Past it a browser fires at once, which is the opposite of waiting. */
const LONGEST_TIMEOUT_MS = 2_147_483_647;

/**
 * Whether a moment has passed, flipping once when it does. One timeout, no
 * tick: for the part of a screen that changes at a deadline and must not
 * render every second on the way there. A moment that is not a time
 * (`Infinity`, for "there is no deadline") never passes and sets no timer.
 */
export function useDue(atMs: number): boolean {
  const [due, setDue] = useState(() => Date.now() >= atMs);
  useEffect(() => {
    const left = atMs - Date.now();
    setDue(left <= 0);
    if (left <= 0 || !Number.isFinite(left) || left > LONGEST_TIMEOUT_MS) return undefined;
    const timer = setTimeout(() => setDue(true), left);
    return () => clearTimeout(timer);
  }, [atMs]);
  return due;
}

/**
 * The time now, re-read exactly as each whole second of a countdown to `atMs`
 * runs out, so the digits change on the countdown's own seconds and not on the
 * wall clock's. It stops once the moment has passed. 0 until the first client
 * read, meaning "no clock yet": whatever reads it prints no time until then,
 * so server render and hydration agree.
 */
export function useCountdownClock(atMs: number): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      const at = Date.now();
      setNow(at);
      const left = atMs - at;
      if (left > 0) timer = setTimeout(read, left % 1000 || 1000);
    };
    read();
    return () => clearTimeout(timer);
  }, [atMs]);
  return now;
}
