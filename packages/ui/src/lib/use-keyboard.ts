import { useEffect, useState } from 'react';
import { AccessibilityInfo, Keyboard } from 'react-native';
import { isIOS, isWeb } from '../platform';

/**
 * Whether the software keyboard is up. On the web there is nothing to report:
 * the browser resizes the viewport and the layout follows it. On a phone the
 * chat hides the tab bar while it is up, so the composer sits on the keyboard
 * and the thread keeps its height.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (isWeb) return;
    const show = Keyboard.addListener(isIOS ? 'keyboardWillShow' : 'keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener(isIOS ? 'keyboardWillHide' : 'keyboardDidHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

/** The OS asked for less motion. Animations that only decorate must stand still. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (live) setReduced(on);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduced;
}
