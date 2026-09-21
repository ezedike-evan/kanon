/**
 * The pure half of the Home feed: a pair's 24-hour line and a copy lead's
 * summary card. No `ctx`, no clock, no I/O, so every rule is pinned down in
 * `homeFeedLogic.test.ts`.
 */

import { adherenceBps, predicateSymbol, timeframeLabel, parseSpec, type Decimal } from '@kanon/spec';

/** One sample per two hours: 11 window starts plus the newest print is a 24-hour line. */
export const SPARK_STEP_SECONDS = 7200;
export const SPARK_WINDOWS = 11;

/**
 * The instants a pair's line is sampled at, oldest first, ending at the
 * start of the window that holds the newest print.
 *
 * They sit on a fixed grid (multiples of the step) rather than being counted
 * back from the newest print. That is what keeps a sample's read stable: the
 * first tick at or after 08:00 is the same row until 08:00 is an old window, so
 * only the last point of the line moves when a new price prints.
 */
export function sparkSampleTimes(latestPublishTime: number): number[] {
  const anchor = Math.floor(latestPublishTime / SPARK_STEP_SECONDS) * SPARK_STEP_SECONDS;
  const out: number[] = [];
  for (let i = SPARK_WINDOWS - 1; i >= 0; i--) out.push(anchor - i * SPARK_STEP_SECONDS);
  return out;
}

export interface SparkSample {
  price: Decimal;
  publishTime: number;
}

/**
 * The line, oldest first. `samples` are the first print at or after each
 * sample instant (or `null` when there was none). A window with no print of
 * its own returns a later window's print; keeping it would draw a flat run that
 * was never on the tape, so a print already used is dropped, and so is one that
 * printed a whole step after the instant it stood in for. The newest print
 * closes the line. Fewer than two points draws nothing rather than a dot.
 *
 * The values are for drawing a shape only: every price figure on screen comes
 * from the ticker, in integer atoms.
 */
export function assembleSpark(
  instants: readonly number[],
  samples: readonly (SparkSample | null)[],
  latest: SparkSample,
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  samples.forEach((s, i) => {
    if (!s) return;
    const at = instants[i];
    if (at === undefined || s.publishTime - at >= SPARK_STEP_SECONDS) return;
    if (s.publishTime > latest.publishTime || seen.has(s.publishTime)) return;
    seen.add(s.publishTime);
    out.push(Number(s.price.atoms));
  });
  if (!seen.has(latest.publishTime)) out.push(Number(latest.price.atoms));
  return out.length >= 2 ? out : [];
}

// ---------------------------------------------------------------------------
// Copy leads
// ---------------------------------------------------------------------------

/** A listed strategy, as Home's carousel shows it. Counts, no user ids and no addresses. */
export interface LeadSummary {
  leadId: string;
  strategyId: string;
  /** `bos_bullish + fvg_present`, or `STRATEGY` when the stored spec no longer parses. */
  name: string;
  asset: string;
  timeframe: string;
  taken: number;
  blocked: number;
  /** Null until there is at least one setup to divide by. */
  adherenceBps: number | null;
  followers: number;
  profitShareBps: number;
}

export const MAX_LEADS = 12;

export function leadSummary(input: {
  leadId: string;
  strategyId: string;
  spec: unknown;
  taken: number;
  blocked: number;
  followers: number;
  profitShareBps: number;
}): LeadSummary {
  let name = 'STRATEGY';
  let asset = '';
  let timeframe = '';
  try {
    const spec = parseSpec(input.spec);
    name = spec.predicates.map((p) => predicateSymbol(p)).join(' + ');
    asset = spec.series.asset;
    timeframe = timeframeLabel(spec);
  } catch {
    // A spec that no longer parses is still listed, by the placeholder name, and invents nothing.
  }
  return {
    leadId: input.leadId,
    strategyId: input.strategyId,
    name,
    asset,
    timeframe,
    taken: input.taken,
    blocked: input.blocked,
    adherenceBps: adherenceBps(input.taken, input.blocked),
    followers: input.followers,
    profitShareBps: input.profitShareBps,
  };
}

/** Most adherent first, then the most followed, then the most tested. Stable for equal keys. */
export function rankLeads(leads: readonly LeadSummary[]): LeadSummary[] {
  return [...leads].sort(
    (a, b) =>
      (b.adherenceBps ?? -1) - (a.adherenceBps ?? -1) ||
      b.followers - a.followers ||
      b.taken + b.blocked - (a.taken + a.blocked),
  );
}
