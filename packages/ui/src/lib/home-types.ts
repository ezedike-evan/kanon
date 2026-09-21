/**
 * What the Home-only hooks return (`lib/home-reads.ts`). The same four states as
 * every per-domain hook (`domain-types.ts`), so Home handles them the way the
 * rest of the app does. Home reads two things the shared domains do not carry:
 * a pair's last-day line, and a summary of each strategy listed for copying.
 */

export type SparklineState =
  | { status: 'loading' }
  | { status: 'empty' }
  | {
      status: 'ready' | 'demo';
      /**
       * A shape, oldest first. Only its outline is meaningful: the figure on a
       * pair row is the ticker's, in integer atoms, never one of these.
       */
      points: number[];
    };

/** A strategy someone has listed for copying, as Home's carousel shows it. Counts only. */
export interface CopyLeadSummary {
  leadId: string;
  /** The lead strategy's id: what a `ProfileFollow` points at. */
  strategyId: string;
  /** `bos_bullish + fvg_present`. The rule in the spec's own words. */
  name: string;
  /** `BTC/USD`, or empty when the stored spec no longer parses. */
  asset: string;
  timeframe: string;
  taken: number;
  blocked: number;
  /** Of the setups it was put to, the share that satisfied it. Null before there is one. */
  adherenceBps: number | null;
  followers: number;
  /** The only fee a follower can be charged. */
  profitShareBps: number;
}

export type CopyLeadsState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready' | 'demo'; leads: CopyLeadSummary[] };
