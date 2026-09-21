import { describe, expect, it } from 'vitest';
import {
  MESSAGE_LIMIT,
  buildThread,
  canSend,
  charCount,
  classifyFailure,
  clampText,
  composerHeight,
  draftLines,
  draftSummary,
  isNearBottom,
  lastUserText,
  parseDraftLine,
  pickSuggestions,
  previewLines,
  sendIntent,
  starterToSuggestion,
} from './ai-chat';

const turns = [
  { from: 'KANON', at: '14:29', text: 'Anything about where liquidity should be taken first?' },
  { from: 'YOU', at: '14:31', text: "Only take longs after a sweep of the previous day's low." },
  { from: 'KANON', at: '14:31', text: 'Compiled.' },
];

describe('clampText', () => {
  it('leaves short text alone', () => {
    expect(clampText('long BTC', 20)).toBe('long BTC');
  });

  it('cuts to the limit', () => {
    expect(clampText('x'.repeat(500))).toHaveLength(MESSAGE_LIMIT);
  });

  it('does not split an emoji in half', () => {
    // Each of these is two UTF-16 units. slice(0, 3) would leave a lone surrogate.
    const out = clampText('😀😀😀', 2);
    expect(out).toBe('😀😀');
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('counts a person-visible character once', () => {
    expect(charCount('😀a')).toBe(2);
  });
});

describe('buildThread', () => {
  it('maps the roles and keeps the timestamps', () => {
    const items = buildThread({ transcript: turns, sample: false, hasSpec: false });
    expect(items.map((i) => (i.kind === 'message' ? i.role : i.kind))).toEqual([
      'assistant',
      'user',
      'assistant',
    ]);
    expect(items[1]).toMatchObject({ at: '14:31', text: expect.stringContaining('sweep') });
  });

  it('embeds the draft only in the newest assistant turn, and only when one exists', () => {
    const items = buildThread({ transcript: turns, sample: false, hasSpec: true });
    const embeds = items.filter((i) => i.kind === 'message' && i.embedDraft);
    expect(embeds).toHaveLength(1);
    expect(items[2]).toMatchObject({ embedDraft: true });
    const none = buildThread({ transcript: turns, sample: false, hasSpec: false });
    expect(none.some((i) => i.kind === 'message' && i.embedDraft)).toBe(false);
  });

  it('does not embed while the newest turn is the user waiting on a reply', () => {
    const waiting = [...turns, { from: 'YOU', at: '14:40', text: 'Tighten the gap' }];
    const items = buildThread({ transcript: waiting, sample: false, hasSpec: true });
    expect(items.some((i) => i.kind === 'message' && i.embedDraft)).toBe(false);
  });

  it('captions a sample conversation, and an empty one stays empty', () => {
    expect(buildThread({ transcript: turns, sample: true, hasSpec: true })[0]).toMatchObject({
      kind: 'sample',
    });
    expect(buildThread({ transcript: [], sample: true, hasSpec: false })).toEqual([]);
  });

  it('gives every item a unique, stable key', () => {
    const a = buildThread({ transcript: turns, sample: true, hasSpec: true });
    const b = buildThread({ transcript: [...turns, turns[1]!], sample: true, hasSpec: true });
    expect(new Set(a.map((i) => i.key)).size).toBe(a.length);
    expect(new Set(b.map((i) => i.key)).size).toBe(b.length);
    // Appending does not rename what was already there.
    expect(b.slice(0, a.length).map((i) => i.key)).toEqual(a.map((i) => i.key));
  });
});

describe('lastUserText', () => {
  it('finds the newest thing the user said', () => {
    expect(lastUserText(turns)).toContain('previous day');
    expect(lastUserText([turns[0]!])).toBeNull();
    expect(lastUserText([])).toBeNull();
  });
});

describe('the draft', () => {
  const lines = [
    { text: 'direction: long', changed: false },
    { text: 'require: sweep_prev_day_low', changed: true },
    { text: 'sweep_lookback: 1D', changed: true },
    { text: 'risk_per_trade: 0.50%', changed: false },
    { text: 'series: BTC/USD · pyth', changed: false },
  ];

  it('splits a line at its first colon-space', () => {
    expect(parseDraftLine('sweep_lookback: 1D')).toEqual({ name: 'sweep_lookback', value: '1D' });
    expect(parseDraftLine('series: BTC/USD · pyth: usd')).toEqual({
      name: 'series',
      value: 'BTC/USD · pyth: usd',
    });
    expect(parseDraftLine('bare value')).toEqual({ name: '', value: 'bare value' });
  });

  it('flags a line as inferred when the compiler chose its value', () => {
    const view = draftLines(lines, [{ name: 'sweep_lookback' }, { name: 'risk_per_trade' }]);
    expect(view.filter((l) => l.inferred).map((l) => l.name)).toEqual(['sweep_lookback', 'risk_per_trade']);
    expect(view.find((l) => l.name === 'direction')?.inferred).toBe(false);
  });

  it('appends a chosen default the spec lines do not carry, so no parameter is hidden', () => {
    const view = draftLines(lines, [
      { name: 'sweep_lookback', value: '1D' },
      { name: 'swing_lookback', value: '5 candles' },
    ]);
    expect(view).toHaveLength(lines.length + 1);
    expect(view[view.length - 1]).toMatchObject({ name: 'swing_lookback', value: '5 candles', inferred: true });
    // A default with no value to show is not invented.
    expect(draftLines(lines, [{ name: 'gap' }])).toHaveLength(lines.length);
  });

  it('never flags an unnamed line', () => {
    expect(draftLines([{ text: 'loose', changed: false }], [{ name: '' }])[0]?.inferred).toBe(false);
  });

  it('summarises the counts the dock shows', () => {
    const view = draftLines(lines, [{ name: 'sweep_lookback' }]);
    expect(draftSummary(view)).toEqual({ total: 5, changed: 2, defaults: 1 });
  });

  it('previews what changed first, then fills from the top of the spec', () => {
    const view = draftLines(lines, []);
    expect(previewLines(view, 4).map((l) => l.name)).toEqual([
      'require',
      'sweep_lookback',
      'direction',
      'risk_per_trade',
    ]);
    expect(previewLines(view, 1)).toHaveLength(1);
    expect(previewLines([], 4)).toEqual([]);
  });
});

describe('classifyFailure', () => {
  it('names a rate limit as pacing, not as a fault', () => {
    const f = classifyFailure('Rate limited by the DashScope API. Try again shortly.');
    expect(f.kind).toBe('rate_limited');
    expect(f.body).not.toMatch(/DashScope/);
  });

  it('names a compiled-but-unsaved draft', () => {
    expect(classifyFailure('The draft compiled but could not be saved.').kind).toBe('unsaved');
  });

  it('names a request that did not resolve to a rule', () => {
    expect(classifyFailure('The compiler declined to process this request.').kind).toBe('unresolved');
    expect(classifyFailure('Could not produce a valid spec after 3 attempts.').kind).toBe('unresolved');
  });

  it('falls back to unreachable for anything else, and for nothing', () => {
    expect(classifyFailure('Compiler request failed: fetch failed').kind).toBe('unreachable');
    expect(classifyFailure(undefined).kind).toBe('unreachable');
  });

  it('never apologises or sounds an alarm, and always says the words are kept where they are', () => {
    for (const e of ['rate limit', 'could not be saved', 'declined', 'boom', undefined]) {
      const f = classifyFailure(e);
      expect(`${f.title} ${f.body}`).not.toMatch(/sorry|oops|error|failed|unfortunately|!/i);
    }
    expect(classifyFailure('boom').body).toMatch(/kept/);
  });
});

describe('pickSuggestions', () => {
  it('offers four prompts, one per pattern, before any repeat', () => {
    const picks = pickSuggestions({ hasSpec: false });
    expect(picks).toHaveLength(4);
    expect(new Set(picks.map((p) => p.tag)).size).toBe(4);
    expect(picks.map((p) => p.tag)).toEqual(
      expect.arrayContaining(['Liquidity sweep', 'Break of structure', 'Fair value gap', 'Risk']),
    );
  });

  it('is deterministic', () => {
    expect(pickSuggestions({ hasSpec: false })).toEqual(pickSuggestions({ hasSpec: false }));
  });

  it('drops anything the user already sent, ignoring case and spacing', () => {
    const picks = pickSuggestions({
      hasSpec: false,
      sent: ["  only take longs after a SWEEP of the previous day's low  "],
    });
    expect(picks.some((p) => p.id === 'sweep')).toBe(false);
    expect(picks).toHaveLength(3);
  });

  it('moves to refinements once a draft exists', () => {
    const picks = pickSuggestions({ hasSpec: true, count: 3 });
    expect(picks).toHaveLength(3);
    expect(picks.every((p) => p.id.startsWith('r-'))).toBe(true);
  });

  it('keeps onboarding starters the compiler can express and drops the ones it cannot', () => {
    expect(starterToSuggestion('Max 0.5% risk')).toMatchObject({ tag: 'Risk', text: 'Max 0.5% risk' });
    expect(starterToSuggestion('Stop losses only')).not.toBeNull();
    expect(starterToSuggestion('No trades before 09:30')).toBeNull();
    const picks = pickSuggestions({
      hasSpec: false,
      starters: ['No trades before 09:30', 'Max 0.5% risk'],
      count: 10,
    });
    expect(picks.some((p) => /09:30/.test(p.text))).toBe(false);
    expect(picks.some((p) => p.text === 'Max 0.5% risk')).toBe(true);
  });

  it('returns nothing rather than repeating when everything was already said', () => {
    const all = pickSuggestions({ hasSpec: false, count: 10 }).map((p) => p.text);
    expect(pickSuggestions({ hasSpec: false, sent: all })).toEqual([]);
  });
});

describe('sendIntent', () => {
  it('ignores an empty or whitespace-only message', () => {
    expect(sendIntent({ text: '', compiling: false, signedIn: true })).toBe('ignore');
    expect(sendIntent({ text: '  \n ', compiling: false, signedIn: true })).toBe('ignore');
  });

  it('ignores a press while a compile is running', () => {
    expect(sendIntent({ text: 'hello', compiling: true, signedIn: true })).toBe('ignore');
  });

  it('sends when signed in, and asks to sign in when not', () => {
    expect(sendIntent({ text: 'hello', compiling: false, signedIn: true })).toBe('send');
    expect(sendIntent({ text: 'hello', compiling: false, signedIn: false })).toBe('sign_in');
  });

  it('enables the button exactly when a press would do something', () => {
    expect(canSend({ text: 'x', compiling: false })).toBe(true);
    expect(canSend({ text: '', compiling: false })).toBe(false);
    expect(canSend({ text: 'x', compiling: true })).toBe(false);
  });
});

describe('composerHeight', () => {
  it('grows a line at a time and stops at the ceiling', () => {
    expect(composerHeight(1)).toBe(40);
    expect(composerHeight(2)).toBe(62);
    expect(composerHeight(40)).toBe(116);
    expect(composerHeight(0)).toBe(40);
  });
});

describe('isNearBottom', () => {
  it('follows a reader who is at the bottom', () => {
    expect(isNearBottom({ offset: 600, viewport: 400, content: 1000 })).toBe(true);
    expect(isNearBottom({ offset: 520, viewport: 400, content: 1000 })).toBe(true);
  });

  it('leaves alone a reader who scrolled up', () => {
    expect(isNearBottom({ offset: 100, viewport: 400, content: 1000 })).toBe(false);
  });

  it('treats content shorter than the viewport as at the bottom', () => {
    expect(isNearBottom({ offset: 0, viewport: 600, content: 300 })).toBe(true);
  });
});
