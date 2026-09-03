import type { Route } from 'next';

/**
 * Dynamic route builders.
 *
 * `typedRoutes` checks every static href at build time. Dynamic segments are
 * the one place it cannot, so the assertion lives here — once, in a file that
 * is easy to audit — rather than being scattered across the screens.
 */
export const tradeRoute = (id: string) => `/trades/${id}` as Route;
export const loosenRoute = (ruleId: string) => `/rules/${ruleId}/loosen` as Route;
export const shareRoute = (ruleId: string) => `/share/${ruleId}` as Route;
