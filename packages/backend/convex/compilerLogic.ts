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

import { marketAssets, parseSpec, type StrategySpec } from '@kanon/spec';

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
  outcome: 'compiled' | 'rejected';
  reply: string;
  rejectionReason?: string;
  spec?: unknown;
}

export type CompilerParseResult =
  | { ok: true; spec: StrategySpec; reply: string }
  | { ok: false; kind: 'rejected'; reply: string; reason: string }
  | { ok: false; kind: 'invalid'; error: string; raw: unknown };

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
    stopDistanceBps: paramNumberSchema(1, 10_000),
  },
  required: ['riskPerTradeBps', 'stopDistanceBps'],
  additionalProperties: false,
} as const;

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
    'compiles to arithmetic over the canonical series, or a rejection naming what could not ' +
    'be expressed that way.',
  input_schema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: ['compiled', 'rejected'],
        description:
          '"compiled" when the request produced a valid spec. "rejected" when any part of ' +
          'the request cannot be expressed as arithmetic over the three allowed predicates — ' +
          'never invent a fourth predicate to make it fit.',
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

function turnToMessage(turn: CompilerTurn): CompilerMessage {
  // The demo transcript's two speakers: KANON (the compiler) and YOU (the user).
  const role: CompilerMessage['role'] = turn.from.toUpperCase() === 'KANON' ? 'assistant' : 'user';
  return { role, content: turn.text };
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

/**
 * Validates the model's tool call against `StrategySpec` via `@kanon/spec`'s
 * `parseSpec`. Never returns a partially valid spec — either the whole
 * thing parses, or the caller gets an `invalid` result to retry on, or the
 * model's own `rejected` outcome is passed through unchanged.
 */
export function parseCompilerResponse(toolInput: unknown): CompilerParseResult {
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

  if (input.outcome !== 'compiled') {
    return {
      ok: false,
      kind: 'invalid',
      error: `Unknown outcome "${String(input.outcome)}". Expected "compiled" or "rejected".`,
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
    return {
      ok: true,
      spec:
        asset === spec.series.asset && feed === spec.series.feed ? spec : { ...spec, series: { ...spec.series, asset, feed } },
      reply: input.reply,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: 'invalid', error: message, raw: toolInput };
  }
}
