'use client';

/**
 * @kanon/ui — every screen in the product, once.
 *
 * These render on a phone through Expo and in a browser through Next.js and
 * react-native-web. Nothing in here imports a router or a platform API
 * directly: navigation arrives through `NavProvider` and device capabilities
 * through `PlatformProvider`, so a screen cannot quietly become web-only.
 */
export { NavProvider, Link, useNavigator, type Navigator } from './nav';
export {
  PlatformProvider,
  usePlatform,
  type PlatformCapabilities,
} from './platform';

export * from './lib/routes';
export * from './lib/demo';
export { cx } from './lib/cx';

export * from './components/chrome';
export * from './components/ui';
export * from './components/motion';
export * from './components/countdown';
export * from './components/evidence-chain';
export { OnboardingScreen } from './components/onboarding';

export { RefusalScreen } from './screens/refusal';
export { RuleCardScreen } from './screens/rule-card';
export { CompilerScreen } from './screens/compiler';
export { SpecReviewScreen } from './screens/spec-review';
export { PinningScreen } from './screens/pinning';
export { ProposalScreen } from './screens/proposal';
export { TradeDetailScreen } from './screens/trade-detail';
export { BlockedLogScreen } from './screens/blocked-log';
export { CoolingOffScreen } from './screens/cooling-off';
export { StrategyCardScreen } from './screens/strategy-card';
export { OnboardingPasskeyScreen } from './screens/onboarding-passkey';
export { OnboardingFundScreen } from './screens/onboarding-fund';
export { OnboardingStrategyScreen } from './screens/onboarding-strategy';
export { ScreenIndexScreen } from './screens/screen-index';
