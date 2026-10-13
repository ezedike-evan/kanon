import type { TimedCaller, TimedOpenResult, TimedRequest } from '@kanon/execution/timed-runner';
import {
  AUTOPILOT_MESSAGES,
  AUTOPILOT_POLL_MS,
  createAutopilotPoller,
  type AutopilotOutcome,
  type AutopilotProposal,
} from './autopilot';
import type { LogRecord } from './log';

/**
 * The poller against a faked backend and a faked runner, on a clock the test
 * moves. What is under test is the round: what is asked for, what is opened and
 * for whom, what is said afterwards, and that nothing it meets stops it.
 */

const BTC: AutopilotProposal = { proposalId: 'k57btc', asset: 'BTC/USD', direction: 'up', stakeUsd: 10, seconds: 900 };
const MON: AutopilotProposal = { proposalId: 'k57mon', asset: 'MON/USD', direction: 'down', stakeUsd: 10, seconds: 60 };

const opened = (id: string): TimedOpenResult => ({
  status: 'opened',
  trade: {
    id,
    asset: 'BTC/USD',
    direction: 'up',
    stakeUsd: 10,
    leverage: 5,
    seconds: 900,
    openedAt: 1_000_000,
    expiresAt: 1_900_000,
    size: { atoms: '60', decimals: 5 },
    entryPrice: { atoms: '828471', decimals: 1 },
  },
});

interface World {
  /** What the backend lists, or an error to throw instead. */
  waiting: AutopilotProposal[] | Error;
  /** What the runner answers for a proposal, by its id. Default: opened. */
  answers: Record<string, TimedOpenResult | Error>;
  reportFails: boolean;
  /** When set, every open waits on it: a test holds a round in the middle. */
  gate: Promise<void> | null;
}

function setup(over: Partial<World> = {}) {
  const world: World = { waiting: [], answers: {}, reportFails: false, gate: null, ...over };
  let clock = 0;
  const timers: Array<{ run: () => void; at: number; live: boolean }> = [];
  const asked: number[] = [];
  const opens: Array<[TimedRequest, TimedCaller]> = [];
  const reports: AutopilotOutcome[] = [];
  const logs: LogRecord[] = [];
  /** How many opens are in flight at once, at most. */
  let inFlight = 0;
  let mostInFlight = 0;

  const poller = createAutopilotPoller({
    runner: {
      open: async (request, caller) => {
        opens.push([request, caller]);
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await (world.gate ?? new Promise((resolve) => setTimeout(resolve, 0)));
        inFlight -= 1;
        const answer = world.answers['proposalId' in caller ? caller.proposalId : ''] ?? opened(`timed-${opens.length}`);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    store: {
      pending: async () => {
        asked.push(clock);
        if (world.waiting instanceof Error) throw world.waiting;
        return world.waiting;
      },
      report: async (outcome) => {
        if (world.reportFails) throw new Error('what became of it could not be written');
        reports.push(outcome);
      },
    },
    log: (entry) => logs.push(entry),
    setTimer: (run, ms) => {
      const timer = { run, at: clock + ms, live: true };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      (timer as unknown as { live: boolean }).live = false;
    },
  });

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** Moves the clock on and runs every timer that has come due, in order. */
  const advance = async (ms: number): Promise<void> => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = due.at;
      due.live = false;
      due.run();
      await flush();
    }
    clock = until;
    await flush();
  };
  const liveTimers = () => timers.filter((t) => t.live).length;
  const errors = () => logs.filter((l) => l.level === 'error').map((l) => l.event);
  return { world, poller, asked, opens, reports, logs, errors, advance, liveTimers, mostInFlight: () => mostInFlight };
}

describe('the round', () => {
  it('asks the backend as soon as it starts, and every fifteen seconds after', async () => {
    const t = setup();
    expect(AUTOPILOT_POLL_MS).toBe(15_000);
    t.poller.start();
    await t.advance(0);
    expect(t.asked).toEqual([0]);
    await t.advance(14_999);
    expect(t.asked).toEqual([0]);
    await t.advance(1);
    await t.advance(30_000);
    expect(t.asked).toEqual([0, 15_000, 30_000, 45_000]);
    expect(t.opens).toEqual([]);
    expect(t.reports).toEqual([]);
  });

  it('does not start twice, and asks nothing before it is started', async () => {
    const t = setup();
    await t.advance(60_000);
    expect(t.asked).toEqual([]);
    t.poller.start();
    t.poller.start();
    await t.advance(15_000);
    expect(t.asked).toEqual([60_000, 75_000]);
    expect(t.liveTimers()).toBe(1);
  });

  it('opens what is waiting through the runner, for the proposal and never for a token, and says it opened', async () => {
    const t = setup({ waiting: [BTC] });
    t.poller.start();
    await t.advance(0);
    // Exactly what the backend stated: its market, direction, stake and time. Nothing is chosen here.
    expect(t.opens).toEqual([[{ asset: 'BTC/USD', direction: 'up', stakeUsd: 10, seconds: 900 }, { proposalId: 'k57btc' }]]);
    expect(t.reports).toEqual([{ proposalId: 'k57btc', outcome: 'opened', timedTradeId: 'timed-1' }]);
    expect(t.errors()).toEqual([]);
  });

  it('opens one at a time, in the order the backend gave', async () => {
    const t = setup({ waiting: [BTC, MON] });
    t.poller.start();
    await t.advance(0);
    expect(t.opens.map(([, caller]) => caller)).toEqual([{ proposalId: 'k57btc' }, { proposalId: 'k57mon' }]);
    expect(t.mostInFlight()).toBe(1);
    expect(t.reports.map((r) => r.proposalId)).toEqual(['k57btc', 'k57mon']);
  });
});

describe('a proposal that was not opened', () => {
  it("is finished with the runner's own words, whatever they were", async () => {
    const cases: Array<[TimedOpenResult, string]> = [
      [{ status: 'refused', reason: 'BTC is in a timed trade on the shared account. It ends in about 40 seconds.' }, 'BTC is in a timed trade on the shared account. It ends in about 40 seconds.'],
      [{ status: 'refused', reason: 'The BTC market is closed.' }, 'The BTC market is closed.'],
      [{ status: 'unfilled', message: 'The venue forwarded the order and nothing filled. Nothing is left on the book.' }, 'The venue forwarded the order and nothing filled. Nothing is left on the book.'],
      [{ status: 'unavailable', message: 'Timed trades run on testnet only for now.' }, 'Timed trades run on testnet only for now.'],
      [{ status: 'unavailable', message: 'The trade opened but could not be recorded, so it was closed again.' }, 'The trade opened but could not be recorded, so it was closed again.'],
      [{ status: 'rate_limited', retryAfterMs: 1_000, message: 'Rate limit reached for now.' }, 'Rate limit reached for now.'],
    ];
    for (const [answer, reason] of cases) {
      const t = setup({ waiting: [BTC], answers: { k57btc: answer } });
      t.poller.start();
      await t.advance(0);
      expect(t.reports).toEqual([{ proposalId: 'k57btc', outcome: 'not_opened', reason }]);
    }
  });

  it('is never sent a second time once its order went out, even when the venue has not said what became of it', async () => {
    const sent: TimedOpenResult = { status: 'pending', message: 'The order was sent and the venue has not reported its result yet. It may still fill.' };
    const t = setup({ waiting: [BTC], answers: { k57btc: sent } });
    t.poller.start();
    await t.advance(0);
    expect(t.reports).toEqual([{ proposalId: 'k57btc', outcome: 'not_opened', reason: sent.message }]);
  });

  it('is left as it was when another order held the lock, and is tried again on the next round', async () => {
    const busy: TimedOpenResult = { status: 'busy', message: 'Another order is on its way to this account. Try again in a moment.' };
    const t = setup({ waiting: [BTC, MON], answers: { k57btc: busy } });
    t.poller.start();
    await t.advance(0);
    // Nothing is said about the one that never went out. The one behind it is still opened.
    expect(t.reports).toEqual([{ proposalId: 'k57mon', outcome: 'opened', timedTradeId: 'timed-2' }]);

    // The backend goes on offering it while it is young enough; the lock is free by the next round.
    t.world.waiting = [BTC];
    t.world.answers = {};
    await t.advance(15_000);
    expect(t.opens.map(([, caller]) => caller)).toEqual([{ proposalId: 'k57btc' }, { proposalId: 'k57mon' }, { proposalId: 'k57btc' }]);
    expect(t.reports.at(-1)).toEqual({ proposalId: 'k57btc', outcome: 'opened', timedTradeId: 'timed-3' });
  });

  it('is finished, not retried, when the runner itself throws', async () => {
    const t = setup({ waiting: [BTC, MON], answers: { k57btc: new Error('socket hang up') } });
    t.poller.start();
    await t.advance(0);
    expect(t.reports).toEqual([
      { proposalId: 'k57btc', outcome: 'not_opened', reason: AUTOPILOT_MESSAGES.failed },
      { proposalId: 'k57mon', outcome: 'opened', timedTradeId: 'timed-2' },
    ]);
    expect(t.errors()).toEqual(['autopilot_open_failed']);
  });
});

describe('what it survives', () => {
  it('logs a backend it cannot reach and asks again on the next round', async () => {
    const t = setup({ waiting: new Error('the waiting autopilot proposals could not be read') });
    t.poller.start();
    await t.advance(0);
    await t.advance(15_000);
    expect(t.asked).toEqual([0, 15_000]);
    expect(t.errors()).toEqual(['autopilot_unreachable', 'autopilot_unreachable']);
    expect(t.opens).toEqual([]);

    // The backend is back: the next round carries on as if nothing had happened.
    t.world.waiting = [BTC];
    await t.advance(15_000);
    expect(t.reports).toEqual([{ proposalId: 'k57btc', outcome: 'opened', timedTradeId: 'timed-1' }]);
  });

  it('logs an outcome it could not report, carries on with the rest, and keeps its rounds', async () => {
    const t = setup({ waiting: [BTC, MON], reportFails: true });
    t.poller.start();
    await t.advance(0);
    expect(t.opens).toHaveLength(2);
    expect(t.errors()).toEqual(['autopilot_report_failed', 'autopilot_report_failed']);
    t.world.waiting = [];
    await t.advance(15_000);
    expect(t.asked).toEqual([0, 15_000]);
  });

  it('logs no token and no key: it never holds either', async () => {
    const t = setup({ waiting: [BTC], answers: { k57btc: { status: 'refused', reason: 'The BTC market is closed.' } } });
    t.poller.start();
    await t.advance(0);
    expect(t.logs).toEqual([
      { level: 'info', event: 'autopilot_open', asset: 'BTC/USD', direction: 'up', stakeUsd: 10, seconds: 900, proposalId: 'k57btc', result: 'refused' },
    ]);
  });
});

describe('stopping', () => {
  it('asks nothing more once stopped', async () => {
    const t = setup({ waiting: [BTC] });
    t.poller.start();
    await t.advance(0);
    t.poller.stop();
    await t.advance(60_000);
    expect(t.asked).toEqual([0]);
    expect(t.liveTimers()).toBe(0);
  });

  it('opens nothing further in a round it is stopped in the middle of', async () => {
    let release = (): void => {};
    const t = setup({ waiting: [BTC, MON], gate: new Promise<void>((resolve) => (release = resolve)) });
    t.poller.start();
    const round = t.advance(0);
    await vi.waitFor(() => expect(t.opens).toHaveLength(1));
    // Stopped while the first open is still in flight. That one is finished and said; the next is not begun.
    t.poller.stop();
    release();
    await round;
    await t.advance(0);
    expect(t.opens.map(([, caller]) => caller)).toEqual([{ proposalId: 'k57btc' }]);
    expect(t.reports).toEqual([{ proposalId: 'k57btc', outcome: 'opened', timedTradeId: 'timed-1' }]);
    expect(t.liveTimers()).toBe(0);
    await t.advance(60_000);
    expect(t.asked).toEqual([0]);
  });

  it('runs one line of rounds, not two, when it is started again while a round is still in flight', async () => {
    let release = (): void => {};
    const t = setup({ waiting: [BTC, MON], gate: new Promise<void>((resolve) => (release = resolve)) });
    t.poller.start();
    const round = t.advance(0);
    await vi.waitFor(() => expect(t.opens).toHaveLength(1));
    t.poller.stop();
    t.poller.start();
    release();
    await round;
    await t.advance(0);
    // The round from before the stop opened nothing more and set no timer of its own.
    expect(t.liveTimers()).toBe(1);
    const asks = t.asked.length;
    await t.advance(15_000);
    expect(t.asked).toHaveLength(asks + 1);
    expect(t.mostInFlight()).toBe(1);
  });

  it('starts again after a stop', async () => {
    const t = setup();
    t.poller.start();
    await t.advance(0);
    t.poller.stop();
    t.poller.start();
    await t.advance(0);
    expect(t.asked).toEqual([0, 0]);
    expect(t.liveTimers()).toBe(1);
  });
});
