import { useEffect, useRef, type RefObject } from 'react';
import type { View } from 'react-native';
import { isWeb } from '../platform';
import { createWheelPager, keyStep, type Step } from './reel-paging';

/** A field that takes typing, where an arrow key is the caret's and not the reel's. */
function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * Pages the Predict reel from a mouse wheel over `target` and from the arrow and
 * page keys anywhere on the screen. Web only; a device has touch.
 *
 * The wheel is taken over the target (its default scroll is cancelled) and turned
 * into one page per gesture (`createWheelPager`), because a wheel's own scroll fights
 * a snap-scrolling list: a notch moves a hundred pixels, snaps back, and the reel
 * never leaves the page. `enabled` is false while a sheet is open, so the keys and
 * the wheel belong to the sheet.
 */
export function useReelPaging(target: RefObject<View | null>, enabled: boolean, onStep: (step: Step) => void) {
  const stepRef = useRef(onStep);
  stepRef.current = onStep;

  useEffect(() => {
    if (!isWeb || !enabled) return undefined;
    const el = target.current as unknown as HTMLElement | null;
    if (!el) return undefined;
    const pager = createWheelPager();

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // a pinch-zoom is the browser's
      e.preventDefault();
      const step = pager({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, time: e.timeStamp });
      if (step !== 0) stepRef.current(step);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isEditable(e.target)) return;
      const step = keyStep(e.key);
      if (step === 0) return;
      e.preventDefault();
      stepRef.current(step);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, [target, enabled]);
}
