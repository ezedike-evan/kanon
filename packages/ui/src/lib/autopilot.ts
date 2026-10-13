import { normalizeSymbol } from './chart-assets';
import type { AutopilotOutcome } from './flow-types';
import { accountNote, choiceFacts, durationLabel, durationWords, timedView } from './timed-trade';
import type { TimedState } from './timed-types';
import { formatUsd } from './venue-trade';

/**
 * Autopilot, as the app says it.
 *
 * A pinned rule judged on every closed candle of its own timeframe with nobody
 * pressing anything. When every predicate passes, the backend writes a proposal
 * and the gateway opens a small timed trade on Perpl testnet for it, which
 * closes by itself. A predicate that fails is a refusal, recorded as any other.
 * No model is involved: it is the arithmetic the "check setup now" button runs.
 *
 * The fixed terms below restate `packages/backend/convex/autopilotLogic.ts`
 * (`AUTOPILOT_STAKE_USD`, `AUTOPILOT_DURATIONS`, `holdSecondsFor`,
 * `HANDOFF_WINDOW_MS`). This package imports neither the backend nor the
 * execution package, so they are kept here by hand, and the server holds every
 * trade to its own values whatever is written here. A value that drifts makes
 * this screen wrong, never a trade wider.
 *
 * No React, no clock and no I/O of its own (the one call it makes is handed
 * in), so every sentence and figure here is pinned down in `autopilot.test.ts`.
 */

// --- The fixed terms ----------------------------------------------------------

/** Whole dollars: the collateral of every autopilot trade, and the most it can lose. */
export const AUTOPILOT_STAKE_USD = 10;
/** Seconds: the holds on offer. */
export const AUTOPILOT_DURATIONS = [60, 300, 900, 3600] as const;
/** Milliseconds after a pass in which the gateway may still begin its opening order. */
export const HANDOFF_WINDOW_MS = 120_000;
/** Where an autopilot trade is opened. */
export const AUTOPILOT_VENUE = 'Perpl testnet';

/** The longest hold on offer: what a candle longer than every one of them gets. */
const LONGEST_HOLD = Math.max(...AUTOPILOT_DURATIONS);

/** The shortest hold on offer that is not shorter than one candle, or the longest on offer for a candle longer than that. */
export function holdSecondsFor(candleSeconds: number): number {
  return AUTOPILOT_DURATIONS.find((seconds) => seconds >= candleSeconds) ?? LONGEST_HOLD;
}

/** `15m`, `1h`, `4h`, `1d`: a candle as a chart names it. */
export function candleLabel(seconds: number): string {
  return seconds % 86_400 === 0 ? `${seconds / 86_400}d` : durationLabel(seconds);
}

// --- What it will do, before it is turned on -----------------------------------

export interface AutopilotTerms {
  /** Seconds one candle of the rule lasts. */
  candleSeconds: number;
  /** Seconds a trade is held before it is closed. */
  holdSeconds: number;
  /** One sentence, above the table. */
  summary: string;
  /** Label then value: every fixed term, each figure exact. */
  facts: Array<[label: string, value: string]>;
  /** What a table row cannot hold, each one sentence or two. */
  notes: string[];
}

const listed = (items: readonly string[]): string =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/**
 * Everything autopilot does for a rule on `candleSeconds` candles, in plain
 * words. No hidden parameters: a default the person would otherwise meet for
 * the first time on a trade is stated here first.
 */
export function autopilotTerms(candleSeconds: number): AutopilotTerms {
  const holdSeconds = holdSecondsFor(candleSeconds);
  const candle = candleLabel(candleSeconds);
  const hold = durationLabel(holdSeconds);
  const stake = formatUsd(AUTOPILOT_STAKE_USD);
  const holdRule =
    `The hold is the shortest of ${listed(AUTOPILOT_DURATIONS.map(durationLabel))} that is not shorter than one candle of your rule.` +
    (candleSeconds > LONGEST_HOLD ? ` A ${candle} candle is longer than all of them, so it is ${durationLabel(LONGEST_HOLD)}.` : '');

  return {
    candleSeconds,
    holdSeconds,
    summary: `Your rule is judged at the close of every ${candle} candle, with nobody pressing anything.`,
    facts: [
      ['Checked', `Every ${candle} candle close`],
      ['A pass opens', `${stake} timed trade, ${AUTOPILOT_VENUE}`],
      ['Held for', `${hold}, then closed by itself`],
      ['Most it can lose', `${stake}, ended early at that loss`],
      ['At a time', '1 trade for this rule'],
      ['A fail', 'Recorded as a refusal'],
      ['Turning it off', 'Withdraws anything not yet sent'],
    ],
    notes: [
      `It opens in your rule's own direction. The ${stake} stake and the hold are fixed: your rule's own size and stop stay on the proposal as evidence, and are not what is sent.`,
      holdRule,
      'The first candle judged is the next one to close. Nothing that has already closed is judged.',
      'A candle that passes while a trade is waiting or open records nothing.',
      `A pass the gateway has not begun to open within ${durationWords(HANDOFF_WINDOW_MS / 1000)} is not opened. Nothing is sent, and the proposal says why.`,
      'A trade already running when you turn it off runs to its time, or until you end it on Predict.',
      'No model is involved. It is the arithmetic CHECK SETUP NOW runs: it changes when your rule is consulted, never what the rule is.',
      accountNote('testnet'),
    ],
  };
}

/** The line under the switch on a rule's card: what is happening now, or what would. */
export function autopilotSummary(candleSeconds: number, on: boolean): string {
  const candle = candleLabel(candleSeconds);
  const opens = `a pass opens ${formatUsd(AUTOPILOT_STAKE_USD)} for ${durationLabel(holdSecondsFor(candleSeconds))}`;
  return on ? `Judging every ${candle} close: ${opens}.` : `Off. On, it judges every ${candle} close and ${opens}.`;
}

// --- What the venue adds to the terms ------------------------------------------

/**
 * The two terms that are the venue's and not autopilot's: the size the stake
 * opens at the market's own leverage, and how far from the mark price an order
 * may fill. They are read from what Predict was last told (`timedState`), so
 * nothing about them is restated here.
 */
export type AutopilotVenueTerms =
  | { status: 'loading' }
  /** The server said them: label then value, in Predict's own words. */
  | { status: 'known'; facts: Array<[label: string, value: string]> }
  /** They could not be read, or the venue would not open this trade as things stand. */
  | { status: 'unknown' | 'unlisted'; note: string };

export const VENUE_TERMS_UNREAD =
  "The position's size and its slippage bound are the venue's own. Both are on every Predict slide, and on the trade once it opens.";

export function autopilotVenueTerms(state: TimedState, asset: string | null, holdSeconds: number): AutopilotVenueTerms {
  if (state.status === 'loading') return { status: 'loading' };
  // The signed-out sample is no server's answer: its figures are never passed off as the venue's.
  if (state.status !== 'ready' || state.sample === true || asset === null) return { status: 'unknown', note: VENUE_TERMS_UNREAD };

  const market = state.markets.find((m) => normalizeSymbol(m.asset) === normalizeSymbol(asset));
  if (!market) {
    return {
      status: 'unlisted',
      note: `Perpl lists no ${normalizeSymbol(asset)} market for timed trades right now. A pass would be recorded as not opened, with the venue's reason.`,
    };
  }
  if (!state.limits.stakesUsd.includes(AUTOPILOT_STAKE_USD) || !state.limits.durations.includes(holdSeconds)) {
    return {
      status: 'unlisted',
      note: `The venue does not offer ${formatUsd(AUTOPILOT_STAKE_USD)} for ${durationLabel(holdSeconds)} right now. A pass would be recorded as not opened, with the venue's reason.`,
    };
  }
  const facts = choiceFacts(timedView(state, { asset, stakeUsd: AUTOPILOT_STAKE_USD, seconds: holdSeconds }));
  const picked = facts.filter(([label]) => label === 'Size' || label === 'Max slippage');
  return picked.length === 2 ? { status: 'known', facts: picked } : { status: 'unknown', note: VENUE_TERMS_UNREAD };
}

// --- Which rules it is offered for ---------------------------------------------

/** What a rule is now, as `profile-logic.ts` names it. Restated so this file stays free of the profile's imports. */
type RuleStanding = 'pinned' | 'cooling_off' | 'superseded' | 'draft';

/**
 * What a rule's card offers. Autopilot runs a rule that is enforced, so it is
 * turned on only for the one that is pinned or cooling off. A rule that was
 * replaced while autopilot was on for it is still being judged, so it keeps the
 * way to turn it off. A draft is judged by nothing.
 */
export type AutopilotOffer = 'toggle' | 'off_only' | 'none';

export function autopilotOffer(standing: RuleStanding, on: boolean, readable = true): AutopilotOffer {
  if (standing === 'draft') return 'none';
  if ((standing === 'pinned' || standing === 'cooling_off') && readable) return 'toggle';
  return on ? 'off_only' : 'none';
}

/** The rule a switch and its sheet are about. */
export interface AutopilotSubject {
  /** The strategy's id: what the switch is thrown for. */
  id: string;
  /** `RULE 04`. */
  ordinal: string;
  /** `BTC/USD`, or null when the stored spec no longer parses. */
  asset: string | null;
  /** Seconds one candle of the rule lasts, or null when the stored spec no longer parses. */
  candleSeconds: number | null;
  on: boolean;
  offer: AutopilotOffer;
  /** A newer rule replaced this one. With autopilot still on, the sheet says it is still being judged. */
  replaced: boolean;
}

export const REPLACED_STILL_ON = 'This rule was replaced by a newer one, and autopilot is still judging it.';
export const TERMS_UNREADABLE = "This rule's spec can no longer be read, so its terms cannot be stated.";

// --- Throwing the switch --------------------------------------------------------

/** Said where the switch would be, to somebody who has not signed in. The way to sign in follows it. */
export const AUTOPILOT_SIGN_IN = 'Autopilot runs on your own pinned rule.';
export const AUTOPILOT_DEMO = 'Demo data. Sign in to run your own rule on autopilot.';
export const AUTOPILOT_UNREAD = 'The answer could not be read. Check the switch before trying again.';

/**
 * A calm sentence for a switch that was not thrown. The server's own message is
 * a stack frame in development and "Server Error" in production, so it is read
 * for what it means and never shown.
 */
export function autopilotFailureLine(err: unknown, on: boolean): string {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (message.includes('pin this one first')) return 'Autopilot runs a pinned rule. Pin this one first.';
  if (message.includes('Could not find public function')) return 'This server does not run autopilot yet. Nothing changed.';
  return on
    ? 'Autopilot was not turned on. Nothing changed: your rule is enforced as before.'
    : 'Autopilot is still on: the request to turn it off did not go through. Try again.';
}

/**
 * Throws the switch for one rule, through the mutation handed in
 * (`strategies:setAutopilot`). Signed out nothing is called. Whatever happens
 * comes back as a value: a mutation that throws is a sentence, never a
 * rejection a screen would have to catch.
 */
export async function switchAutopilot(input: {
  /** The signed-in user's row, or undefined on the demo source. A gate only: it is never sent. */
  userId: string | undefined;
  strategyId: string;
  on: boolean;
  setAutopilot: (args: { strategyId: string; on: boolean }) => Promise<unknown>;
}): Promise<AutopilotOutcome> {
  const { userId, strategyId, on, setAutopilot } = input;
  if (!userId) return { ok: false, reason: 'demo', message: AUTOPILOT_DEMO };
  if (!strategyId || strategyId === 'none') {
    return { ok: false, reason: 'no_rule', message: 'Autopilot runs a pinned rule. Pin one first.' };
  }
  let answer: unknown;
  try {
    answer = await setAutopilot({ strategyId, on });
  } catch (err) {
    return { ok: false, reason: 'failed', message: autopilotFailureLine(err, on) };
  }
  const now = (answer as { autopilot?: unknown } | null | undefined)?.autopilot;
  // The server says what the switch is now. An answer that does not say is not taken for a yes.
  return typeof now === 'boolean' ? { ok: true, on: now } : { ok: false, reason: 'failed', message: AUTOPILOT_UNREAD };
}

// --- A setup autopilot judged ---------------------------------------------------

/** The fields of a `trades` row that say what autopilot did with it. */
export interface AutopilotRow {
  status: 'proposed' | 'executed' | 'refused' | 'undone';
  origin?: 'autopilot' | undefined;
  handoff?: 'pending' | 'opened' | 'not_opened' | undefined;
  stakeUsd?: number | undefined;
  holdSeconds?: number | undefined;
  timedTradeId?: string | undefined;
  handoffReason?: string | undefined;
}

/**
 *   refused     a predicate failed at the candle close
 *   waiting     every predicate passed, and the gateway has not opened it yet
 *   opened      a timed trade is running or has run for it
 *   not_opened  every predicate passed and nothing was opened
 */
export type AutopilotState = 'refused' | 'waiting' | 'opened' | 'not_opened';

/** What autopilot did with a setup, as a screen says it. */
export interface AutopilotNote {
  state: AutopilotState;
  /** `REFUSED`, `WAITING FOR THE GATEWAY`, `OPENED`, `NOT OPENED`. */
  label: string;
  /** One or two plain sentences. */
  line: string;
  /** `$10 · 15m`: what the gateway was asked to open. Null on a refusal, or when the row does not say. */
  sent: string | null;
  /** The timed trade that was opened for it: where its real fill is. */
  timedTradeId: string | null;
  /** Why nothing was opened, in the server's own words, unchanged. */
  reason: string | null;
}

export const AUTOPILOT_STATE_LABEL: Record<AutopilotState, string> = {
  refused: 'REFUSED',
  waiting: 'WAITING FOR THE GATEWAY',
  opened: 'OPENED',
  not_opened: 'NOT OPENED',
};

const STATE_LINE: Record<AutopilotState, string> = {
  refused: 'Judged at a candle close, with nobody pressing anything.',
  waiting: `Every predicate passed at a candle close. The gateway has ${durationWords(HANDOFF_WINDOW_MS / 1000)} from then to begin opening it. After that nothing is sent.`,
  opened: 'Every predicate passed at a candle close, and a timed trade was opened for it.',
  // Not "nothing was sent": one of the server's reasons is an order it never heard back about.
  not_opened: 'Every predicate passed at a candle close. No timed trade was recorded for it.',
};

/** Said where a reason belongs and the server recorded none. */
export const NO_REASON_RECORDED = 'No reason was recorded.';

/** Said beside an autopilot proposal's entry, size and stop: they are the rule's sizing of the setup, not the order. */
export const RULE_SIZING_NOTE =
  "Entry, size and stop here are your rule's own sizing of the setup. They are not what was sent: the fill is on the timed trade.";

/** Where an autopilot row stands. The hand-off says more than the status, so it is read first. */
export function autopilotState(row: AutopilotRow): AutopilotState | null {
  if (row.origin !== 'autopilot') return null;
  if (row.status === 'refused') return 'refused';
  if (row.handoff === 'opened' || row.status === 'executed') return 'opened';
  if (row.handoff === 'not_opened' || row.status === 'undone') return 'not_opened';
  return 'waiting';
}

/** What autopilot did with a setup, or null for one its owner put to the rule. */
export function autopilotNote(row: AutopilotRow): AutopilotNote | null {
  const state = autopilotState(row);
  if (state === null) return null;
  const said = row.stakeUsd !== undefined && row.holdSeconds !== undefined;
  return {
    state,
    label: AUTOPILOT_STATE_LABEL[state],
    line: STATE_LINE[state],
    sent: state !== 'refused' && said ? `${formatUsd(row.stakeUsd ?? 0)} · ${durationLabel(row.holdSeconds ?? 0)}` : null,
    timedTradeId: state === 'opened' && row.timedTradeId ? row.timedTradeId : null,
    reason: state === 'not_opened' ? (row.handoffReason?.trim() ? row.handoffReason : NO_REASON_RECORDED) : null,
  };
}

/** Said on a timed trade autopilot opened, beside the way to the proposal that is its evidence. */
export const OPENED_BY_AUTOPILOT = 'Opened by autopilot: your rule passed at a candle close, with nobody pressing anything.';
