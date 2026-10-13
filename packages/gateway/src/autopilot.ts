/**
 * Autopilot's hands. The backend judges a pinned rule on every closed candle
 * and, when every predicate passes with nobody there, writes a proposal. It
 * cannot reach the venue, so this asks it what is waiting and opens each
 * proposal as a timed trade, through the same runner a person's timed trade
 * goes through, then says what became of it.
 *
 * Nothing is decided here. What to open (the market, the direction, the stake
 * and the time) is the backend's to state, and whether it may be opened is the
 * runner's: the same limits as any timed trade, testnet only, one trade per
 * market. This file adds no way around either.
 */

import type { TimedOpenResult, TimedRunner } from '@kanon/execution/timed-runner';
import type { Logger } from './log';

/** A proposal the backend is waiting on, and the timed trade it asks for. */
export interface AutopilotProposal {
  /** The backend's id for the proposal. It is the caller the trade is opened for. */
  proposalId: string;
  asset: string;
  direction: 'up' | 'down';
  /** Whole dollars. */
  stakeUsd: number;
  seconds: number;
}

export type AutopilotOutcome =
  | { proposalId: string; outcome: 'opened'; timedTradeId: string }
  /** Nothing is running for it. `reason` is the venue's or the runner's own words. */
  | { proposalId: string; outcome: 'not_opened'; reason: string };

/** The backend, as the poller needs it (`/autopilot/pending`, `/autopilot/report`). */
export interface AutopilotStore {
  /** The proposals not yet handed to the venue. Throws when the backend could not be read. */
  pending(): Promise<AutopilotProposal[]>;
  /** What became of one. After it the backend offers the proposal no more. Throws when it was not written. */
  report(outcome: AutopilotOutcome): Promise<void>;
}

export interface AutopilotPoller {
  start(): void;
  stop(): void;
}

type Timer = ReturnType<typeof setTimeout>;

/** How often the backend is asked what is waiting. A proposal waits a few of these at most before it is too old to open. */
export const AUTOPILOT_POLL_MS = 15_000;

export const AUTOPILOT_MESSAGES = {
  failed: 'The gateway could not open this trade. Nothing is running for it.',
} as const;

/** Why a trade was not opened, as the runner said it. */
function whyNot(result: Exclude<TimedOpenResult, { status: 'opened' }>): string {
  return result.status === 'refused' ? result.reason : result.message;
}

export function createAutopilotPoller(deps: {
  runner: Pick<TimedRunner, 'open'>;
  store: AutopilotStore;
  log: Logger;
  everyMs?: number;
  setTimer?: (run: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}): AutopilotPoller {
  const { runner, store, log } = deps;
  const everyMs = deps.everyMs ?? AUTOPILOT_POLL_MS;
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  let timer: Timer | null = null;
  let running = false;
  /** Which start the rounds now in hand belong to: one left over from before a stop sets no timer and opens nothing. */
  let started = 0;

  async function say(outcome: AutopilotOutcome): Promise<void> {
    try {
      await store.report(outcome);
    } catch (err) {
      // Not written: an opened trade is already recorded as the proposal's by its own row, and
      // one not opened is finished by the backend when it has waited too long.
      log({ level: 'error', event: 'autopilot_report_failed', proposalId: outcome.proposalId, outcome: outcome.outcome, error: message(err) });
    }
  }

  /** One proposal: open it, and say what became of it. */
  async function open(proposal: AutopilotProposal): Promise<void> {
    const { proposalId, ...request } = proposal;
    let result: TimedOpenResult;
    try {
      result = await runner.open(request, { proposalId });
    } catch (err) {
      log({ level: 'error', event: 'autopilot_open_failed', proposalId, error: message(err) });
      await say({ proposalId, outcome: 'not_opened', reason: AUTOPILOT_MESSAGES.failed });
      return;
    }
    log({ level: 'info', event: 'autopilot_open', ...request, proposalId, result: result.status });

    if (result.status === 'opened') {
      await say({ proposalId, outcome: 'opened', timedTradeId: result.trade.id });
      return;
    }
    // Another order held the lock, or another process is already opening this very proposal. Either
    // way nothing went out from here and there is nothing to say: the proposal stays as it was and
    // is asked for again on the next round, for as long as the backend goes on offering it.
    if (result.status === 'busy') return;
    // Everything else is final, an order that was sent and not heard of included: sending it a
    // second time could open the position twice.
    await say({ proposalId, outcome: 'not_opened', reason: whyNot(result) });
  }

  /** One round: everything waiting, one at a time. Never throws. */
  async function round(mine: number): Promise<void> {
    let waiting: AutopilotProposal[];
    try {
      waiting = await store.pending();
    } catch (err) {
      log({ level: 'error', event: 'autopilot_unreachable', error: message(err) });
      return;
    }
    for (const proposal of waiting) {
      if (!running || mine !== started) return;
      await open(proposal);
    }
  }

  function tick(mine: number): void {
    timer = null;
    // The next round is set only once this one is over, so two never overlap.
    void round(mine)
      .catch((err: unknown) => log({ level: 'error', event: 'autopilot_round_failed', error: message(err) }))
      .finally(() => {
        if (running && mine === started) timer = setTimer(() => tick(mine), everyMs);
      });
  }

  return {
    start() {
      if (running) return;
      running = true;
      started += 1;
      const mine = started;
      timer = setTimer(() => tick(mine), 0);
    },
    stop() {
      running = false;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
