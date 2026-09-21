'use client';

import type { ReactNode } from 'react';
import { ThemeProvider } from '@kanon/ui';

/**
 * Mounts the theme at the very top of the tree, above the data providers, so
 * the data bridge stays untouched and a light-mode user is themed before any
 * of it resolves. `layout.tsx` is a server component, hence this thin client
 * wrapper.
 */
export function ThemeRoot({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}
