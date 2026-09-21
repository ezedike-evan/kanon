/**
 * The strategy chat, as pure logic.
 *
 * The screen owns layout and gestures; everything that can be decided without a
 * renderer is decided here, so it can be tested without one: how a transcript
 * becomes a thread, how a draft line is read, what a failure is called, which
 * prompts are worth offering, and what pressing send should do.
 *
 * Nothing in this file talks to a model. The model lives behind
 * `sendCompilerMessage`; this file only shapes what comes back.
 */

/** One turn as the data layer stores it. `from` is `YOU` or `KANON`. */
export interface TurnLike {
  from: string;
  at: string;
  text: string;
}

/** A user message is capped so a pasted essay cannot become a prompt. */
export const MESSAGE_LIMIT = 400;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Cuts to `limit` characters as a person counts them. `String.slice` counts UTF-16
 * units and can split an emoji or a combining mark in half, leaving a lone
 * surrogate that a JSON body or a font then renders as a box.
 */
export function clampText(text: string, limit: number = MESSAGE_LIMIT): string {
  if (text.length <= limit) return text;
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join('');
}

/** How many characters a person would count. Used for the counter, not for the cap. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

export type ChatRole = 'user' | 'assistant';

export type ThreadItem =
  /** A caption above a scripted conversation, so a fixture is never mistaken for the user's own. */
  | { kind: 'sample'; key: string }
  | {
      kind: 'message';
      key: string;
      role: ChatRole;
      text: string;
      at: string;
      /**
       * The message carries a compact card of the draft it produced. Only the newest
       * assistant turn does: the data layer keeps one draft, not one per turn, so an
       * older turn showing today's draft would be a false claim about the past.
       */
      embedDraft: boolean;
    };

export function roleOf(turn: TurnLike): ChatRole {
  return turn.from === 'YOU' ? 'user' : 'assistant';
}

export function buildThread(input: {
  transcript: readonly TurnLike[];
  /** Fixtures, not the user's own conversation. */
  sample: boolean;
  /** A compiled draft exists. */
  hasSpec: boolean;
}): ThreadItem[] {
  const { transcript, sample, hasSpec } = input;
  const last = transcript.length - 1;
  const items: ThreadItem[] = sample && transcript.length > 0 ? [{ kind: 'sample', key: 'sample' }] : [];
  transcript.forEach((turn, i) => {
    const role = roleOf(turn);
    items.push({
      kind: 'message',
      // Append-only, so position is a stable identity and a re-render does not remount a bubble.
      key: `${i}-${role}`,
      role,
      text: turn.text,
      at: turn.at,
      embedDraft: hasSpec && role === 'assistant' && i === last,
    });
  });
  return items;
}

/** The last thing the user said, for a retry. Null before they have said anything. */
export function lastUserText(transcript: readonly TurnLike[]): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const turn = transcript[i];
    if (turn && roleOf(turn) === 'user') return turn.text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

export interface DraftLineView {
  /** Stable for the line's identity across turns: position plus name. */
  id: string;
  name: string;
  value: string;
  /** This turn changed it. It fades up in `signal`. */
  changed: boolean;
  /** The compiler chose the value; the user did not say it. Always surfaced. */
  inferred: boolean;
}

/** `sweep_lookback: 1D` -> name `sweep_lookback`, value `1D`. A line with no colon is all value. */
export function parseDraftLine(text: string): { name: string; value: string } {
  const at = text.indexOf(': ');
  if (at <= 0) return { name: '', value: text };
  return { name: text.slice(0, at), value: text.slice(at + 2) };
}

/**
 * The draft as rows. A default the compiler chose that the spec lines do not
 * carry is appended, marked, rather than left out: a parameter the user cannot
 * see is the failure this product is built to prevent.
 */
export function draftLines(
  lines: ReadonlyArray<{ text: string; changed: boolean }>,
  inferred: ReadonlyArray<{ name: string; value?: string }>,
): DraftLineView[] {
  const defaults = new Set(inferred.map((d) => d.name));
  const rows = lines.map((line, i): DraftLineView => {
    const { name, value } = parseDraftLine(line.text);
    return {
      id: `${i}-${name}`,
      name,
      value,
      changed: line.changed,
      inferred: name !== '' && defaults.has(name),
    };
  });
  const shown = new Set(rows.map((r) => r.name));
  for (const d of inferred) {
    if (d.name === '' || d.value === undefined || shown.has(d.name)) continue;
    shown.add(d.name);
    rows.push({ id: `${rows.length}-${d.name}`, name: d.name, value: d.value, changed: false, inferred: true });
  }
  return rows;
}

export interface DraftSummary {
  total: number;
  changed: number;
  defaults: number;
}

export function draftSummary(lines: readonly DraftLineView[]): DraftSummary {
  return {
    total: lines.length,
    changed: lines.filter((l) => l.changed).length,
    defaults: lines.filter((l) => l.inferred).length,
  };
}

/**
 * The lines an in-thread card shows: what this turn changed first, then the rest
 * to fill up to `max`, in spec order. A card of four lines is a glance; the full
 * draft is one tap away in the dock.
 */
export function previewLines(lines: readonly DraftLineView[], max = 4): DraftLineView[] {
  const changed = lines.filter((l) => l.changed);
  if (changed.length >= max) return changed.slice(0, max);
  const rest = lines.filter((l) => !l.changed);
  return [...changed, ...rest.slice(0, max - changed.length)];
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

export type FailureKind = 'rate_limited' | 'unsaved' | 'unresolved' | 'unreachable';

export interface FailureView {
  kind: FailureKind;
  title: string;
  body: string;
}

/**
 * A neutral name for a compile that did not produce a draft. The raw error can
 * name a vendor or an HTTP status, which is a log line and not something to put
 * in front of a trader; the words the user typed are always kept, and the copy
 * says so instead of apologising.
 */
export function classifyFailure(error: string | undefined): FailureView {
  const text = error ?? '';
  if (/rate.?limit|too many|\b429\b|quota/i.test(text)) {
    return {
      kind: 'rate_limited',
      title: 'Compiles are paced',
      body: 'The limit on compiles was reached for now. Your words are kept. Retry in a minute.',
    };
  }
  if (/could not be saved/i.test(text)) {
    return {
      kind: 'unsaved',
      title: 'Compiled, not saved',
      body: 'The draft compiled but did not save, so nothing is kept yet. Retry to save it.',
    };
  }
  if (/declined|valid spec|attempts/i.test(text)) {
    return {
      kind: 'unresolved',
      title: 'Did not resolve to a rule',
      body: 'That did not come out as something a contract can check. Name the pattern and one number, then retry.',
    };
  }
  return {
    kind: 'unreachable',
    title: 'No answer from the compiler',
    body: 'The request did not come back. Your words are kept. Retry when ready.',
  };
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export interface Suggestion {
  id: string;
  /** The pattern it exercises, in the trader's own vocabulary. */
  tag: string;
  text: string;
}

/**
 * The first prompts, in SMC language. Each one lands on a predicate the spec
 * can express (break of structure, fair value gap, liquidity sweep) or on the
 * risk block, so the first tap always compiles.
 */
export const STARTER_PROMPTS: readonly Suggestion[] = [
  { id: 'sweep', tag: 'Liquidity sweep', text: "Only take longs after a sweep of the previous day's low" },
  { id: 'bos', tag: 'Break of structure', text: 'Go long after a bullish break of structure on the 15m' },
  { id: 'fvg', tag: 'Fair value gap', text: 'Require a fair value gap of at least 0.15% after the break' },
  { id: 'risk', tag: 'Risk', text: 'Risk 0.5% per trade with a stop 0.5% away' },
];

/** Once a draft exists the useful next message changes one thing about it. */
export const REFINE_PROMPTS: readonly Suggestion[] = [
  { id: 'r-gap', tag: 'Fair value gap', text: 'Make the fair value gap at least 0.25%' },
  { id: 'r-tf', tag: 'Timeframe', text: 'Move everything to the 1h timeframe' },
  { id: 'r-sweep', tag: 'Liquidity sweep', text: 'Also require a sweep of the prior swing high' },
  { id: 'r-risk', tag: 'Risk', text: 'Cut the risk to 0.25% per trade' },
  { id: 'r-bos', tag: 'Break of structure', text: 'Widen the swing lookback to 8 candles' },
];

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * An onboarding starter, if the compiler can do something with it. "No trades
 * before 09:30" is a clock rule and the spec is arithmetic over price, so it
 * would be refused; offering it wastes the first tap. Risk and stop starters
 * do map onto the risk block.
 */
export function starterToSuggestion(starter: string): Suggestion | null {
  if (/risk|stop/i.test(starter)) {
    return { id: `starter-${normalise(starter)}`, tag: 'Risk', text: starter };
  }
  return null;
}

/**
 * Which prompts to offer. Prompts the user already sent are dropped, and one per
 * pattern comes first so the four are four different ideas, not four takes on
 * the same one. Deterministic: the same thread offers the same prompts.
 */
export function pickSuggestions(input: {
  starters?: readonly string[];
  /** What the user has already said. */
  sent?: readonly string[];
  hasSpec: boolean;
  count?: number;
}): Suggestion[] {
  const { starters = [], sent = [], hasSpec, count = 4 } = input;
  const said = new Set(sent.map(normalise));
  const pool: Suggestion[] = hasSpec
    ? [...REFINE_PROMPTS]
    : [
        ...STARTER_PROMPTS,
        ...starters.map(starterToSuggestion).filter((s): s is Suggestion => s !== null),
      ];
  const fresh = pool.filter((s) => !said.has(normalise(s.text)));

  const seenTags = new Set<string>();
  const firstOfEachTag: Suggestion[] = [];
  const repeats: Suggestion[] = [];
  for (const s of fresh) {
    if (seenTags.has(s.tag)) repeats.push(s);
    else {
      seenTags.add(s.tag);
      firstOfEachTag.push(s);
    }
  }
  return [...firstOfEachTag, ...repeats].slice(0, count);
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export type SendIntent = 'send' | 'sign_in' | 'ignore';

/**
 * What pressing send does. Empty and mid-compile presses are ignored. A signed-out
 * press opens the sign-in sheet rather than pretending to compile: the sample
 * conversation is a fixture and the compile is a paid call on the user's account.
 */
export function sendIntent(input: {
  text: string;
  compiling: boolean;
  signedIn: boolean;
}): SendIntent {
  if (input.compiling || input.text.trim().length === 0) return 'ignore';
  return input.signedIn ? 'send' : 'sign_in';
}

/** The send button is enabled when a press would do something. */
export const canSend = (input: { text: string; compiling: boolean }): boolean =>
  sendIntent({ ...input, signedIn: true }) !== 'ignore';

/** Composer height in px for `lines` of text, clamped so it never eats the thread. */
export function composerHeight(lines: number, opts: { line?: number; min?: number; max?: number } = {}): number {
  const { line = 22, min = 40, max = 116 } = opts;
  return Math.max(min, Math.min(max, min + (Math.max(lines, 1) - 1) * line));
}

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

/**
 * Whether the reader is at the bottom of the thread. New content follows them
 * down; a reader who scrolled up to reread is not yanked back.
 */
export function isNearBottom(
  m: { offset: number; viewport: number; content: number },
  threshold = 96,
): boolean {
  return m.content - (m.offset + m.viewport) <= threshold;
}
