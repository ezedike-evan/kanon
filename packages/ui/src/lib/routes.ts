/**
 * Every route in the product, as plain strings.
 *
 * Both routers consume this: expo-router mounts the file tree that matches it,
 * and Next.js asserts each href against its generated `Route` union. Keeping
 * the paths here — not in either app — is what stops the two route trees
 * drifting apart, which is the failure this monorepo exists to prevent.
 */

import { RULE, TRADE_ID } from './demo';

export const routes = {
  home: '/home',
  refused: '/refused',
  blocked: '/blocked',
  compile: '/compile',
  compileReview: '/compile/review',
  compilePin: '/compile/pin',
  proposal: '/trades/proposal',
  onboarding: '/onboarding',
  onboardingFund: '/onboarding/fund',
  onboardingStrategy: '/onboarding/strategy',
  screenIndex: '/screens',
} as const;

export const tradeRoute = (id: string) => `/trades/${id}`;
export const loosenRoute = (ruleId: string) => `/rules/${ruleId}/loosen`;
export const shareRoute = (ruleId: string) => `/share/${ruleId}`;

/** The design canvas, in order — the consistency check `docs/DESIGN.md` asks for. */
export const SCREEN_INDEX: ReadonlyArray<{ label: string; href: string }> = [
  { label: '00 · REFUSAL', href: routes.refused },
  { label: '01 · RULE CARD (HOME)', href: routes.home },
  { label: '02 · CHAT-TO-SPEC COMPILER', href: routes.compile },
  { label: '03 · SPEC REVIEW', href: routes.compileReview },
  { label: '04 · PINNING CEREMONY', href: routes.compilePin },
  { label: '05 · TRADE PROPOSAL · UNDO WINDOW', href: routes.proposal },
  { label: '06 · TRADE DETAIL · EVIDENCE', href: tradeRoute(TRADE_ID) },
  { label: '07 · BLOCKED TRADES LOG', href: routes.blocked },
  { label: '08 · COOLING-OFF', href: loosenRoute(RULE.id) },
  { label: '09 · SHAREABLE STRATEGY CARD', href: shareRoute(RULE.id) },
  { label: '10A · ONBOARDING · PASSKEY', href: routes.onboarding },
  { label: '10B · ONBOARDING · FUND', href: routes.onboardingFund },
  { label: '10C · ONBOARDING · FIRST STRATEGY', href: routes.onboardingStrategy },
];
