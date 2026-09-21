import { useSyncExternalStore } from 'react';
import { useWindowDimensions } from 'react-native';
import { layoutForWidth, type Layout } from '../../lib/layout';

const subscribe = () => () => undefined;
const onClient = () => true;
const onServer = () => false;

/**
 * `'phone' | 'tablet' | 'desktop'` for the current window (640 and 1024, the
 * Tailwind `sm` and `lg` breakpoints), following resizes and rotation.
 *
 * SSR-safe: the server and the first client render both say `'phone'`, and the
 * real value arrives right after hydration, so the markup always matches and
 * React never warns. That means a component that branches on this hook shows
 * its phone form for one frame on a wide screen. Use it only for what a class
 * cannot express (mounting a component, choosing a data window, JS geometry);
 * for layout, write `lg:` / `sm:` classes, which are right on the server and
 * never flash.
 */
export function useLayout(): Layout {
  const { width } = useWindowDimensions();
  const hydrated = useSyncExternalStore(subscribe, onClient, onServer);
  return hydrated ? layoutForWidth(width) : 'phone';
}
