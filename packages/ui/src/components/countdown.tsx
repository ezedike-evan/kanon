import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Num } from './ui';
import { ProgressBar } from './motion';
import { cx } from '../lib/cx';

/**
 * Countdowns read the remaining time off a target timestamp every tick, rather
 * than decrementing a counter. A stepped or pausable countdown is explicitly
 * not allowed: the cooling-off period is the product, and friction that
 * stutters — or that drifts away from the chain's clock — reads as friction you
 * might be able to argue with.
 */
function useRemaining(targetMs: number, fromMs: number): number {
  const offset = Date.now() - fromMs;
  const read = () => Math.max(0, targetMs - (Date.now() - offset));
  const [remaining, setRemaining] = useState(read);

  useEffect(() => {
    // Aligned to the second boundary the digits actually change on, so the
    // display never sits a fraction of a second behind the truth.
    const id = setInterval(() => setRemaining(read()), 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const [origin] = useState(() => Date.now());
  const remaining = useRemaining(origin + seconds * 1000, origin);
  const total = Math.ceil(remaining / 1000);
  return (
    <Num className={className}>
      {pad(total / 60)}:{pad(total % 60)}
    </Num>
  );
}

/**
 * hh:mm:ss plus the bar. Both read from the same target timestamp, so the bar
 * cannot disagree with the digits about how long is left.
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
  const totalMs = holdSeconds * 1000;
  const [elapsedAtMount] = useState(() => 1 - Math.max(0, target - nowAt) / totalMs);

  return (
    <View>
      <Num className={cx('mt-4 text-56 font-mono-medium tracking-t45 leading-[0.9]')}>
        {pad(seconds / 3600)}:{pad((seconds % 3600) / 60)}:{pad(seconds % 60)}
      </Num>
      <ProgressBar
        className="mt-4.5 h-0.75 w-full overflow-hidden bg-raised"
        fillClassName="bg-signal"
        from={elapsedAtMount}
        to={1}
        durationMs={Math.max(0, target - nowAt)}
        aria-label="Cooling-off period elapsed"
        aria-valuenow={Math.round((1 - remaining / totalMs) * 100)}
      />
    </View>
  );
}
