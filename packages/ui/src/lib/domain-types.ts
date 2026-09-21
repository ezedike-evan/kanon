import type { Decimal } from '@kanon/spec';

/**
 * What the per-domain hooks return (`lib/domains.ts`). One shape per domain,
 * each with the same four states, so a screen handles `loading` / `empty` /
 * `ready` / `demo` the same way everywhere. `demo` is the logged-out fallback
 * and carries fixtures; a signed-in read never returns it.
 */

export type DomainStatus = 'loading' | 'empty' | 'ready' | 'demo';

// --- Session -----------------------------------------------------------------

/** Who is looking, and whether what they see is theirs or a fixture. */
export interface KanonSession {
  /** `demo` renders fixtures; `live` renders the signed-in user's own rows. */
  mode: 'demo' | 'live';
  /** Auth has not said yet whether anyone is signed in. Show a skeleton, not the fixtures. */
  pending: boolean;
  signedIn: boolean;
  /** A signer exists, so an action can say why it cannot run before it is tried. */
  hasWallet: boolean;
}

// --- Markets: tradeable pairs, price and 24-hour move -------------------------

/**
 * One pair row. `changeBps` is integer basis points from the first print in
 * the last 24 hours, or null when there is no earlier print to compare with:
 * "no move known" is never drawn as 0%.
 */
export interface PairTicker {
  /** `BTC/USD`. */
  asset: string;
  base: string;
  quote: string;
  price: Decimal;
  changeBps: number | null;
  /** Unix seconds of the newest print. */
  publishTime: number;
}

export type MarketsState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready' | 'demo'; pairs: PairTicker[] };

export type TickerState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready' | 'demo'; ticker: PairTicker };

// --- Activity ----------------------------------------------------------------

export interface ActivityItem {
  /** The trade id. The evidence for a row is one tap away on the trade. */
  id: string;
  kind: 'executed' | 'refused' | 'proposed' | 'undone';
  asset: string;
  direction: 'long' | 'short';
  entry: Decimal;
  size: Decimal;
  /** The predicate that refused it, when it was refused. */
  refusedBy?: string;
  /** Milliseconds. */
  at: number;
}

export type ActivityState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready' | 'demo'; items: ActivityItem[] };

// --- Home ----------------------------------------------------------------------

/**
 * Behaviour, not profit. P&L is deliberately not here: Home never leads with
 * it, and a screen cannot render a number this hook does not return.
 */
export interface BehaviourStats {
  taken: number;
  blocked: number;
  /** Setups put to the rule. Zero means adherence has nothing to divide. */
  attempts: number;
  adherenceBps: number;
}

export interface HomeRule {
  /** A rule is pinned and enforcing. */
  hasPinned: boolean;
  /** A compiled draft is waiting for review. */
  hasDraft: boolean;
  ordinal: string;
  name: string;
  asset: string;
  timeframe: string;
}

export type HomeState =
  | { status: 'loading' }
  | { status: 'ready' | 'demo'; stats: BehaviourStats; rule: HomeRule; activity: ActivityItem[] };

// --- Profile -------------------------------------------------------------------

export interface RuleHistoryItem {
  id: string;
  status: 'draft' | 'pinned' | 'cooling_off';
  /** The spec hash, so a rule can be checked against its pin. */
  specHash: string;
  /** Milliseconds, or null for a draft that was never pinned. */
  pinnedAt: number | null;
  /** `bos_bullish + fvg_present`, or null when the stored spec no longer parses. */
  name: string | null;
  asset: string | null;
  /** This is the rule enforcing now. */
  active: boolean;
  /** The pin transaction: the on-chain evidence for the hash. Absent for a draft and in the demo. */
  pinTxHash?: string | undefined;
}

export interface ProfileFollow {
  address: string | null;
  leaderStrategyId: string;
  allocationBps: number;
  active: boolean;
}

export interface ProfileSettings {
  name: string;
  username: string;
  email: string | null;
  hasWallet: boolean;
  /** Milliseconds the account was made (the row's creation time). Absent in the demo. */
  joinedAt?: number | undefined;
}

export type ProfileState =
  | { status: 'loading' }
  | { status: 'empty' }
  | {
      status: 'ready' | 'demo';
      settings: ProfileSettings;
      /** Behaviour counts. The trade-by-trade record is `useActivity(limit)`. */
      records: BehaviourStats;
      rules: RuleHistoryItem[];
      following: ProfileFollow[];
    };
