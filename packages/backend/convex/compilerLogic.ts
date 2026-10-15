/**
 * The compiler's prompt-building and response-parsing logic, kept pure and
 * separate from the actual LLM API call (`compiler.ts`).
 *
 * Why this split exists: a Convex *action* can call an external API, but
 * that means it can't be unit-tested offline in the normal sense. Everything
 * that can be expressed as a pure function — the system prompt, the tool
 * schema, and the validation of whatever comes back — lives here instead, so
 * it can be exercised with canned model outputs and no network call. See
 * `compilerLogic.test.ts` for the fixture set this satisfies
 * `docs/ARCHITECTURE.md`'s "pin the model version, snapshot-test the
 * compiler against a fixture set" requirement with.
 *
 * These types are provider-agnostic on purpose: `compiler.ts` is the only
 * file that should need to change if the compiler's LLM provider changes
 * again — it already has once (Anthropic's Messages API, replaced by
 * DashScope's OpenAI-compatible `chat.completions` API). The wire shape here
 * (a system string, a role/content message list, a name/description/
 * input_schema tool, and a forced tool-choice-by-name) is generic enough to
 * map onto any provider that supports forced tool calling via a small
 * adapter in `compiler.ts`.
 *
 * The compiler's job is translation, not prediction. It never proposes a
 * fourth predicate, and it never asserts anything about where the market is
 * going — only what the user's words compile to.
 */

import {
  exitsQuestion,
  marketAssets,
  missingExits,
  parseSpec,
  type ExitName,
  type StrategySpec,
} from '@kanon/spec';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** One turn of the chat-to-spec transcript, in `demo.ts`'s `COMPILER.transcript` shape. */
export interface CompilerTurn {
  from: string;
  text: string;
}

export interface BuildPromptInput {
  prompt: string;
  previousSpec?: unknown;
  conversationHistory?: CompilerTurn[] | undefined;
}

export interface CompilerMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompilerToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface CompilerRequest {
  system: string;
  messages: CompilerMessage[];
  tool: CompilerToolDefinition;
  toolChoice: { type: 'tool'; name: string };
}

/** The shape the model must fill via the forced tool call. */
export interface CompilerToolOutput {
  outcome: 'compiled' | 'rejected' | 'needs_input';
  reply: string;
  rejectionReason?: string;
  /** With `needs_input`: the exits the user has not stated. */
  missing?: string[];
  spec?: unknown;
}

export type CompilerParseResult =
  | { ok: true; spec: StrategySpec; reply: string }
  | { ok: false; kind: 'rejected'; reply: string; reason: string }
  /** The user has not stated a stop or a target. An answer, not a fault: nothing to retry. */
  | { ok: false; kind: 'needs_input'; reply: string; missing: ExitName[] }
  | { ok: false; kind: 'invalid'; error: string; raw: unknown };

/** What the user said, for checking that an exit marked stated was. Optional: without it nothing is demoted. */
export interface CompilerParseContext {
  /** Every user turn of the conversation, the current prompt included. */
  userWords?: readonly string[] | undefined;
  /** The spec being edited, whose stated exits the user need not repeat. */
  previousSpec?: StrategySpec | null | undefined;
}

// ---------------------------------------------------------------------------
// The three allowed predicates, and only these three. Exact parameter names
// match packages/spec/src/spec.ts — a fourth predicate must never be
// proposed by the model, and the tool schema below makes that structurally
// true rather than a matter of prompt discipline alone.
// ---------------------------------------------------------------------------

const DIRECTION = ['long', 'short'] as const;
const TIMEFRAME = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
const REFERENCE_EXTREME = [
  'prev_day_low',
  'prev_day_high',
  'prev_session_low',
  'prev_session_high',
  'swing_low',
  'swing_high',
] as const;
const LOOKBACK = ['15m', '1h', '4h', '1D', '1W'] as const;

function paramNumberSchema(minimum: number, maximum: number) {
  return {
    type: 'object',
    properties: {
      value: { type: 'integer', minimum, maximum },
      inferred: {
        type: 'boolean',
        description:
          'true if the compiler chose this value itself rather than reading it from what the user said.',
      },
    },
    required: ['value', 'inferred'],
    additionalProperties: false,
  } as const;
}

function paramEnumSchema(values: readonly string[]) {
  return {
    type: 'object',
    properties: {
      value: { type: 'string', enum: values as unknown as string[] },
      inferred: {
        type: 'boolean',
        description:
          'true if the compiler chose this value itself rather than reading it from what the user said.',
      },
    },
    required: ['value', 'inferred'],
    additionalProperties: false,
  } as const;
}

const BREAK_OF_STRUCTURE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { const: 'break_of_structure' },
    id: { type: 'string' },
    direction: { type: 'string', enum: DIRECTION as unknown as string[] },
    swingLookbackCandles: paramNumberSchema(2, 200),
    timeframe: paramEnumSchema(TIMEFRAME),
  },
  required: ['kind', 'id', 'direction', 'swingLookbackCandles', 'timeframe'],
  additionalProperties: false,
} as const;

const FAIR_VALUE_GAP_SCHEMA = {
  type: 'object',
  properties: {
    kind: { const: 'fair_value_gap' },
    id: { type: 'string' },
    direction: { type: 'string', enum: DIRECTION as unknown as string[] },
    minGapBps: paramNumberSchema(1, 10_000),
    timeframe: paramEnumSchema(TIMEFRAME),
  },
  required: ['kind', 'id', 'direction', 'minGapBps', 'timeframe'],
  additionalProperties: false,
} as const;

const LIQUIDITY_SWEEP_SCHEMA = {
  type: 'object',
  properties: {
    kind: { const: 'liquidity_sweep' },
    id: { type: 'string' },
    direction: { type: 'string', enum: DIRECTION as unknown as string[] },
    referenceExtreme: paramEnumSchema(REFERENCE_EXTREME),
    lookback: paramEnumSchema(LOOKBACK),
    timeframe: paramEnumSchema(TIMEFRAME),
  },
  required: ['kind', 'id', 'direction', 'referenceExtreme', 'lookback', 'timeframe'],
  additionalProperties: false,
} as const;

const RISK_SCHEMA = {
  type: 'object',
  properties: {
    riskPerTradeBps: paramNumberSchema(1, 10_000),
    stopDistanceBps: {
      ...paramNumberSchema(1, 10_000),
      description: "Distance from entry to the stop, in basis points of entry. From the user's own words only.",
    },
    targetDistanceBps: {
      ...paramNumberSchema(1, 10_000),
      description:
        "Distance from entry to the target, in basis points of entry. From the user's own words only; " +
        'a multiple of a stated stop (2R, 1:2) is stated, a price level is not.',
    },
  },
  required: ['riskPerTradeBps', 'stopDistanceBps', 'targetDistanceBps'],
  additionalProperties: false,
} as const;

const EXIT_NAMES: readonly ExitName[] = ['stop_distance', 'target_distance'];

/**
 * The markets a rule can be written on: the pairs with a price feed, and so with
 * candles. Written as listed ("BTC/USD"), because that is the name the candles,
 * the proposer and the pin's series lookup all use.
 */
const COMPILER_ASSETS: readonly string[] = marketAssets();

/**
 * A model's asset in the listed form, or null when it is not a listed market.
 * "BTC" and "btc / usd" are BTC/USD. A bare base is read as its USD pair, the
 * only quote there is; another quote is not rewritten, so it is not a market.
 */
export function canonicalAsset(asset: string): string | null {
  const n = asset.replace(/\s+/g, '').toUpperCase();
  if (COMPILER_ASSETS.includes(n)) return n;
  if (!n.includes('/') && COMPILER_ASSETS.includes(`${n}/USD`)) return `${n}/USD`;
  return null;
}

/** Where a listed pair's prices come from: Pyth, named as the spec names it ("pyth/btc-usd"). */
export function feedFor(asset: string): string {
  return `pyth/${asset.toLowerCase().replace('/', '-')}`;
}

const SERIES_SCHEMA = {
  type: 'object',
  properties: {
    asset: { type: 'string', enum: COMPILER_ASSETS },
    feed: { type: 'string' },
    cadenceSeconds: { type: 'integer', minimum: 1 },
    bucketSeconds: { type: 'integer', minimum: 1 },
  },
  required: ['asset', 'feed', 'cadenceSeconds', 'bucketSeconds'],
  additionalProperties: false,
} as const;

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    version: { const: 1 },
    id: { type: 'string' },
    name: { type: 'string' },
    direction: { type: 'string', enum: DIRECTION as unknown as string[] },
    series: SERIES_SCHEMA,
    predicates: {
      type: 'array',
      minItems: 1,
      items: {
        oneOf: [BREAK_OF_STRUCTURE_SCHEMA, FAIR_VALUE_GAP_SCHEMA, LIQUIDITY_SWEEP_SCHEMA],
      },
    },
    risk: RISK_SCHEMA,
  },
  required: ['version', 'id', 'name', 'direction', 'series', 'predicates', 'risk'],
  additionalProperties: false,
} as const;

/** The tool the model must call. Forcing it is what makes output structured. */
export const COMPILER_TOOL: CompilerToolDefinition = {
  name: 'emit_compiled_spec',
  description:
    "Return the result of compiling the user's strategy description. Either a spec that " +
    'compiles to arithmetic over the canonical series, a rejection naming what could not ' +
    'be expressed that way, or a request for the stop or target the user has not stated.',
  input_schema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: ['compiled', 'rejected', 'needs_input'],
        description:
          '"compiled" when the request produced a valid spec with a stop and a target the user ' +
          'stated. "rejected" when any part of the request cannot be expressed as arithmetic over ' +
          'the three allowed predicates — never invent a fourth predicate to make it fit. ' +
          '"needs_input" when the user has not stated a stop or a target as a distance from entry.',
      },
      missing: {
        type: 'array',
        items: { type: 'string', enum: EXIT_NAMES as unknown as string[] },
        description: 'Present only when outcome is "needs_input". The exits the user has not stated.',
      },
      reply: {
        type: 'string',
        description:
          'One or two sentences in the compiler\'s voice: terse, states what it added or ' +
          'changed, never speculative about the market. On rejection, says plainly what could ' +
          'not be compiled.',
      },
      rejectionReason: {
        type: 'string',
        description: 'Present only when outcome is "rejected". What specifically is not arithmetic.',
      },
      spec: {
        ...SPEC_SCHEMA,
        description: 'Present only when outcome is "compiled". Matches StrategySpec exactly.',
      },
    },
    required: ['outcome', 'reply'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Kanon's strategy compiler.

Your job is translation, not prediction. You turn a trader's plain-English
description of a Smart Money Concepts strategy into a machine-checkable spec.
You never trade, never forecast where the market is going, and never give
trading advice. You only translate stated rules into parameters.

Speak SMC natively — break of structure, fair value gap, liquidity sweep,
order block — the way a discretionary SMC trader speaks it. No glossary, no
explaining what a wick is.

You may bind ONLY these three predicates. Their parameter names below are
exact — use them verbatim:

1. break_of_structure — price crosses a prior swing extreme.
   Parameters: direction, swingLookbackCandles (candles back the prior swing
   extreme is measured over, 2-200), timeframe.

2. fair_value_gap — three-candle imbalance.
   Parameters: direction, minGapBps (minimum gap size in basis points of
   price, 1-10000), timeframe.

3. liquidity_sweep — wick beyond a prior extreme with a close back inside.
   Parameters: direction, referenceExtreme (prev_day_low, prev_day_high,
   prev_session_low, prev_session_high, swing_low, swing_high), lookback,
   timeframe.

Rules, without exception:

- Do not invent a fourth predicate. If what the user describes is not
  arithmetic over these three predicates and the canonical price series —
  order blocks as a standalone concept, inducement, mitigation, anything
  that needs judgment rather than a threshold — set outcome to "rejected"
  and say in "reply" what could not be compiled. Never approximate it by
  quietly attaching it to one of the three predicates.
- Every parameter you bind must carry "inferred": true if you chose the
  value yourself, and "inferred": false if the user stated it. A default the
  user never stated must never be marked as stated — that is a silent
  parameter, and this product exists specifically to prevent silent
  parameters.
- When editing an existing pinned spec, keep every predicate and parameter
  the user did not ask to change exactly as it was — do not re-infer values
  that were already stated.
- Every rule has two exits, risk.stopDistanceBps and risk.targetDistanceBps,
  each a distance from entry in basis points of entry (2% is 200). Both come
  from the user's own words, and both carry "inferred": false. You never
  choose either one:
  - A percentage or basis points from entry is stated: "stop 2%", "target
    150 bps".
  - A target written as a multiple of a stated stop is stated. "2R", "1:2" or
    "2:1 reward to risk" with a 2% stop is a 4% target: compute 400.
  - A price level ("target 70k", "stop at 64,000") is not a distance from
    entry, so it is not stated.
  - If either one is not stated, set outcome to "needs_input", list what is
    missing in "missing" (stop_distance, target_distance), and leave out
    "spec". Never fill one in to make the rule compile.
- Kanon's on-chain gate records one price per 15m bucket, so on-chain a
  candle's wick is its close. A liquidity_sweep predicate needs a wick
  through the level that closes back inside, so it can never pass the
  on-chain gate. Still compile it when the user asks for one, but say so in
  "reply": this rule cannot pass the on-chain gate, and why.
- "reply" is one or two sentences, terse, states what you added or changed.
  Never speculate about where price is headed. Never apologize, never add
  disclaimers — just say what compiled.
- series.asset is one of ${COMPILER_ASSETS.join(', ')}, written exactly as
  listed ("BTC/USD", never "BTC"). A rule on any other market is rejected:
  say which markets there are. series.feed is that pair's Pyth feed, written
  pyth/<base>-usd (pyth/btc-usd).
- version is always 1. Give every predicate and the spec itself a short id.
- Always call the emit_compiled_spec tool. Never respond in plain text.`;

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/** Whether a turn is the compiler's own: `assistant` on the wire, `KANON` in the demo transcript. */
function fromCompiler(turn: CompilerTurn): boolean {
  const from = turn.from.toUpperCase();
  return from === 'KANON' || from === 'ASSISTANT';
}

function turnToMessage(turn: CompilerTurn): CompilerMessage {
  const role: CompilerMessage['role'] = fromCompiler(turn) ? 'assistant' : 'user';
  return { role, content: turn.text };
}

/** Everything the user said in a conversation, the current prompt last. The compiler's turns are not evidence. */
export function userWordsOf(history: readonly CompilerTurn[] | undefined, prompt: string): string[] {
  return [...(history ?? []).filter((t) => !fromCompiler(t)).map((t) => t.text), prompt];
}

/**
 * Builds the request to send to the compiler's LLM provider. Pure — no
 * network call. `retryFeedback`, when present, is appended as a further user
 * turn so the model can correct a schema-invalid previous attempt.
 */
export function buildCompilerPrompt(
  input: BuildPromptInput,
  retryFeedback?: string,
): CompilerRequest {
  const messages: CompilerMessage[] = [];

  for (const turn of input.conversationHistory ?? []) {
    messages.push(turnToMessage(turn));
  }

  let userContent = input.prompt;
  if (input.previousSpec !== undefined) {
    userContent =
      `The currently pinned spec, as JSON, is:\n${JSON.stringify(input.previousSpec)}\n\n` +
      `Edit request: ${input.prompt}`;
  }
  messages.push({ role: 'user', content: userContent });

  if (retryFeedback) {
    messages.push({
      role: 'user',
      content:
        `Your last call to emit_compiled_spec did not validate against the spec schema:\n` +
        `${retryFeedback}\n\nCall emit_compiled_spec again with a corrected input.`,
    });
  }

  return {
    system: SYSTEM_PROMPT,
    messages,
    tool: COMPILER_TOOL,
    toolChoice: { type: 'tool', name: COMPILER_TOOL.name },
  };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Exits the user actually stated
// ---------------------------------------------------------------------------

/** A decimal the user wrote, as an exact fraction `num / den`. No float touches it. */
function fraction(text: string): { num: number; den: number } | null {
  const m = /^(\d*)(?:\.(\d+))?$/.exec(text);
  if (!m || (!m[1] && !m[2])) return null;
  const frac = m[2] ?? '';
  const den = 10 ** frac.length;
  return { num: Number(m[1] || '0') * den + Number(frac || '0'), den };
}

/** A percentage as whole basis points. One finer than a basis point counts as both neighbours. */
function percentBps(text: string): number[] {
  const f = fraction(text);
  if (!f) return [];
  const scaled = f.num * 100;
  return scaled % f.den === 0 ? [scaled / f.den] : [Math.floor(scaled / f.den), Math.ceil(scaled / f.den)];
}

const STOP_WORDS = /\b(?:stop|stops|sl|stop[\s-]*loss|invalidat\w*)\b/i;
const TARGET_WORDS =
  /\b(?:target|targets|tp|take[\s-]*profit|profit|reward|rr|r:r|r\/r)\b|\d\s*r\b|\d\s*:\s*\d/i;
const RISK_WORDS = /\brisk\b/i;

interface ExitEvidence {
  stop: Set<number>;
  target: Set<number>;
  /** Reward-to-risk multiples, each as `num / den`. */
  multiples: Array<{ num: number; den: number }>;
}

/**
 * The distances and multiples the user wrote. A figure counts for the stop when
 * its clause speaks of a stop, for the target when it speaks of a target, and
 * for either when it names neither (an answer to "where is your target?"). A
 * clause about the risk per trade, and nothing else, is evidence of neither.
 */
function exitEvidence(userWords: readonly string[]): ExitEvidence {
  const out: ExitEvidence = { stop: new Set(), target: new Set(), multiples: [] };
  for (const turn of userWords) {
    for (const clause of turn.split(/[,;\n]|\.(?!\d)|\band\b|\bwith\b/i)) {
      const stopClause = STOP_WORDS.test(clause);
      const targetClause = TARGET_WORDS.test(clause);
      const neither = !stopClause && !targetClause;
      if (neither && RISK_WORDS.test(clause)) continue;
      const figures: number[] = [];
      for (const m of clause.matchAll(/(\d+(?:\.\d+)?|\.\d+)\s*(?:%|percent\b|pct\b)/gi)) {
        figures.push(...percentBps(m[1]!));
      }
      for (const m of clause.matchAll(/(\d+)\s*(?:bps|bp|basis\s*points?)\b/gi)) figures.push(Number(m[1]));
      // A bare figure right after the word ("stop 2", "target 4") reads as a percentage. A price
      // level ("target 70k", "stop at 64,000") is either suffixed or far out of range, so it never matches.
      for (const m of clause.matchAll(
        /\b(?:stop(?:[\s-]*loss)?|sl|target|tp|take[\s-]*profit)\b\s*(?:at|of|is|=|:|-)?\s*(\d+(?:\.\d+)?)(?![\d.,]|\s*(?:k\b|bps|bp|%|percent|pct|r\b|x\b|:))/gi,
      )) {
        figures.push(...percentBps(m[1]!));
      }
      // A clause that is only a figure answers the question before it: "4" to "where is your target?".
      const alone = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(clause);
      if (alone && neither) figures.push(...percentBps(alone[1]!));
      if (stopClause || neither) for (const f of figures) out.stop.add(f);
      if (targetClause || neither) for (const f of figures) out.target.add(f);

      if (!targetClause) continue;
      const multiple = (text: string) => {
        const f = fraction(text);
        if (f && f.num > 0) out.multiples.push(f);
      };
      for (const m of clause.matchAll(/(\d+(?:\.\d+)?)\s*(?:r|rr|x)\b/gi)) multiple(m[1]!);
      for (const m of clause.matchAll(
        /\b(?:rr|r:r|r\/r|risk[\s-]*(?:to[\s-]*)?reward|reward[\s-]*(?:to[\s-]*)?risk)\s*(?:of|=|:|is)?\s*(\d+(?:\.\d+)?)(?!\s*(?::|to\b))/gi,
      )) {
        multiple(m[1]!);
      }
      // "1:2" and "2:1" are both written for a target twice the stop. Either reading counts.
      for (const m of clause.matchAll(/(\d+(?:\.\d+)?)\s*(?::|\bto\b)\s*(\d+(?:\.\d+)?)/gi)) {
        const a = fraction(m[1]!);
        const b = fraction(m[2]!);
        if (!a || !b || a.num === 0 || b.num === 0) continue;
        out.multiples.push({ num: b.num * a.den, den: b.den * a.num });
        out.multiples.push({ num: a.num * b.den, den: a.den * b.num });
      }
    }
  }
  return out;
}

/**
 * The exits the model marked stated whose value the user never wrote: not as a
 * percentage or basis points, not as a multiple of the stop, and not as the
 * value the spec being edited already held, stated. Hardening, not the rule
 * itself: the prompt tells the model never to choose an exit, and this catches
 * one that did and said otherwise. It is lenient by design, because a wrong
 * catch asks the user again and a miss is no worse than before.
 */
export function statedExitsNotInWords(
  spec: StrategySpec,
  userWords: readonly string[],
  previousSpec?: StrategySpec | null,
): ExitName[] {
  const evidence = exitEvidence(userWords);
  const out: ExitName[] = [];

  const stop = spec.risk.stopDistanceBps;
  const prevStop = previousSpec?.risk.stopDistanceBps;
  const stopKept = prevStop !== undefined && !prevStop.inferred && prevStop.value === stop.value;
  if (!stop.inferred && !stopKept && !evidence.stop.has(stop.value)) out.push('stop_distance');

  const target = spec.risk.targetDistanceBps;
  if (target && !target.inferred) {
    const prevTarget = previousSpec?.risk.targetDistanceBps;
    const kept = prevTarget !== undefined && !prevTarget.inferred && prevTarget.value === target.value;
    // Within a basis point of stop × multiple: the spec holds whole basis points, so the model rounds.
    const byMultiple = evidence.multiples.some(
      (r) => Math.abs(target.value * r.den - stop.value * r.num) <= r.den,
    );
    if (!kept && !byMultiple && !evidence.target.has(target.value)) out.push('target_distance');
  }
  return out;
}

/** The spec with the named exits marked inferred, so `missingExits` counts them as not stated. */
function demoteExits(spec: StrategySpec, names: readonly ExitName[]): StrategySpec {
  if (names.length === 0) return spec;
  const risk = { ...spec.risk };
  if (names.includes('stop_distance')) risk.stopDistanceBps = { ...risk.stopDistanceBps, inferred: true };
  if (names.includes('target_distance') && risk.targetDistanceBps) {
    risk.targetDistanceBps = { ...risk.targetDistanceBps, inferred: true };
  }
  return { ...spec, risk };
}

/** The model's own list of missing exits, kept to the two names there are, in order. */
function namedExits(missing: unknown): ExitName[] {
  if (!Array.isArray(missing)) return [];
  return EXIT_NAMES.filter((name) => missing.includes(name));
}

function needsInput(missing: ExitName[]): CompilerParseResult {
  const named = missing.length > 0 ? missing : [...EXIT_NAMES];
  return { ok: false, kind: 'needs_input', reply: exitsQuestion(named), missing: named };
}

/**
 * Validates the model's tool call against `StrategySpec` via `@kanon/spec`'s
 * `parseSpec`. Never returns a partially valid spec — either the whole
 * thing parses, or the caller gets an `invalid` result to retry on, or the
 * model's own `rejected` outcome is passed through unchanged.
 *
 * A spec without a stop and a target the user stated never compiles. Whatever
 * the model's outcome, that is decided here, from the spec: the answer is
 * `needs_input`, with a question written here rather than by the model, and it
 * is never retried. `context.userWords`, when given, also demotes an exit the
 * model marked stated that the user never wrote (`statedExitsNotInWords`).
 */
export function parseCompilerResponse(
  toolInput: unknown,
  context: CompilerParseContext = {},
): CompilerParseResult {
  if (typeof toolInput !== 'object' || toolInput === null) {
    return { ok: false, kind: 'invalid', error: 'Tool input was not an object.', raw: toolInput };
  }

  const input = toolInput as Partial<CompilerToolOutput>;

  if (typeof input.reply !== 'string' || input.reply.length === 0) {
    return {
      ok: false,
      kind: 'invalid',
      error: 'Missing or empty "reply" field.',
      raw: toolInput,
    };
  }

  if (input.outcome === 'rejected') {
    return {
      ok: false,
      kind: 'rejected',
      reply: input.reply,
      reason: input.rejectionReason ?? input.reply,
    };
  }

  if (input.outcome === 'needs_input') {
    // The model asked. A spec it sent anyway may name more that is missing; it is never compiled.
    const fromModel = namedExits(input.missing);
    let fromSpec: ExitName[] = [];
    try {
      if (input.spec !== undefined) fromSpec = missingExits(parseSpec(input.spec));
    } catch {
      // A malformed spec beside a question adds nothing to it.
    }
    return needsInput(EXIT_NAMES.filter((n) => fromModel.includes(n) || fromSpec.includes(n)));
  }

  if (input.outcome !== 'compiled') {
    return {
      ok: false,
      kind: 'invalid',
      error: `Unknown outcome "${String(input.outcome)}". Expected "compiled", "rejected" or "needs_input".`,
      raw: toolInput,
    };
  }

  if (input.spec === undefined) {
    return {
      ok: false,
      kind: 'invalid',
      error: 'outcome was "compiled" but no "spec" was present.',
      raw: toolInput,
    };
  }

  try {
    const spec = parseSpec(input.spec);
    const asset = canonicalAsset(spec.series.asset);
    if (asset === null) {
      return {
        ok: false,
        kind: 'invalid',
        error: `series.asset "${spec.series.asset}" is not a market with a price series. Use one of ${COMPILER_ASSETS.join(', ')}, or reject the rule.`,
        raw: toolInput,
      };
    }
    // The feed is a fact about the pair, not the model's to choose: one it names is replaced.
    const feed = feedFor(asset);
    const listed =
      asset === spec.series.asset && feed === spec.series.feed ? spec : { ...spec, series: { ...spec.series, asset, feed } };

    // No stop and target the user stated, no rule. Decided here, from the spec, whatever the model said.
    const unstated = context.userWords
      ? statedExitsNotInWords(listed, context.userWords, context.previousSpec ?? null)
      : [];
    const missing = missingExits(demoteExits(listed, unstated));
    if (missing.length > 0) return needsInput(missing);

    return { ok: true, spec: listed, reply: input.reply };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: 'invalid', error: message, raw: toolInput };
  }
}
