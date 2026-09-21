'use client';

import { useMemo, type ReactNode } from 'react';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { NavProvider, type Navigator } from '@kanon/ui';

/**
 * next/navigation, behind the interface the screens use.
 *
 * `typedRoutes` checks every static href at build time, but the screens live in
 * `@kanon/ui` and take plain strings — a package that imported Next's `Route`
 * type could not also run on a phone. The assertion lives here, once, in a file
 * that is easy to audit, rather than scattered across thirteen screens; the
 * route table in `@kanon/ui` is what keeps the two trees honest.
 */
export function NextNavProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  // Memoised: a new object here would re-render every screen that reads the navigator.
  const navigator = useMemo<Navigator>(
    () => ({
      push: (href) => router.push(href as Route),
      replace: (href) => router.replace(href as Route),
      back: () => router.back(),
    }),
    [router],
  );
  return <NavProvider navigator={navigator}>{children}</NavProvider>;
}
