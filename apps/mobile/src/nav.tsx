import type { ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { NavProvider, type Navigator } from '@kanon/ui';

/**
 * expo-router, behind the interface the screens use.
 *
 * The cast is the one unavoidable seam: expo-router types hrefs against its own
 * generated route union, and `@kanon/ui` deliberately does not import it —
 * screens that knew about a router would stop being portable. Every href the
 * screens use comes from `routes` in `@kanon/ui`, and the route files below
 * mirror it one-for-one, so a typo shows up as a missing screen immediately.
 */
export function ExpoNavProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const navigator: Navigator = {
    push: (href) => router.push(href as never),
    replace: (href) => router.replace(href as never),
    back: () => router.back(),
  };
  return <NavProvider navigator={navigator}>{children}</NavProvider>;
}
