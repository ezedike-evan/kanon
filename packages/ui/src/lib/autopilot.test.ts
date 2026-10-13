import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUTOPILOT_DEMO,
  AUTOPILOT_DURATIONS,
  AUTOPILOT_STAKE_USD,
  AUTOPILOT_UNREAD,
  HANDOFF_WINDOW_MS,
  NO_REASON_RECORDED,
  VENUE_TERMS_UNREAD,
  autopilotFailureLine,
  autopilotNote,
  autopilotOffer,
  autopilotState,
  autopilotSummary,
  autopilotTerms,
  autopilotVenueTerms,
  candleLabel,
  holdSecondsFor,
  switchAutopilot,
  type AutopilotRow,
} from './autopilot';
import { SAMPLE_TIMED_STATE } from './timed-sample';
import type { TimedState } from './timed-types';

/**
 * Autopilot as the app says it: the fixed terms it restates from the backend,
 * what a person reads before turning it on, what the switch answers, and what
 * a row autopilot wrote is called.
 */

describe('the fixed terms, as the backend holds them', () => {
  // `packages/backend/convex/autopilotLogic.ts`. A change there is a change here, by hand.
  it('restates the stake, the holds and the hand-off window', () => {
    expect(AUTOPILOT_STAKE_USD).toBe(10);
    expect([...AUTOPILOT_DURATIONS]).toEqual([60, 300, 900, 3600]);
    expect(HANDOFF_WINDOW_MS).toBe(120_000);
  });

  it('states the same figures the backend file does, so the sheet cannot drift from what is enforced', () => {
    // Read as text, never imported: this package does not depend on the backend.
    const source = readFileSync(new URL('../../../backend/convex/autopilotLogic.ts', import.meta.url), 'utf8');
    const integer = (text: string | undefined) => (text === undefined ? null : Number(text.trim().replace(/_/g, '')));
    const constant = (name: string) => integer(source.match(new RegExp(`export const ${name} = ([\\d_]+);`))?.[1]);
    expect(constant('AUTOPILOT_STAKE_USD')).toBe(AUTOPILOT_STAKE_USD);
    expect(constant('HANDOFF_WINDOW_MS')).toBe(HANDOFF_WINDOW_MS);
    const durations = source.match(/export const AUTOPILOT_DURATIONS = \[([^\]]+)\] as const;/)?.[1];
    expect(durations?.split(',').map(integer)).toEqual([...AUTOPILOT_DURATIONS]);
  });

  it('holds for the shortest time on offer that is not shorter than one candle', () => {
    expect(holdSecondsFor(60)).toBe(60);
    expect(holdSecondsFor(120)).toBe(300);
    expect(holdSecondsFor(300)).toBe(300);
    expect(holdSecondsFor(900)).toBe(900);
    expect(holdSecondsFor(1800)).toBe(3600);
    expect(holdSecondsFor(3600)).toBe(3600);
  });

  it('holds for the longest time on offer when a candle is longer than all of them', () => {
    expect(holdSecondsFor(14_400)).toBe(3600);
    expect(holdSecondsFor(86_400)).toBe(3600);
  });

  it('names a candle the way a chart does', () => {
    expect(candleLabel(60)).toBe('1m');
    expect(candleLabel(900)).toBe('15m');
    expect(candleLabel(3600)).toBe('1h');
    expect(candleLabel(14_400)).toBe('4h');
    expect(candleLabel(86_400)).toBe('1d');
  });
});

describe('what it will do, before it is turned on', () => {
  const terms = autopilotTerms(900);
  const fact = (label: string) => terms.facts.find(([name]) => name === label)?.[1];

  it('states every fixed term as an exact figure', () => {
    expect(terms.holdSeconds).toBe(900);
    expect(terms.summary).toBe('Your rule is judged at the close of every 15m candle, with nobody pressing anything.');
    expect(terms.facts).toEqual([
      ['Checked', 'Every 15m candle close'],
      ['A pass opens', '$10 timed trade, Perpl testnet'],
      ['Held for', '15m, then closed by itself'],
      ['Most it can lose', '$10, ended early at that loss'],
      ['At a time', '1 trade for this rule'],
      ['A fail', 'Recorded as a refusal'],
      ['Turning it off', 'Withdraws anything not yet sent'],
    ]);
  });

  it('leaves no parameter to be discovered later', () => {
    const notes = terms.notes.join(' ');
    // The hold is a rule, not a coincidence: every hold on offer is named.
    expect(notes).toContain('the shortest of 1m, 5m, 15m and 1h that is not shorter than one candle');
    // No candle that has already closed is judged.
    expect(notes).toContain('The first candle judged is the next one to close.');
    // One at a time, and what a pass does meanwhile.
    expect(notes).toContain('A candle that passes while a trade is waiting or open records nothing.');
    // How long a pass may wait for the gateway.
    expect(notes).toContain('within 2 minutes is not opened');
    // What is sent is not the rule's own sizing.
    expect(notes).toContain("your rule's own size and stop stay on the proposal as evidence, and are not what is sent");
    // A trade already running is not unwound by the switch.
    expect(notes).toContain('A trade already running when you turn it off runs to its time');
    // No model, and whose funds.
    expect(notes).toContain('No model is involved.');
    expect(notes).toContain('It holds testnet funds, not yours.');
  });

  it('never apologises and never words a refusal as a fault', () => {
    const all = [terms.summary, ...terms.facts.flat(), ...terms.notes].join(' ');
    expect(all).not.toMatch(/sorry|unfortunately|oops|error|failed/i);
  });

  it('follows the rule onto another candle', () => {
    const minute = autopilotTerms(60);
    expect(minute.facts[0]).toEqual(['Checked', 'Every 1m candle close']);
    expect(minute.facts[2]).toEqual(['Held for', '1m, then closed by itself']);
    // A two-minute candle is held for five: the shortest on offer that is not shorter.
    expect(autopilotTerms(120).facts[2]).toEqual(['Held for', '5m, then closed by itself']);
  });

  it('says so when a candle is longer than every hold on offer', () => {
    const day = autopilotTerms(86_400);
    expect(day.holdSeconds).toBe(3600);
    expect(day.facts[0]).toEqual(['Checked', 'Every 1d candle close']);
    expect(day.facts[2]).toEqual(['Held for', '1h, then closed by itself']);
    expect(day.notes.join(' ')).toContain('A 1d candle is longer than all of them, so it is 1h.');
    expect(terms.notes.join(' ')).not.toContain('longer than all of them');
    expect(fact('Held for')).toBe('15m, then closed by itself');
  });

  it('says in one line what the switch is doing, or would do', () => {
    expect(autopilotSummary(900, true)).toBe('Judging every 15m close: a pass opens $10 for 15m.');
    expect(autopilotSummary(900, false)).toBe('Off. On, it judges every 15m close and a pass opens $10 for 15m.');
    expect(autopilotSummary(14_400, true)).toBe('Judging every 4h close: a pass opens $10 for 1h.');
  });
});

describe("the venue's own terms", () => {
  const ready: TimedState = {
    status: 'ready',
    venue: 'perpl',
    network: 'testnet',
    limits: { stakesUsd: [10, 25, 50, 100], durations: [60, 300, 900, 3600], maxLeverage: 5, slippageBps: 100 },
    markets: [
      { asset: 'BTC/USD', open: true, leverage: 5, busy: null },
      { asset: 'ETH/USD', open: true, leverage: 3, busy: { until: null } },
    ],
  };

  it('is the size and the slippage bound the server said, in Predict\'s own words', () => {
    expect(autopilotVenueTerms(ready, 'BTC/USD', 900)).toEqual({
      status: 'known',
      facts: [
        ['Size', '$50, 5x the stake'],
        ['Max slippage', '1.00% in and out'],
      ],
    });
    // A market's own leverage, read for the rule's own pair however it is spelled.
    expect(autopilotVenueTerms(ready, 'eth / usd', 300)).toEqual({
      status: 'known',
      facts: [
        ['Size', '$30, 3x the stake'],
        ['Max slippage', '1.00% in and out'],
      ],
    });
  });

  it('is the shape of its rows while the state is being read', () => {
    expect(autopilotVenueTerms({ status: 'loading' }, 'BTC/USD', 900)).toEqual({ status: 'loading' });
  });

  it('says where they are instead of inventing them when they cannot be read', () => {
    const unread = { status: 'unknown', note: VENUE_TERMS_UNREAD };
    expect(autopilotVenueTerms({ status: 'unavailable', message: 'Trading is not connected.' }, 'BTC/USD', 900)).toEqual(unread);
    expect(autopilotVenueTerms(ready, null, 900)).toEqual(unread);
    // The signed-out sample is no server's answer: its leverage is never passed off as the venue's.
    expect(SAMPLE_TIMED_STATE.status).toBe('ready');
    expect(autopilotVenueTerms(SAMPLE_TIMED_STATE, 'BTC/USD', 900)).toEqual(unread);
  });

  it('says a pass would not be opened when the venue lists no such market', () => {
    const out = autopilotVenueTerms(ready, 'DOGE/USD', 900);
    expect(out.status).toBe('unlisted');
    expect(out).toMatchObject({ note: expect.stringContaining('Perpl lists no DOGE/USD market for timed trades right now.') });
    expect(out).toMatchObject({ note: expect.stringContaining('recorded as not opened') });
  });

  it('says a pass would not be opened when the stake or the hold is not on offer', () => {
    const noTen: TimedState = { ...ready, limits: { ...ready.limits, stakesUsd: [25, 50] } };
    expect(autopilotVenueTerms(noTen, 'BTC/USD', 900)).toMatchObject({
      status: 'unlisted',
      note: expect.stringContaining('does not offer $10 for 15m right now'),
    });
    const noHour: TimedState = { ...ready, limits: { ...ready.limits, durations: [60, 300, 900] } };
    expect(autopilotVenueTerms(noHour, 'BTC/USD', 3600).status).toBe('unlisted');
  });
});

describe('which rules it is offered for', () => {
  it('is turned on and off for the rule that is enforced', () => {
    expect(autopilotOffer('pinned', false)).toBe('toggle');
    expect(autopilotOffer('pinned', true)).toBe('toggle');
    expect(autopilotOffer('cooling_off', false)).toBe('toggle');
    expect(autopilotOffer('cooling_off', true)).toBe('toggle');
  });

  it('is never offered for a draft: nothing judges one', () => {
    expect(autopilotOffer('draft', false)).toBe('none');
    expect(autopilotOffer('draft', true)).toBe('none');
  });

  it('keeps the way to turn it off on a rule that was replaced while it was on, and offers nothing else there', () => {
    expect(autopilotOffer('superseded', true)).toBe('off_only');
    expect(autopilotOffer('superseded', false)).toBe('none');
  });

  it('cannot be turned on for a rule whose terms cannot be stated', () => {
    expect(autopilotOffer('pinned', false, false)).toBe('none');
    expect(autopilotOffer('pinned', true, false)).toBe('off_only');
  });
});

describe('throwing the switch', () => {
  const calls: Array<{ strategyId: string; on: boolean }> = [];
  const answering = (answer: unknown) => async (args: { strategyId: string; on: boolean }) => {
    calls.push(args);
    return answer;
  };

  it('sends the rule and the side, and reports what the server says the switch is now', async () => {
    calls.length = 0;
    const out = await switchAutopilot({ userId: 'u1', strategyId: 's1', on: true, setAutopilot: answering({ autopilot: true }) });
    expect(out).toEqual({ ok: true, on: true });
    expect(calls).toEqual([{ strategyId: 's1', on: true }]);
    expect(
      await switchAutopilot({ userId: 'u1', strategyId: 's1', on: false, setAutopilot: answering({ autopilot: false }) }),
    ).toEqual({ ok: true, on: false });
  });

  it('sends nothing signed out, and says to sign in', async () => {
    calls.length = 0;
    const out = await switchAutopilot({ userId: undefined, strategyId: 's1', on: true, setAutopilot: answering({ autopilot: true }) });
    expect(out).toEqual({ ok: false, reason: 'demo', message: AUTOPILOT_DEMO });
    expect(calls).toEqual([]);
  });

  it('sends nothing for no rule', async () => {
    calls.length = 0;
    const none = await switchAutopilot({ userId: 'u1', strategyId: 'none', on: true, setAutopilot: answering({ autopilot: true }) });
    expect(none).toMatchObject({ ok: false, reason: 'no_rule' });
    expect(calls).toEqual([]);
  });

  it('turns a throw into one calm sentence, and never rejects', async () => {
    const throwing = (message: string) => async () => {
      throw new Error(message);
    };
    const on = await switchAutopilot({ userId: 'u1', strategyId: 's1', on: true, setAutopilot: throwing('Server Error') });
    expect(on).toEqual({
      ok: false,
      reason: 'failed',
      message: 'Autopilot was not turned on. Nothing changed: your rule is enforced as before.',
    });
    // A switch that would not turn off is still on, and that is what has to be said.
    const off = await switchAutopilot({ userId: 'u1', strategyId: 's1', on: false, setAutopilot: throwing('Server Error') });
    expect(off).toMatchObject({ ok: false, message: 'Autopilot is still on: the request to turn it off did not go through. Try again.' });
  });

  it('does not take an answer that does not say for a yes', async () => {
    for (const answer of [{}, null, undefined, { autopilot: 'yes' }]) {
      expect(await switchAutopilot({ userId: 'u1', strategyId: 's1', on: true, setAutopilot: answering(answer) })).toEqual({
        ok: false,
        reason: 'failed',
        message: AUTOPILOT_UNREAD,
      });
    }
  });

  it("reads the server's refusal for what it means, and never shows its stack", () => {
    const draft = new Error(
      '[CONVEX M(strategies:setAutopilot)] [Request ID: 6f1] Server Error\nUncaught Error: autopilot runs a pinned rule; pin this one first\n    at handler (../convex/strategies.ts:308:12)',
    );
    expect(autopilotFailureLine(draft, true)).toBe('Autopilot runs a pinned rule. Pin this one first.');
    // A server that has not been given autopilot yet.
    const missing = new Error("Could not find public function for 'strategies:setAutopilot'. Did you forget to run `npx convex dev`?");
    expect(autopilotFailureLine(missing, true)).toBe('This server does not run autopilot yet. Nothing changed.');
    for (const line of [autopilotFailureLine(draft, true), autopilotFailureLine(missing, false), autopilotFailureLine('boom', true)]) {
      expect(line).not.toMatch(/CONVEX|Request ID|handler|Uncaught|sorry|oops/i);
    }
  });
});

describe('a setup autopilot judged', () => {
  const row = (over: Partial<AutopilotRow>): AutopilotRow => ({ status: 'proposed', origin: 'autopilot', ...over });

  it('is nothing for a setup its owner put to the rule', () => {
    expect(autopilotState({ status: 'proposed' })).toBeNull();
    expect(autopilotNote({ status: 'executed' })).toBeNull();
    expect(autopilotNote({ status: 'refused' })).toBeNull();
  });

  it('waits for the gateway, and says for how long it may', () => {
    const note = autopilotNote(row({ status: 'proposed', handoff: 'pending', stakeUsd: 10, holdSeconds: 900 }));
    expect(note).toEqual({
      state: 'waiting',
      label: 'WAITING FOR THE GATEWAY',
      line: 'Every predicate passed at a candle close. The gateway has 2 minutes from then to begin opening it. After that nothing is sent.',
      sent: '$10 · 15m',
      timedTradeId: null,
      reason: null,
    });
  });

  it('leads to its timed trade once one was opened', () => {
    const note = autopilotNote(
      row({ status: 'executed', handoff: 'opened', stakeUsd: 10, holdSeconds: 300, timedTradeId: 'tt9' }),
    );
    expect(note).toMatchObject({ state: 'opened', label: 'OPENED', sent: '$10 · 5m', timedTradeId: 'tt9', reason: null });
    expect(note?.line).toBe('Every predicate passed at a candle close, and a timed trade was opened for it.');
  });

  it("shows why nothing was opened in the server's own words, unchanged", () => {
    const reason = 'Autopilot was turned off before this was opened. Nothing was sent.';
    const note = autopilotNote(row({ status: 'undone', handoff: 'not_opened', stakeUsd: 10, holdSeconds: 900, handoffReason: reason }));
    expect(note).toMatchObject({ state: 'not_opened', label: 'NOT OPENED', reason, timedTradeId: null, sent: '$10 · 15m' });
    // One of the server's reasons is an order it never heard back about, so this does not claim nothing was sent.
    expect(note?.line).toBe('Every predicate passed at a candle close. No timed trade was recorded for it.');
    expect(note?.line).not.toMatch(/nothing was (sent|opened)/i);
    // It is not an undo, and it is not a fault.
    expect(`${note?.label} ${note?.line}`).not.toMatch(/undone|undid|error|failed|sorry/i);
  });

  it('says no reason was recorded instead of leaving the place empty', () => {
    expect(autopilotNote(row({ status: 'undone', handoff: 'not_opened' }))?.reason).toBe(NO_REASON_RECORDED);
    expect(autopilotNote(row({ status: 'undone', handoff: 'not_opened', handoffReason: '  ' }))?.reason).toBe(NO_REASON_RECORDED);
  });

  it('is a refusal like any other, with nothing sent and nothing to link to', () => {
    const note = autopilotNote(row({ status: 'refused' }));
    expect(note).toEqual({
      state: 'refused',
      label: 'REFUSED',
      line: 'Judged at a candle close, with nobody pressing anything.',
      sent: null,
      timedTradeId: null,
      reason: null,
    });
  });

  it('reads the hand-off before the status, and the status when the hand-off is not there', () => {
    // A row the list read before the gateway's report landed.
    expect(autopilotState(row({ status: 'proposed' }))).toBe('waiting');
    expect(autopilotState(row({ status: 'executed' }))).toBe('opened');
    expect(autopilotState(row({ status: 'undone' }))).toBe('not_opened');
    expect(autopilotState(row({ status: 'proposed', handoff: 'opened' }))).toBe('opened');
  });

  it('does not say what was sent when the row does not', () => {
    expect(autopilotNote(row({ status: 'proposed', handoff: 'pending' }))?.sent).toBeNull();
    expect(autopilotNote(row({ status: 'proposed', handoff: 'pending', stakeUsd: 10 }))?.sent).toBeNull();
  });

  it('never links a timed trade to a setup that has none', () => {
    expect(autopilotNote(row({ status: 'proposed', handoff: 'pending', timedTradeId: 'tt1' }))?.timedTradeId).toBeNull();
    expect(autopilotNote(row({ status: 'executed', handoff: 'opened' }))?.timedTradeId).toBeNull();
  });
});
