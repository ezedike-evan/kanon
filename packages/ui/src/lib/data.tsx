import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Decimal, Series, StrategySpec } from '@kanon/spec';
import {
  BLOCKED,
  COMPILER,
  COOLING_OFF,
  HOME,
  ONBOARDING,
  PENDING_SPEC,
  PINNING,
  PROPOSAL,
  REFUSAL,
  REVIEW,
  RULE,
  SHARE_CARD,
  SPEC,
  TRADE,
  TRADE_ID,
} from './demo';
import { onchainGateNote, parseDecimal, type AssetClass as SpecAssetClass } from '@kanon/spec';
import type { TradeMarker } from '../components/chart/markers';
import type { EditableParam } from '@kanon/spec';
import type {
  AmendOutcome,
  AmendmentPreview,
  AutopilotOutcome,
  CompilerStatus,
  DataMode,
  EditOutcome,
  PinningAvailability,
  PinOutcome,
  ProposalRun,
  ReviewMode,
  TradeActionOutcome,
} from './flow-types';
import { buildFixtureMarkers, buildFixtureSeries } from './chart-fixtures';
import { DEMO_MARKET_AVAILABILITY } from './market-client';
import { demoMarkets } from './predict-map';
import type { PredictFeed } from './predict-types';
import { createStore, useStoreSelector, type Store } from './store';
import { DEMO_ACTIVITY, DEMO_FOLLOWS, DEMO_MARKETS, demoTicker } from './domain-demo';
import { DEMO_COPY_LEADS, demoSparkline } from './home-demo';
import { DEMO_RULES } from './profile-demo';
import type { CopyLeadsState, SparklineState } from './home-types';
import type {
  ActivityState,
  KanonSession,
  MarketsState,
  ProfileFollow,
  ProfileSettings,
  RuleHistoryItem,
  TickerState,
} from './domain-types';
import type { AnalyticsState, NansenState } from '@kanon/spec';
import { DEMO_ANALYTICS } from './analytics-demo';
import { AUTOPILOT_DEMO, type AutopilotNote } from './autopilot';

const DEMO_ANALYTICS_STATE: AnalyticsState = { status: 'demo', report: DEMO_ANALYTICS };
const NANSEN_NOT_CONNECTED: NansenState = { status: 'not_connected' };
export type * from './flow-types';
import type { VaultSource } from './vault-types';
import { DEMO_COPY, DEMO_VAULTS, demoOutcome } from './vault-demo';
export type * from './vault-types';
export type * from './domain-types';
import { SIGN_IN_TO_TRADE } from './venue-trade';
import { SAMPLE_TIMED_STATE } from './timed-sample';
import type {
  VenueAccountRead,
  VenueOrderRequest,
  VenueOrderResult,
  VenueOrdersState,
} from './venue-types';
export type * from './venue-types';
import type {
  TimedCloseResult,
  TimedOpenResult,
  TimedRequest,
  TimedStateRead,
  TimedTradesState,
} from './timed-types';
import { RISK_NOT_CONNECTED, type PerplRiskState } from './perpl-risk-reads';
import type { OnchainRecordState } from './onchain-record-reads';
import { SPOT_NOT_CONNECTED, type SpotMarketState } from './spot-reads';
import { unavailableSpotClient, type SpotClient } from './spot-client';
import { activeChain } from './monad-chain';
export type * from './timed-types';

/**
 * The data a screen needs, factored by domain rather than by screen — several
 * screens share `rule`, and `tradeDetail` is looked up by id rather than
 * fixed.
 *
 * This is `platform.tsx`'s pattern applied to data instead of device
 * capability: a context, a default instance that never breaks a screen, and a
 * real instance the app root supplies. `packages/ui` still has no dependency
 * on Convex or any transport — it only knows this shape.
 */

export type TranscriptTurn = { from: string; at: string; text: string };
export type SpecLine = { text: string; changed: boolean };
export type ReviewSegment = string | { param: string; key?: string };
export type InferredDefault = { name: string; value: string; key?: string };
export type EvidenceField = [string, string];
export type Claim = {
  symbol: string;
  summary: string;
  fields: EvidenceField[];
  /** The label on the claim's right edge. Defaults to `SIGNED` (demo attestations). */
  badge?: string;
  tone?: 'long' | 'ash';
};
export type BlockedRow = {
  symbol: string;
  at: string;
  detail: string;
  tradeId?: string;
  /** Autopilot judged it at a candle close; nobody pressed anything. */
  autopilot?: boolean;
};

export interface RuleData {
  ordinal: string;
  id: string;
  name: string;
  asset: string;
  timeframe: string;
  pinnedOn: string;
  specHash: string;
  txAbbrev: string;
  contract: string;
  predicates: string[];
  /** The candle width the spec is pinned against, in seconds. */
  bucketSeconds: number;
  /** The asset as the series knows it, e.g. `BTC/USD`. */
  symbol: string;
  /** Autopilot is on: the rule is judged on every closed candle with nobody pressing anything. */
  autopilot: boolean;
}

export interface HomeStats {
  taken: number;
  blocked: number;
  adherenceBps: number;
  pnl30d: Decimal;
  price: Decimal;
  changeBps: number;
  sparkline: number[];
  sparklineHead: number;
  /** Setups put to the rule so far. Zero means adherence has nothing to divide. */
  attempts: number;
}

export interface RefusalData {
  predicate: string;
  reason: string;
  requiredHigh: Decimal;
  currentPrice: Decimal;
  shortfall: Decimal;
  shortfallBps: number;
  at: string;
  block: string;
  /** What did the refusing: on-chain in the demo, the pinned spec in live use. */
  label: string;
  /** The unit the predicate was decided in. A fair value gap is decided in bps. */
  unit: 'price' | 'bps';
  requiredLabel: string;
  requiredSub: string;
  actualLabel: string;
  actualSub: string;
  tradeId: string;
  /** Present when autopilot judged the setup at a candle close, with nobody pressing anything. */
  autopilot?: AutopilotNote;
}

export interface CompilerData {
  draft: string;
  transcript: TranscriptTurn[];
  lines: SpecLine[];
  status: CompilerStatus;
  error?: string;
  /** A compiled spec exists to review. */
  hasSpec: boolean;
}

export interface ReviewData {
  plain: ReviewSegment[][];
  parametric: string[];
  inferred: InferredDefault[];
  mode: ReviewMode;
  /** Every bound parameter with the bounds it can be edited within. */
  params: EditableParam[];
  /** The user has confirmed they read the spec, defaults included. Required to pin. */
  acknowledged: boolean;
  /** In `amend` mode: what submitting would do. */
  preview: AmendmentPreview | null;
  /**
   * The exits the user has not stated, each opening its parameter in the sheet.
   * While any is listed a draft is not pinned and a change is not sent.
   */
  missingExits: MissingExit[];
  /** Why, in one sentence. Empty when nothing is missing. */
  exitsSentence: string;
  /** What the on-chain gate cannot see in this rule, said plainly. Null when there is nothing to say. */
  gateNote: string | null;
  busy: boolean;
  error?: string;
}

/** A stop or a target the user has not set: absent, or chosen by the compiler. */
export interface MissingExit {
  /** `stop_distance` or `target_distance`, as the parametric view names it. */
  name: string;
  /** The parameter key the sheet edits. */
  key: string;
  /** `not stated`, or the value the compiler chose. */
  display: string;
  /** True when the spec has no value at all, false when it holds one the user did not state. */
  absent: boolean;
}

export interface PinningData {
  step: string;
  bond: Decimal;
  bondUnit: string;
  agreements: string[];
  /** The spec hash about to be written, abbreviated to fit a line. */
  specHash: string;
  /** The registry address, abbreviated, or `NOT DEPLOYED`. */
  contract: string;
  /** The commitment to the predicates the gate will check, abbreviated. Empty in demo. */
  commitment?: string;
  /** The canonical series the gate reads, abbreviated, or `NOT DEPLOYED`. Empty in demo. */
  series?: string;
  availability: PinningAvailability;
  /** A pin is being signed or broadcast. */
  busy: boolean;
}

export interface ProposalData {
  entry: Decimal;
  stop: Decimal;
  /** The spec pins no target, so a live proposal has none. */
  target: Decimal | null;
  size: Decimal;
  riskBps: number;
  undoSeconds: number;
  /** Milliseconds the undo window closes. The countdown is read off this. */
  undoExpiresAt?: number;
  checks: { label: string; evidence: string }[];
  tradeId: string;
  /** True when an executed trade was a paper fill, not a venue fill. Shown, never hidden. */
  paper?: boolean;
  /** `proposed` while the undo window runs; `executed` or `undone` once it has. */
  status: 'proposed' | 'executed' | 'undone';
  direction: 'long' | 'short';
  /** The size unit, e.g. `BTC`. */
  sizeUnit: string;
  /** Where the account equity behind the size came from, stated rather than assumed. */
  sizing: string;
  /**
   * Present on a proposal autopilot wrote. It has no undo window and nothing to
   * confirm: the gateway opens a timed trade for it, or says why it did not.
   * `entry`, `stop` and `size` stay the rule's own sizing, not what was sent.
   */
  autopilot?: AutopilotNote;
}

export interface TradeDetailData {
  id: string;
  side: string;
  /** Null until a trade has closed: there is no result to report yet. */
  result: Decimal | null;
  entry: Decimal;
  exit: Decimal | null;
  returnBps: number | null;
  claims: Claim[];
  /** Present when autopilot judged the setup: where it stands, what was sent, and the way to its timed trade. */
  autopilot?: AutopilotNote;
}

export interface BlockedLogData {
  period: string;
  refused: number;
  wouldHaveLost: Decimal;
  note: string;
  rows: BlockedRow[];
  /** The report is still being worked out from later price data. */
  loading?: boolean;
}

export interface CoolingOffData {
  requestedAt: number;
  nowAt: number;
  requestedLabel: string;
  currentSpec: StrategySpec;
  pendingSpec: StrategySpec;
  /** The hold in seconds. Defaults to the spec package's `COOLING_OFF_SECONDS`. */
  holdSeconds?: number;
  /** Milliseconds the hold ends. Once it has passed the change can be applied. */
  endsAt?: number;
}

export interface ShareCardData {
  window: string;
  summary: string[];
  adherenceBps: number;
  /** Null until closed trades exist to be verified. */
  verifiedPnlBps: number | null;
  taken: number;
  blocked: number;
  overrides: number;
  url: string;
  disclaimer: string;
  /** The full spec hash: what a reader checks the card against. */
  specHash: string;
}

export interface OnboardingFundOption {
  title: string;
  sub: string;
  muted: boolean;
}

export interface OnboardingFundData {
  options: OnboardingFundOption[];
}

export interface OnboardingStrategyData {
  starters: string[];
}

/** Display form of the spec's asset class, e.g. `crypto` -> `CRYPTO`. */
export type AssetClass = Uppercase<SpecAssetClass>;

export interface PredictionCard {
  id: string;
  asset: string;
  assetClass: AssetClass;
  timeframe: string;
  expires: string;
  price: Decimal;
  target: Decimal;
  direction: 'above' | 'below';
  evidenceHash: string;
}

/**
 * What a chart has to draw, in the four states it can be in.
 *
 * `demo` is the logged-out / no-provider fallback and is the only state that
 * carries fixture data. A live source never returns it: it goes `loading`,
 * then `ready` or `empty`, so a real asset with no samples yet is shown as
 * empty rather than dressed up with a made-up chart.
 */
export type SeriesState =
  | { status: 'loading' }
  | { status: 'empty' }
  | {
      status: 'ready';
      series: Series;
      /** The read hit its ceiling, so the oldest candle may be a partial view. */
      truncated: boolean;
    }
  | { status: 'demo'; series: Series };

/**
 * Maps a `series.getSeries` query result to a `SeriesState`. `undefined` is
 * what a Convex `useQuery` returns while it is still loading.
 */
export function seriesStateFromQuery(
  result: (Series & { truncated?: boolean }) | undefined | null,
): SeriesState {
  if (result === undefined || result === null) return { status: 'loading' };
  if (result.candles.length === 0) return { status: 'empty' };
  return { status: 'ready', series: result, truncated: result.truncated === true };
}

/**
 * Every read (and the handful of writes) a screen needs. A default,
 * demo-backed instance satisfies this with zero backend, and is what
 * `/screens` and every client render with until a real provider is mounted.
 */
export interface KanonDataSource {
  /** `demo` renders fixtures; `live` renders the signed-in user's own rows. */
  mode: DataMode;
  /** A rule is pinned and enforcing. Always true in demo. */
  hasPinned: boolean;
  /** A compiled draft exists, awaiting review. */
  hasDraft: boolean;
  rule: RuleData;
  home: HomeStats;
  /** The trade a "view evidence" link opens when no other trade is in view. */
  latestTradeId: string;
  /** The refusal in view. Null in live use until a setup has been refused. */
  refusal: RefusalData | null;
  compiler: CompilerData;
  /** Sends one chat turn to the compiler and persists the draft it returns. */
  sendCompilerMessage(text: string): Promise<void>;
  review: ReviewData;
  /** Overrules one bound parameter. The edit is stated, so it leaves the inferred list. */
  editParam(key: string, value: string | number): EditOutcome;
  /** Records that the user has read the spec. Pinning is refused without it. */
  acknowledgeReview(read: boolean): void;
  /** In `amend` mode: sends the staged change. A tightening applies now, a loosening waits. */
  submitAmendment(): Promise<AmendOutcome>;
  pinning: PinningData;
  /** Signs and pins the reviewed spec on-chain. Never reports a pin it did not make. */
  pinStrategy(): Promise<PinOutcome>;
  /** The proposal in view. Null in live use until a setup has been proposed. */
  proposal: ProposalData | null;
  /** Puts the current market to the pinned rule: a proposal, or a refusal. */
  requestProposal(): Promise<ProposalRun>;
  /** Confirms a pending trade proposal before the undo window closes. */
  confirmProposal(): Promise<TradeActionOutcome>;
  /** Cancels a pending trade proposal within the undo window. */
  undoProposal(): Promise<TradeActionOutcome>;
  /**
   * Turns autopilot on or off for one of the person's own rules, by its id. On,
   * the rule is judged on every closed candle with nobody pressing anything.
   * Resolves with what the server says the switch is now, or a sentence saying
   * why it was not thrown; it never rejects. Signed out nothing is sent.
   */
  setAutopilot(strategyId: string, on: boolean): Promise<AutopilotOutcome>;
  /** Looks up a trade's evidence chain by id. Demo falls back to the demo trade; live returns null for an unknown id. */
  tradeDetail(id: string): TradeDetailData | null;
  /** A change waiting out its hold. Null when nothing is cooling off. */
  coolingOff: CoolingOffData | null;
  /** Applies a loosening whose hold has fully run. */
  finalizeCoolingOff(): Promise<AmendOutcome>;
  /** Drops a pending loosening. The current rule never stopped being enforced. */
  withdrawCoolingOff(): Promise<AmendOutcome>;
  shareCard: ShareCardData;
  predictions: PredictionCard[];
  /** Takes a side on a threshold market. */
  takeSide(id: string, direction: 'above' | 'below'): Promise<void>;
  /**
   * The Predict feed: real markets built from the canonical series, with their
   * settled results and the person's own stakes. Hook, for the same reason as
   * `useSeries`. Signed out it is the demo cards, and nothing can be staked.
   */
  usePredict(): PredictFeed;
  onboardingFund: OnboardingFundData;
  onboardingStrategy: OnboardingStrategyData;
  /**
   * Guarded vaults and non-custodial copy trading, with every write they need.
   * A hook: it reads the chain and Convex only while a screen that shows them is
   * mounted, so nothing is fetched at the app root. Signed out it is the demo.
   */
  useVaults(): VaultSource;
  /**
   * Refusals, and what each would have cost, modelled from prices that printed
   * after it. A hook: the modelled outcomes are worked out (a server action)
   * only while the blocked log is mounted. Signed out it is the demo log.
   */
  useBlockedLog(): BlockedLogData;
  /** Who is looking. `demo` renders fixtures; `live` renders the signed-in user's own rows. */
  session: KanonSession;
  /** The signed-in user's own row, or null. Never someone else's. */
  settings: ProfileSettings | null;
  /** Every rule the user has had, newest first, with the one enforcing marked. */
  ruleHistory: RuleHistoryItem[];
  /**
   * Tradeable pairs with the newest price and 24-hour move. A hook that
   * subscribes while the caller is mounted; see `lib/domains.ts` for the
   * pattern and prefer `useMarkets()` from there.
   */
  useMarkets(): MarketsState;
  /** One pair, subscribed alone: another pair's tick does not re-render the caller. */
  useTicker(asset: string): TickerState;
  /** The user's newest trades across their rules, refused included. */
  useActivity(limit?: number): ActivityState;
  /** Copy relationships the user holds. `undefined` while loading. */
  useFollows(): ProfileFollow[] | undefined;
  /** A pair's last day as a line, subscribed to that pair alone. See `lib/home-reads.ts`. */
  useSparkline(asset: string): SparklineState;
  /** Strategies listed for copying, as Home's carousel shows them: counts only. */
  useCopyLeads(): CopyLeadsState;
  /**
   * Candles for `asset` at `bucketSeconds`, from the canonical series. A hook,
   * not a plain method: a live source implements it with a reactive query, so
   * it must be called at the top level of a component.
   */
  useSeries(asset: string, bucketSeconds: number): SeriesState;
  /**
   * Executed and refused trades on `asset`, each already bucketed to the start
   * of its candle at `bucketSeconds`. Hook, for the same reason as `useSeries`.
   */
  useChartMarkers(asset: string, bucketSeconds: number): TradeMarker[];
  /**
   * Adherence, refusals, margin risk and drawdown for the active strategy.
   * Hook, for the same reason as `useSeries`. Signed out it is the demo report.
   */
  useAnalytics(): AnalyticsState;
  /**
   * Nansen smart-money net flow for `asset`. Never a made-up figure: with no
   * Nansen key, in demo, or on any failure it says so instead.
   */
  useNansenFlow(asset: string): NansenState;
  /**
   * The account orders go to: one Perpl account, shared by everyone signed in,
   * on testnet. A hook: the account is read (a server action) only while a
   * ticket is mounted, then again after an order, on `refresh()` and on a slow
   * interval. Signed out it is `unavailable`. There is no demo account.
   */
  useVenueAccount(): VenueAccountRead;
  /**
   * Opens a position at market on that account, or adds to the one it holds on
   * the same side, and reads the account again. Resolves with the answer, a
   * refusal included; it never rejects.
   */
  placeVenueOrder(request: VenueOrderRequest): Promise<VenueOrderResult>;
  /** Closes the whole of the account's position on `asset`, at market. Never rejects. */
  closeVenuePosition(asset: string): Promise<VenueOrderResult>;
  /**
   * The signed-in user's own orders, newest first. Hook, for the same reason as
   * `useSeries`. Signed out it is `empty`: no fill is ever a fixture.
   */
  useVenueOrders(): VenueOrdersState;
  /**
   * Predict: what can be traded on a timer (the pairs, stakes, durations and
   * leverage the server offers) and whether each market is free. A hook: it is
   * read (a call to the gateway) only while the Predict screen is mounted, then
   * again after an open or a close, on `refresh()` and on a slow interval.
   * Signed out it is the labelled sample (`timed-sample.ts`), and nothing is read.
   */
  useTimedState(): TimedStateRead;
  /**
   * Opens a timed trade on the shared account: a long for up, a short for down,
   * at market, which the server closes when the time is up. No wallet prompt.
   * Resolves with the answer, a refusal included; it never rejects.
   */
  openTimedTrade(request: TimedRequest): Promise<TimedOpenResult>;
  /** Ends the caller's own running trade before its time. The result arrives on the trade's row. Never rejects. */
  closeTimedTrade(tradeId: string): Promise<TimedCloseResult>;
  /**
   * The signed-in user's own timed trades, running and finished, newest first.
   * Hook, for the same reason as `useSeries`. Signed out it is `empty`: no
   * trade is ever a fixture.
   */
  useTimedTrades(): TimedTradesState;

  /**
   * Perpl's markets with their margin terms, funding and newest state, for the
   * risk screen. Public market data through the gateway: read (two requests on
   * a timer) only while a caller is mounted, and the same signed in or out.
   */
  usePerplRisk(): PerplRiskState;

  /**
   * What the chain holds for `address`'s rules: each pin, tightening and
   * loosening, and each refusal with its predicate and number, newest first,
   * every row with its transaction. Read from the Kanon indexer on Envio (two
   * requests on a timer) only while a caller is mounted. Never a fixture:
   * signed out it asks for sign-in, and with no indexer address it says the
   * record is not connected.
   */
  useOnchainRecord(address: string | null): OnchainRecordState;

  /**
   * The spot market Kanon listed on Kuru's testnet order book: its terms and
   * its book. Public market data through the gateway: read (one request on a
   * timer) only while a caller is mounted, and the same signed in or out.
   * Never a fixture: with no gateway address it says it is not connected.
   */
  useSpotMarket(): SpotMarketState;
  /**
   * The seam to the person's own wallet for that market: its balances, the
   * test tokens' open mint, and a market order. With no wallet it reads
   * nothing and sends nothing, and says why.
   */
  spotClient: SpotClient;
}

const dec = (n: string, decimals = 2): Decimal => parseDecimal(n, decimals);

/**
 * Dummy predict-tab markets, moved here from `predict.tsx` so it is no
 * longer the one screen with inline mock data.
 */
const DEMO_PREDICTIONS: PredictionCard[] = [
  {
    id: '1',
    asset: 'BTC/USD',
    assetClass: 'CRYPTO',
    timeframe: '1H',
    expires: '59:00',
    price: dec('64200.00'),
    target: dec('65000.00'),
    direction: 'above',
    evidenceHash: '0x7f…c31a',
  },
  {
    id: '2',
    asset: 'ETH/USD',
    assetClass: 'CRYPTO',
    timeframe: '4H',
    expires: '03:59:00',
    price: dec('3400.00'),
    target: dec('3600.00'),
    direction: 'above',
    evidenceHash: '0x4c2a…91df',
  },
  {
    id: '3',
    asset: 'SOL/USD',
    assetClass: 'CRYPTO',
    timeframe: '15M',
    expires: '14:32',
    price: dec('135.00'),
    target: dec('130.00'),
    direction: 'below',
    evidenceHash: '0xa70e…3b55',
  },
  {
    id: '4',
    asset: 'AVAX/USD',
    assetClass: 'CRYPTO',
    timeframe: '1D',
    expires: '23:59:00',
    price: dec('45.00'),
    target: dec('50.00'),
    direction: 'above',
    evidenceHash: '0x91b4…7e08',
  },
];

const DEMO_BLOCKED_LOG: BlockedLogData = { ...BLOCKED, rows: BLOCKED.rows.map((r) => ({ ...r })) };

const demoRefuse = async () => demoOutcome;
const DEMO_VAULT_SOURCE: VaultSource = {
  vaults: DEMO_VAULTS,
  copy: DEMO_COPY,
  createVault: demoRefuse,
  changeVault: demoRefuse,
  cancelVaultChange: demoRefuse,
  fundVault: demoRefuse,
  withdrawFromVault: demoRefuse,
  followLead: demoRefuse,
  unfollow: demoRefuse,
};

/** The demo places nothing and reads no account: a ticket says to sign in, and shows no made-up fill. */
const DEMO_VENUE_ACCOUNT: VenueAccountRead = {
  state: { status: 'unavailable', message: SIGN_IN_TO_TRADE },
  refreshing: false,
  refresh() {},
};
const DEMO_VENUE_ORDERS: VenueOrdersState = { status: 'empty' };
const demoVenueOrder = async (): Promise<VenueOrderResult> => ({ status: 'unavailable', message: SIGN_IN_TO_TRADE });

/**
 * The demo opens no timed trade either. Predict shows the labelled sample (the
 * pairs and the choices, to look at) and no made-up countdown or result; a
 * press on it leads to sign-in.
 */
const DEMO_TIMED_STATE: TimedStateRead = {
  state: SAMPLE_TIMED_STATE,
  refreshing: false,
  refresh() {},
};
const DEMO_TIMED_TRADES: TimedTradesState = { status: 'empty' };

/** No gateway behind the demo source: the risk screen says market data is not connected, and invents no market. */
const DEMO_PERPL_RISK: PerplRiskState = { status: 'unavailable', message: RISK_NOT_CONNECTED };
/** No indexer behind the demo source either: the on-chain record says it is not connected, and invents no transaction. */
const DEMO_ONCHAIN_RECORD: OnchainRecordState = { status: 'not_connected' };
/** No gateway behind the demo source: the spot screen says market data is not connected, and invents no book. */
const DEMO_SPOT_MARKET: SpotMarketState = { status: 'unavailable', code: 'not_connected', message: SPOT_NOT_CONNECTED };
/** And no wallet: nothing is read and nothing is sent. The chain is asked for at each use, since an app configures it at start. */
const DEMO_SPOT_CLIENT: SpotClient = {
  ...unavailableSpotClient({ chainId: 0 }),
  get chainId() {
    return activeChain().id;
  },
};
const demoTimedOpen = async (): Promise<TimedOpenResult> => ({ status: 'unavailable', message: SIGN_IN_TO_TRADE });
const demoTimedClose = async (): Promise<TimedCloseResult> => ({ status: 'unavailable', message: SIGN_IN_TO_TRADE });

/**
 * The default source. Every figure comes straight from `lib/demo.ts`, so a
 * screen rendered with no provider mounted looks exactly like it did before
 * this file existed.
 */
export const demoDataSource: KanonDataSource = {
  mode: 'demo',
  hasPinned: true,
  hasDraft: true,
  rule: {
    ...RULE,
    predicates: [...RULE.predicates],
    bucketSeconds: 900,
    symbol: 'BTC/USD',
    autopilot: false,
  },
  home: { ...HOME, sparkline: [...HOME.sparkline], attempts: HOME.taken + HOME.blocked },
  latestTradeId: TRADE_ID,
  refusal: {
    ...REFUSAL,
    label: 'REFUSED ON-CHAIN',
    unit: 'price',
    requiredLabel: 'REQUIRED HIGH',
    requiredSub: 'PRIOR SWING',
    actualLabel: 'CURRENT PRICE',
    actualSub: 'BTC / USD · 15M',
    tradeId: TRADE_ID,
  },
  compiler: {
    draft: COMPILER.draft,
    transcript: COMPILER.transcript.map((t) => ({ ...t })),
    lines: COMPILER.lines.map((l) => ({ ...l })),
    status: 'idle',
    hasSpec: true,
  },
  async sendCompilerMessage() {
    // Demo: the transcript is static. Sign in to compile against the live model.
  },
  review: {
    plain: REVIEW.plain.map((segments) => [...segments]),
    parametric: [...REVIEW.parametric],
    inferred: REVIEW.inferred.map((d) => ({ ...d })),
    mode: 'demo',
    params: [],
    acknowledged: true,
    preview: null,
    // The demo rule states both exits. It does carry a liquidity sweep, and says what that means on-chain.
    missingExits: [],
    exitsSentence: '',
    gateNote: onchainGateNote(SPEC),
    busy: false,
  },
  editParam() {
    return { ok: false, error: 'Sign in to edit a parameter.' };
  },
  acknowledgeReview() {},
  async submitAmendment() {
    return { ok: false, message: 'Sign in to change a pinned rule.' };
  },
  pinning: {
    ...PINNING,
    agreements: [...PINNING.agreements],
    specHash: RULE.specHash,
    contract: RULE.contract,
    availability: { state: 'demo', message: 'Demo data. Nothing is pinned.' },
    busy: false,
  },
  async pinStrategy() {
    // Demo walks the canvas: the ceremony completes, and nothing is written anywhere.
    return { ok: true, txHash: 'demo' };
  },
  proposal: {
    ...PROPOSAL,
    checks: PROPOSAL.checks.map((c) => ({ ...c })),
    tradeId: TRADE_ID,
    status: 'proposed',
    direction: 'long',
    sizeUnit: 'BTC',
    sizing: 'DEMO ACCOUNT',
  },
  async requestProposal() {
    return { status: 'blocked', message: 'Demo data. Sign in to check a live setup.' };
  },
  async confirmProposal() {
    return { ok: true };
  },
  async undoProposal() {
    return { ok: true };
  },
  async setAutopilot() {
    // Demo: the switch is shown with its terms, and nothing is turned on for a rule nobody pinned.
    return { ok: false, reason: 'demo', message: AUTOPILOT_DEMO };
  },
  tradeDetail(id: string) {
    return {
      ...TRADE,
      id: id || TRADE.id,
      claims: TRADE.claims.map(
        (c): Claim => ({
          symbol: c.symbol,
          summary: c.summary,
          fields: c.fields.map(([k, v]): EvidenceField => [k, v]),
        }),
      ),
    };
  },
  coolingOff: {
    requestedAt: COOLING_OFF.requestedAt,
    nowAt: COOLING_OFF.nowAt,
    requestedLabel: COOLING_OFF.requestedLabel,
    currentSpec: SPEC,
    pendingSpec: PENDING_SPEC,
  },
  async finalizeCoolingOff() {
    return { ok: false, message: 'Demo data.' };
  },
  async withdrawCoolingOff() {
    // Demo walks the canvas back to the rule card; nothing is pending anywhere.
    return { ok: true, kind: 'immediate' };
  },
  shareCard: {
    ...SHARE_CARD,
    summary: [...SHARE_CARD.summary],
    specHash: RULE.specHash,
  },
  predictions: DEMO_PREDICTIONS,
  async takeSide() {
    // No live settlement wired yet.
  },
  usePredict() {
    return useMemo<PredictFeed>(
      () => ({
        state: 'demo',
        markets: demoMarkets(DEMO_PREDICTIONS, Math.floor(Date.now() / 1000)),
        availability: DEMO_MARKET_AVAILABILITY,
        nativeSymbol: 'MON',
        async takeSide() {
          return { ok: false, reason: 'demo', message: DEMO_MARKET_AVAILABILITY.message };
        },
        async checkCrossed() {
          return null;
        },
      }),
      [],
    );
  },
  onboardingFund: { options: ONBOARDING.fund.map((o) => ({ ...o })) },
  onboardingStrategy: { starters: [...ONBOARDING.starters] },
  useVaults: () => DEMO_VAULT_SOURCE,
  useBlockedLog: () => DEMO_BLOCKED_LOG,
  session: { mode: 'demo', pending: false, signedIn: false, hasWallet: false },
  settings: { name: 'Demo', username: 'demo', email: null, hasWallet: false },
  // The same history Profile lists, so Home's "Rules pinned" and Profile's count are one number.
  ruleHistory: DEMO_RULES,
  useMarkets: () => DEMO_MARKETS,
  useTicker: demoTicker,
  useActivity: (limit = 10): ActivityState => ({ status: 'demo', items: DEMO_ACTIVITY.slice(0, limit) }),
  useFollows: () => DEMO_FOLLOWS,
  useSparkline: demoSparkline,
  useCopyLeads: () => DEMO_COPY_LEADS,
  useSeries(asset, bucketSeconds) {
    return useMemo<SeriesState>(
      () => ({ status: 'demo', series: buildFixtureSeries(asset, bucketSeconds) }),
      [asset, bucketSeconds],
    );
  },
  useChartMarkers(asset, bucketSeconds) {
    return useMemo(
      () => buildFixtureMarkers(buildFixtureSeries(asset, bucketSeconds)),
      [asset, bucketSeconds],
    );
  },
  useAnalytics() {
    return DEMO_ANALYTICS_STATE;
  },
  useNansenFlow() {
    // Demo has no Nansen key, and this card never shows a figure it did not read.
    return NANSEN_NOT_CONNECTED;
  },
  useVenueAccount: () => DEMO_VENUE_ACCOUNT,
  placeVenueOrder: demoVenueOrder,
  closeVenuePosition: demoVenueOrder,
  useVenueOrders: () => DEMO_VENUE_ORDERS,
  useTimedState: () => DEMO_TIMED_STATE,
  openTimedTrade: demoTimedOpen,
  closeTimedTrade: demoTimedClose,
  useTimedTrades: () => DEMO_TIMED_TRADES,
  usePerplRisk: () => DEMO_PERPL_RISK,
  useOnchainRecord: () => DEMO_ONCHAIN_RECORD,
  useSpotMarket: () => DEMO_SPOT_MARKET,
  spotClient: DEMO_SPOT_CLIENT,
};

/** Re-exported so a real provider can fall back to the demo trade id. */
export { TRADE_ID };

/**
 * The context holds a *store*, not the source, and the store's identity never
 * changes. A context value that changes re-renders every component that reads
 * the context; a store lets each component subscribe to just the slice it
 * reads (`useKanonSelector`), so one part of the source moving does not
 * re-render every screen. See `lib/store.ts`.
 */
const defaultStore = createStore<KanonDataSource>(demoDataSource);
const KanonDataContext = createContext<Store<KanonDataSource>>(defaultStore);

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function KanonDataProvider({
  source,
  children,
}: {
  source: KanonDataSource;
  children: ReactNode;
}) {
  const store = useRef<Store<KanonDataSource> | null>(null);
  if (store.current === null) store.current = createStore(source);
  // Before paint, so a subscriber never draws a frame from the previous source.
  useIsomorphicLayoutEffect(() => {
    store.current?.set(source);
  }, [source]);
  return <KanonDataContext.Provider value={store.current}>{children}</KanonDataContext.Provider>;
}

/**
 * Reads one slice of the source and re-renders only when that slice changes
 * (`Object.is` by default; pass `shallowEqual` for a selector that builds an
 * object). This is what new components should use.
 */
export function useKanonSelector<S>(
  selector: (source: KanonDataSource) => S,
  isEqual?: (a: S, b: S) => boolean,
): S {
  return useStoreSelector(useContext(KanonDataContext), selector, isEqual);
}

const identity = (source: KanonDataSource) => source;

/**
 * The whole source. Re-renders whenever any part of it changes, which is what
 * every existing screen relies on. Prefer `useKanonSelector`, or the per-domain
 * hooks in `lib/domains.ts`, in anything that reads only a part.
 */
export const useKanonData = (): KanonDataSource => useKanonSelector(identity);
