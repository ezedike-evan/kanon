import { useEffect, useState } from 'react';
import { Num } from './ui';
import { formatCountdown } from '../lib/predict-map';

/**
 * The current second, ticking, or `null` before the first client render.
 *
 * Reading the clock during a server render would print one time and hydrate to
 * another, so a screen shows a placeholder until this has a value. It reads the
 * clock afresh every tick rather than counting: a countdown that drifts from
 * the chain's clock is worse than none, the same rule `countdown.tsx` keeps.
 */
export function useNowSeconds(): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const read = () => setNow(Math.floor(Date.now() / 1000));
    read();
    const id = setInterval(read, 1000);
    return () => clearInterval(id);
  }, []);

  return now;
}

/**
 * `hh:mm:ss` to `endsAt` (unix seconds). Monospaced and tabular through `Num`,
 * so the digits never change width as they change value.
 */
export function ExpiryCountdown({
  endsAt,
  now,
  className,
}: {
  endsAt: number;
  now: number | null;
  className?: string | undefined;
}) {
  return (
    <Num className={className}>{now === null ? '--:--:--' : formatCountdown(endsAt - now)}</Num>
  );
}
