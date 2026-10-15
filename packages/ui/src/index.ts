'use client';

/**
 * @kanon/ui — every screen in the product, once.
 *
 * These render on a phone through Expo and in a browser through Next.js and
 * react-native-web. Nothing in here imports a router or a platform API
 * directly: navigation arrives through `NavProvider` and device capabilities
 * through `PlatformProvider`, so a screen cannot quietly become web-only.
 */
export { NavProvider, Link, useNavigator, useRouteParam, type Navigator } from './nav';
export {
  PlatformProvider,
  usePlatform,
  useHaptics,
  isWeb,
  type PlatformCapabilities,
  type StorageCapability,
  type HapticsCapability,
  type HapticPattern,
} from './platform';
export { ThemeProvider, useTheme, type ThemeState, type ThemeColors } from './theme';
export { THEME_MODES, resolveScheme, contrastRatio } from './lib/theme-logic';
export { withAlpha, elevationStyle } from './lib/elevation';

export * from './lib/routes';
export * from './lib/demo';
export { cx } from './lib/cx';
export { createChartReads, type ChartSession, type ChartReadsDeps } from './lib/chart-reads';
export {
  KanonDataProvider,
  useKanonData,
  useKanonSelector,
  demoDataSource,
  seriesStateFromQuery,
  type SeriesState,
  type KanonDataSource,
  type RuleData,
  type HomeStats,
  type RefusalData,
  type CompilerData,
  type ReviewData,
  type PinningData,
  type ProposalData,
  type TradeDetailData,
  type BlockedLogData,
  type CoolingOffData,
  type ShareCardData,
  type PredictionCard,
  type AssetClass,
  type BlockedRow,
} from './lib/data';

export type * from './lib/flow-types';
export {
  useLiveKanonSource,
  type LiveBackend,
  type LiveActions,
  type CompileResult,
  type RunProposerResult,
} from './lib/live';
export { useConvexKanonSource, type ConvexHooks, type ConvexSession } from './lib/convex-source';
export type { LiveStrategy, LiveTrade, LiveModelled } from './lib/live-map';
export {
  PinError,
  MONAD_CHAIN_ID,
  pinAvailability,
  resolveRegistryAddress,
  resolveSeriesMap,
  buildPinTarget,
  type PinTarget,
  type SeriesMap,
  unavailablePinClient,
  type PinClient,
  type PinReceipt,
} from './lib/pin';
export { createViemPinClient, registryAbi, type Signer } from './lib/pin-viem';

export * from './components/chrome';
export { Icon, ICON_NAMES, ICON_STROKE, type IconProps } from './components/icons';
export { Card, type CardProps, type CardVariant } from './components/card';
export { SectionHeader, type SectionHeaderProps } from './components/section-header';
export { StatTile, StatRow, Delta, Label, type StatTileProps, type DeltaProps } from './components/stat';
export { ListRow, type ListRowProps } from './components/list-row';
export { SegmentedControl, type SegmentedControlProps, type SegmentOption } from './components/segmented-control';
export { Chip, FilterChip, type ChipProps, type FilterChipProps } from './components/chip';
export { Badge, type BadgeProps } from './components/badge';
export { Avatar, type AvatarProps } from './components/avatar';
export { IconButton, type IconButtonProps } from './components/icon-button';
export { EmptyState, type EmptyStateProps } from './components/empty-state';
export { Skeleton, SkeletonRow } from './components/skeleton';
export { Divider } from './components/divider';
export { ProgressRing, type ProgressRingProps } from './components/progress-ring';
export { Sparkline, type SparklineProps } from './components/sparkline';
export { directionOf, type Tone, type Direction } from './components/tone';
export * from './components/ui';
export * from './components/motion';
export { default as SpecularButton } from './components/button/cta';
export { AuthModal } from './components/modal/auth-modal';
export { CandlestickChart, type CandlestickChartProps } from './components/chart/candlestick';
export type { TradeMarker } from './components/chart/markers';
export * from './components/countdown';
export * from './components/evidence-chain';
export { OnboardingScreen } from './components/onboarding';

export { RefusalScreen } from './screens/refusal';
export { RuleCardScreen } from './screens/rule-card';
export { HomeScreen } from './screens/home';
export { CompilerScreen } from './screens/compiler';
export { SpecReviewScreen } from './screens/spec-review';
export { PinningScreen } from './screens/pinning';
export { ProposalScreen } from './screens/proposal';
export { TradeDetailScreen } from './screens/trade-detail';
export { BlockedLogScreen } from './screens/blocked-log';
export { PerplRiskScreen } from './screens/perpl-risk';
export { SpotScreen } from './screens/spot';
export { CoolingOffScreen } from './screens/cooling-off';
export { StrategyCardScreen } from './screens/strategy-card';
export { OnboardingPasskeyScreen } from './screens/onboarding-passkey';
export { OnboardingFundScreen } from './screens/onboarding-fund';
export { OnboardingStrategyScreen } from './screens/onboarding-strategy';
export { ScreenIndexScreen } from './screens/screen-index';
export { CreateScreen } from './screens/create';
export { ChartScreen } from './screens/chart';
export { PredictScreen } from './screens/predict';
export { AnalyticsScreen } from './screens/analytics';
export { createAnalyticsReads, type AnalyticsReadsDeps, type AnalyticsSession } from './lib/analytics-reads';

// Predict: real markets, and the seam to the ThresholdMarket contract.
export { createPredictReads, feedFromReads, type PredictReadsDeps, type PredictSession } from './lib/predict-reads';
export { STAKE_PRESETS } from './lib/predict-types';
export type {
  PredictFeed,
  PredictFeedState,
  PredictMarket,
  PredictPosition,
  PredictSettlement,
  PredictTerms,
  TakeSideFailure,
  TakeSideOutcome,
} from './lib/predict-types';
export {
  MarketError,
  resolveMarketAddress,
  unavailableMarketClient,
  type MarketAvailability,
  type MarketClient,
} from './lib/market-client';
export { createViemMarketClient, thresholdMarketAbi } from './lib/market-viem';
export { VaultScreen } from './screens/vault';
export { CopyScreen } from './screens/copy';
export { ProfileScreen } from './screens/profile';
// Profile tab: its sub-screens, the signed-in account (wallet, sign-out) and device preferences.
export { ProfileRecordsScreen } from './screens/profile-records';
export { ProfileRulesScreen } from './screens/profile-rules';
export { ProfileSecurityScreen } from './screens/profile-security';
export { ProfileSettingsScreen } from './screens/profile-settings';
export * from './lib/account';
export { usePreference, updatePreferences, preferredTimeframe, type Preferences } from './lib/preferences';
export { BottomSheet } from './components/bottom-sheet';
export { useVaultDataSource, type VaultSource, type VaultLiveDeps, type VaultBackendActions, type LiveVaultRow, type LiveFollowRow, type VaultChangeWire } from './lib/vault-live';
export { createVaultClient, createViemChainIO, type VaultClient, type ChainIO } from './lib/vault-client';
export { resolveVaultConfig, envFromDeployment, type VaultConfig, type VaultConfigResult, type VaultEnv } from './lib/vault-config';
export type { LiveLeadRow } from './lib/vault-map';

// Data layer: per-domain hooks (the pattern new screens follow), the selector store behind them, and the chain.
export * from './lib/domains';
export type * from './lib/domain-types';
export { createDomainReads, type DomainReadsDeps, type DomainSession } from './lib/domain-reads';
export { createVaultReads, type VaultReadsDeps } from './lib/vault-reads';
export { createStore, shallowEqual, shareStructure, useStoreSelector, type Store } from './lib/store';
export { monad, monadTestnet, resolveChain, configureChain, activeChain } from './lib/monad-chain';
export { assertPublicEnv, validatePublicEnv, describePublicEnvProblems } from './lib/public-env';
// Market data: the gateway's client. An app with a gateway address hands it to `useConvexKanonSource`.
export { createMarketFeed, resolveMarketFeed, type MarketFeed, type MarketFeedOptions } from './lib/market-feed';
export { recordWithWalletLink } from './lib/wallet-link';
// The order ticket: the shared trading account on the venue, an order on it, and the caller's own orders.
// The account and the orders go through the gateway's `/trade` routes; an app with a gateway address
// hands `resolveVenueTrade(...)` to `useConvexKanonSource`.
export { createVenueTradeReads, type VenueTradeReadsDeps, type VenueTradeSession, type VenueTradeActions } from './lib/venue-trade-reads';
export { createVenueTradeActions, resolveVenueTrade, type VenueTradeClientOptions } from './lib/venue-trade-client';
// Profile's on-chain record: the Kanon indexer on Envio HyperIndex. An app with an indexer address
// hands `resolveIndexer(...)` to `useConvexKanonSource`.
export {
  createIndexerPost,
  resolveIndexer,
  type IndexerClientOptions,
  type IndexerPost,
  type OnchainRecordState,
} from './lib/onchain-record-reads';
export type { IndexerRequest, OnchainKind, OnchainRow } from './lib/onchain-record';
// The spot market Kanon listed on Kuru testnet: the book comes through the gateway (the same
// `resolveVenueTrade(...)` calls object), and orders go out from the person's own wallet. An app
// builds `createViemSpotClient(...)` over its signer and hands it to `useConvexKanonSource`.
export { SpotError, unavailableSpotClient, type SpotClient } from './lib/spot-client';
export { createViemSpotClient, kuruOrderBookAbi, spotTokenAbi, type ViemSpotClientOptions } from './lib/spot-viem';
export type { SpotMarketState } from './lib/spot-reads';
export type { SpotMarket, SpotOrder, SpotOrderReceipt, SpotFill, SpotWallet, SpotSide } from './lib/spot';
export type * from './lib/venue-types';
