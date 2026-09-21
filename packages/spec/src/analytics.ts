/**
 * The shapes the analytics screen reads, shared so the backend that computes
 * them (`packages/backend/convex/analyticsLogic.ts`) and the UI that draws them
 * cannot disagree about a field.
 *
 * Types only. Every figure that is a price, a size or a P&L is a `Decimal`;
 * every ratio is an integer number of basis points. Nothing here is a float.
 */

import type { Decimal } from './decimal';

/** Setups put to the pinned rule, and how they came out. */
export interface AdherenceStats {
  /** Trades that ran. */
  executed: number;
  /** Trades the rule refused. A refusal is the rule working. */
  refused: number;
  /** Proposals the user cancelled in the undo window. Not an attempt at breaking the rule. */
  undone: number;
  /** Proposals still inside their undo window. */
  proposed: number;
  /** `executed + refused`: the setups that reached a verdict and were not withdrawn. */
  attempts: number;
  /** Executed trades whose every predicate was satisfied. */
  satisfied: number;
  /** Executed trades with a failed or missing predicate. The contract makes this zero. */
  breaches: number;
  /** `satisfied / attempts` in bps, rounded half up. Null before there is an attempt. */
  adherenceBps: number | null;
  /** `refused / attempts` in bps. Null before there is an attempt. */
  refusalBps: number | null;
}

/** What the refusals would have cost, played forward to each setup's own stop. */
export interface AvoidedStats {
  refused: number;
  /** Refusals with later price data to judge against. */
  judged: number;
  /** Refusals with no (or not enough) later price data. No verdict is claimed for these. */
  pending: number;
  wouldHaveLostCount: number;
  /** Sum of the losing outcomes, as a positive figure. */
  lossAvoided: Decimal;
  wouldHaveWonCount: number;
  /** Sum of the refused setups that would have made money. Stated, not hidden. */
  gainForegone: Decimal;
}

/** Refusals grouped by the predicate that failed. */
export interface PredicateRefusal {
  predicateId: string;
  /** The predicate in SMC language, e.g. `bos_bullish`. */
  label: string;
  kind: string | null;
  count: number;
  /** Share of all refusals, in bps. */
  shareBps: number;
  lostCount: number;
  lossAvoided: Decimal;
  /** The most recent refusal: one tap to the evidence chain behind the group. */
  latestTradeId: string;
  latestAt: number;
}

export type HealthBand = 'healthy' | 'deleveraging' | 'liquidatable';

export interface ExposureLine {
  asset: string;
  side: 'long' | 'short';
  /** Notional in collateral units, exactly as `MarginAccount.Position.size`. */
  notional: Decimal;
  shareBps: number;
  entryPrice: Decimal;
  markPrice: Decimal | null;
  /** Unrealised P&L at the mark, in collateral units. Null without a mark. */
  pnl: Decimal | null;
}

interface RiskBase {
  collateral: Decimal;
  lines: ExposureLine[];
}

/**
 * The margin account read the way `MarginAccount.healthFactor` reads it.
 *
 *   none      no account exists for this user
 *   flat      no open positions: nothing to hold margin against
 *   unpriced  a position has no current price. The contract reverts rather than
 *             guess, and so does this: no health factor is claimed.
 *   ok        health factor, exposure and leverage
 */
export type RiskSnapshot =
  | { status: 'none' }
  | ({ status: 'flat' } & RiskBase)
  | ({ status: 'unpriced'; missing: string[] } & RiskBase)
  | ({
      status: 'ok';
      debt: Decimal;
      unrealizedPnl: Decimal;
      equity: Decimal;
      /** `sum(size * maintenanceMarginBps / 1e4)` over open positions. */
      maintenance: Decimal;
      maintenanceBps: number;
      /** 18 decimals, exactly the contract's 1e18 == 100%. Null when nothing needs maintenance. */
      healthFactor: Decimal | null;
      /** Where the deleveraging band ends (18 decimals). Liquidation sits at 1.0. */
      adlHealthThreshold: Decimal;
      band: HealthBand;
      gross: Decimal;
      /** Long notional minus short notional. */
      net: Decimal;
      /** Gross exposure over equity, in bps. Null when equity is not positive. */
      leverageBps: number | null;
    } & RiskBase);

export interface EquityPoint {
  /** Milliseconds. */
  at: number;
  equity: Decimal;
}

export type DrawdownStats =
  | { status: 'empty' }
  | {
      status: 'ok';
      points: number;
      maxDrawdownBps: number;
      currentDrawdownBps: number;
      peak: Decimal;
      trough: Decimal;
      peakAt: number;
      troughAt: number;
    };

export interface CoolingOffTime {
  active: boolean;
  holdMs: number;
  elapsedMs: number;
  remainingMs: number;
  /** How far through the hold, in bps. */
  progressBps: number;
}

export interface AnalyticsReport {
  /** Milliseconds the report was computed. */
  asOf: number;
  strategyId: string;
  specHash: string;
  /** The asset the strategy trades, as its series names it. What the flow card reads. */
  asset: string;
  adherence: AdherenceStats;
  avoided: AvoidedStats;
  byPredicate: PredicateRefusal[];
  risk: RiskSnapshot;
  drawdown: DrawdownStats;
  /** The points the drawdown was read from: the working, one tap away. */
  equityCurve: EquityPoint[];
  coolingOff: CoolingOffTime;
  /** Modelled P&L of executed trades. Below the fold, and labelled as modelled. */
  pnl: { total: Decimal; trades: number };
  /** True when the price read hit its ceiling, so the oldest verdicts may be missing. */
  truncated: boolean;
}

export type AnalyticsState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; report: AnalyticsReport }
  | { status: 'demo'; report: AnalyticsReport };

// ---------------------------------------------------------------------------
// Nansen smart-money net flow
// ---------------------------------------------------------------------------

/** The token Nansen tracks on-chain as the stand-in for a traded asset. */
export interface NansenToken {
  chain: string;
  address: string;
  symbol: string;
}

export interface NansenFlowWindows {
  /** USD at two decimals. Positive is net accumulation by smart money, negative net distribution. */
  h1: Decimal;
  h24: Decimal;
  d7: Decimal;
  d30: Decimal;
}

export type NansenErrorKind =
  | 'auth'
  | 'credits'
  | 'rate_limited'
  | 'bad_request'
  | 'upstream'
  | 'network'
  | 'invalid_response';

/**
 * Smart-money net flow for one asset.
 *
 *   not_connected  no `NANSEN_API_KEY`. The card says so and shows no figure.
 *   unsupported    the asset has no token Nansen can be asked about.
 *   no_data        Nansen answered, but has no flow row for that token.
 *   error          the request failed. Never papered over with a number.
 */
export type NansenFlow =
  | { status: 'not_connected' }
  | { status: 'unsupported'; asset: string }
  | { status: 'no_data'; asset: string; token: NansenToken }
  | { status: 'error'; kind: NansenErrorKind; message: string }
  | {
      status: 'ok';
      asset: string;
      token: NansenToken;
      flows: NansenFlowWindows;
      /** Smart-money traders active in the token over 30 days. */
      traderCount: number;
      /** Milliseconds Nansen was asked. */
      fetchedAt: number;
      /** Nansen's own request id, for the trace back to their side. Null if absent. */
      requestId: string | null;
    };

export type NansenState = { status: 'loading' } | NansenFlow;
