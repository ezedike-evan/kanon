'use client';

import { useEffect, useRef, useState } from 'react';
import { Num } from '@/components/ui';
import { cx } from '@/lib/cx';

/**
 * Countdowns run off a target timestamp on an animation frame, not off a
 * setInterval that increments a counter. A stepped or pausable countdown is
 * explicitly not allowed: the cooling-off period is the product, and friction
 * that stutters reads as friction you might be able to argue with.
 */
function useRemaining(targetMs: number, fromMs: number): number {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, targetMs - fromMs),
  );
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    let frame = 0;
    const tick = (now: number) => {
      startedAt.current ??= now;
      const elapsed = now - startedAt.current;
      setRemaining(Math.max(0, targetMs - fromMs - elapsed));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [targetMs, fromMs]);

  return remaining;
}

function pad(n: number): string {
  return String(Math.floor(n)).padStart(2, '0');
}

/** mm:ss. The undo window before a valid setup executes on its own. */
export function UndoCountdown({
  seconds,
  className,
}: {
  seconds: number;
  className?: string | undefined;
}) {
  const [target] = useState(() => Date.now() + seconds * 1000);
  const [origin] = useState(() => Date.now());
  const remaining = useRemaining(target, origin);
  const total = Math.ceil(remaining / 1000);
  return (
    <Num className={className}>
      {pad(total / 60)}:{pad(total % 60)}
    </Num>
  );
}

/**
 * hh:mm:ss plus the bar. Both read from the same clock, so the bar cannot
 * disagree with the digits about how long is left.
 */
export function CoolingOffCountdown({
  requestedAt,
  holdSeconds,
  nowAt,
}: {
  requestedAt: number;
  holdSeconds: number;
  /** The demo clock, so the screen opens where the design says it does. */
  nowAt: number;
}) {
  const target = requestedAt + holdSeconds * 1000;
  const remaining = useRemaining(target, nowAt);
  const seconds = Math.ceil(remaining / 1000);
  const elapsedFraction = 1 - remaining / (holdSeconds * 1000);

  return (
    <>
      <Num className="mt-4 text-56 leading-[0.9] font-medium tracking-t45">
        {pad(seconds / 3600)}:{pad((seconds % 3600) / 60)}:{pad(seconds % 60)}
      </Num>
      <div
        className="mt-4.5 flex h-0.75 bg-raised"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(elapsedFraction * 100)}
        aria-label="Cooling-off period elapsed"
      >
        <div
          className={cx('bg-signal')}
          style={{ width: `${(elapsedFraction * 100).toFixed(3)}%` }}
        />
      </div>
    </>
  );
}
