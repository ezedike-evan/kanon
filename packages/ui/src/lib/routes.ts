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
  create: '/create',
  predict: '/predict',
  chart: '/chart',
  refused: '/refused',
  blocked: '/blocked',
  analytics: '/analytics',
  risk: '/risk',
  compile: '/compile',
  compileReview: '/compile/review',
  compilePin: '/compile/pin',
  proposal: '/trades/proposal',
  onboarding: '/onboarding',
  onboardingFund: '/onboarding/fund',
  onboardingStrategy: '/onboarding/strategy',
  screenIndex: '/screens',
  vault: '/vault',
  copy: '/copy',
  profile: '/profile',
  profileRecords: '/profile/records',
  profileRules: '/profile/rules',
  profileSecurity: '/profile/security',
  profileSettings: '/profile/settings',
  /** The signed-out front door. Where sign-out lands. */
  landing: '/',
} as const;

export const tradeRoute = (id: string) => `/trades/${id}`;
/** The Trading records screen opened on one record's details. `id` is the record's own: `chart:…`, `timed:…`. */
export const recordRoute = (id: string) => `${routes.profileRecords}?open=${encodeURIComponent(id)}`;
/**
 * One timed trade, opened in the Trading records: its figures and both of its
 * transactions, running or finished. It is where a proposal autopilot opened
 * leads, since the timed trade is where the real fill is.
 */
export const timedTradeRoute = (timedTradeId: string) => recordRoute(`timed:${timedTradeId}`);
export const loosenRoute = (ruleId: string) => `/rules/${ruleId}/loosen`;
export const shareRoute = (ruleId: string) => `/share/${ruleId}`;

/**
 * The chart, opened on one pair: `/chart?asset=BTC%2FUSD`. The chart reads it back
 * with `parseChartAsset`; a chart that does not read it just opens on the rule's
 * own pair, which is why the asset rides in the query and not in a route segment.
 */
export const chartRoute = (asset: string) => `${routes.chart}?asset=${encodeURIComponent(asset)}`;

/**
 * The AI tab with a prompt already in its box: `/create?prompt=…`. Only the box is
 * filled. Nothing is sent, so the person reads it, edits it and sends it, or does not.
 */
export const createRoute = (prompt: string) => `${routes.create}?prompt=${encodeURIComponent(prompt)}`;

/** The asset in a chart query string (`asset=BTC%2FUSD`), normalised as the series is, or null. */
export function parseChartAsset(search: string): string | null {
  const raw = new URLSearchParams(search.replace(/^\?/, '')).get('asset');
  const asset = raw?.replace(/\s+/g, '').toUpperCase();
  return asset ? asset : null;
}

/** The design canvas, in order — the consistency check `docs/DESIGN.md` asks for. */
export const SCREEN_INDEX: ReadonlyArray<{ label: string; href: string }> = [
  { label: '00 · REFUSAL', href: routes.refused },
  { label: '01 · HOME (RULE CARD)', href: routes.home },
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
  { label: '11 · PREDICT', href: routes.predict },
  { label: '12 · ANALYTICS · ADHERENCE, RISK, FLOW', href: routes.analytics },
  { label: '16 · PERPL RISK · LIQUIDATION, FUNDING, BOOKS', href: routes.risk },
  { label: '13 · GUARDED AGENT VAULT', href: routes.vault },
  { label: '14 · COPY TRADING', href: routes.copy },
  { label: '15 · PROFILE', href: routes.profile },
  { label: '15A · PROFILE · TRADING RECORDS', href: routes.profileRecords },
  { label: '15B · PROFILE · PREVIOUS RULES', href: routes.profileRules },
  { label: '15C · PROFILE · SECURITY', href: routes.profileSecurity },
  { label: '15D · PROFILE · SETTINGS', href: routes.profileSettings },
];
