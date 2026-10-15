import { useEffect, useState } from 'react';

/**
 * Asking the on-chain gate is a transaction Kanon's signer sends and waits
 * for: 3 to 9 seconds, and up to about 25 near the end of a 15-minute bucket,
 * when a fresh price is recorded on the chain first. A button that is asking
 * says so, and a wait past six seconds is explained once, in neutral type:
 * slow is not wrong.
 */

export const ASKING_THE_GATE = 'ASKING THE GATE';

export const GATE_SLOW_AFTER_MS = 6_000;

export const GATE_SLOW_NOTE = 'Recording a fresh on-chain price first; this can take up to 20 seconds.';

/** The note to show while `busy` has lasted past `GATE_SLOW_AFTER_MS`, and null before then or once it ends. */
export function useGateWait(busy: boolean): string | null {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), GATE_SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [busy]);
  return busy && slow ? GATE_SLOW_NOTE : null;
}
