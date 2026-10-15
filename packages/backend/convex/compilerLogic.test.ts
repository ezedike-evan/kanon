/**
 * Snapshot-style fixture tests for the compiler's pure logic.
 *
 * docs/ARCHITECTURE.md, "Failure modes": "Compiler drift: the same prompt
 * producing different specs. Pin the model version, snapshot-test the
 * compiler against a fixture set." The model call itself (`compiler.ts`)
 * can't be unit-tested offline, but everything it depends on — the prompt
 * it sends and the validation it applies to what comes back — is pure and
 * is exercised here with canned model outputs, so this suite runs with no
 * network call.
 *
 * Fixtures cover, per the assignment: a fresh compile, a follow-up edit to
 * an existing pinned spec, and a request for something not expressible as
 * one of the three predicates, which must be rejected rather than silently
 * dropped or approximated.
 */

import { describe, expect, it } from 'vitest';
import { BOS20_15M_NO_TARGET, RULE_04, diffSpec, exitsQuestion, type StrategySpec } from '@kanon/spec';
import {
  buildCompilerPrompt,
  parseCompilerResponse,
  statedExitsNotInWords,
  userWordsOf,
  COMPILER_TOOL,
  type CompilerToolOutput,
} from './compilerLogic';

describe('COMPILER_TOOL — the three predicates, and only three', () => {
  it('exposes exactly break_of_structure, fair_value_gap, liquidity_sweep', () => {
    const predicateSchema = (COMPILER_TOOL.input_schema as any).properties.spec.properties
      .predicates.items.oneOf as Array<{ properties: { kind: { const: string } } }>;
    const kinds = predicateSchema.map((s) => s.properties.kind.const).sort();
    expect(kinds).toEqual(['break_of_structure', 'fair_value_gap', 'liquidity_sweep']);
  });

  it('requires a stop and a target in the risk block', () => {
    const risk = (COMPILER_TOOL.input_schema as any).properties.spec.properties.risk;
    expect(risk.required).toEqual(['riskPerTradeBps', 'stopDistanceBps', 'targetDistanceBps']);
    expect(risk.properties.targetDistanceBps.properties.value).toMatchObject({ minimum: 1, maximum: 10_000 });
  });

  it('can answer with a question for the missing exits', () => {
    const props = (COMPILER_TOOL.input_schema as any).properties;
    expect(props.outcome.enum).toEqual(['compiled', 'rejected', 'needs_input']);
    expect(props.missing.items.enum).toEqual(['stop_distance', 'target_distance']);
    expect((COMPILER_TOOL.input_schema as any).required).toEqual(['outcome', 'reply']);
  });

  it('forces the tool call rather than allowing free text', () => {
    const request = buildCompilerPrompt({ prompt: 'anything' });
    expect(request.toolChoice).toEqual({ type: 'tool', name: 'emit_compiled_spec' });
  });
});

describe('buildCompilerPrompt', () => {
  it('builds a fresh-compile request with no prior spec', () => {
    const request = buildCompilerPrompt({
      prompt: 'Only take longs after a break of structure on the 15m, then wait for a fair value gap.',
    });
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]).toEqual({
      role: 'user',
      content: 'Only take longs after a break of structure on the 15m, then wait for a fair value gap.',
    });
    expect(request.system).toContain('break_of_structure');
    expect(request.system).toContain('fair_value_gap');
    expect(request.system).toContain('liquidity_sweep');
  });

  it("tells the model the exits are the user's to state, and what counts", () => {
    const { system } = buildCompilerPrompt({ prompt: 'x' });
    expect(system).toContain('targetDistanceBps');
    expect(system).toContain('needs_input');
    expect(system).toMatch(/"2R", "1:2"/);
    expect(system).toMatch(/price level/);
    expect(system).toMatch(/never\s+choose either one/i);
  });

  it('tells the model a sweep rule cannot pass the on-chain gate, and to say so', () => {
    const { system } = buildCompilerPrompt({ prompt: 'x' });
    expect(system).toMatch(/one price per 15m bucket/);
    expect(system).toMatch(/cannot pass the\s+on-chain gate/);
  });

  it('reads the wire speaker names: an assistant turn is the compiler, not the user', () => {
    const request = buildCompilerPrompt({
      prompt: 'target 4%',
      conversationHistory: [
        { from: 'user', text: 'BOS 20, risk 1%, stop 2%' },
        { from: 'assistant', text: 'Where is your target?' },
      ],
    });
    expect(request.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('embeds the previous spec on a follow-up edit', () => {
    const request = buildCompilerPrompt({
      prompt: "Only take longs after a sweep of the previous day's low too.",
      previousSpec: RULE_04,
    });
    const last = request.messages[request.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain(JSON.stringify(RULE_04));
    expect(last.content).toContain("Only take longs after a sweep of the previous day's low too.");
  });

  it('carries prior transcript turns and maps KANON to assistant', () => {
    const request = buildCompilerPrompt({
      prompt: 'Tighten the swing lookback to 8 candles.',
      conversationHistory: [
        { from: 'KANON', at: '14:29', text: 'Anything about liquidity?' } as any,
        { from: 'YOU', at: '14:31', text: "Sweep the previous day's low first." } as any,
      ],
    });
    expect(request.messages[0]).toEqual({ role: 'assistant', content: 'Anything about liquidity?' });
    expect(request.messages[1]).toEqual({
      role: 'user',
      content: "Sweep the previous day's low first.",
    });
    expect(request.messages[2].role).toBe('user');
  });

  it('appends retry feedback as an additional user turn', () => {
    const request = buildCompilerPrompt(
      { prompt: 'Add a fair value gap requirement.' },
      'swingLookbackCandles.value must be <= 200',
    );
    const last = request.messages[request.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('swingLookbackCandles.value must be <= 200');
  });
});

describe('parseCompilerResponse — fixture 1: fresh compile', () => {
  it('validates a well-formed compiled spec', () => {
    const toolOutput: CompilerToolOutput = {
      outcome: 'compiled',
      reply: 'Compiled. Break of structure and fair value gap, both on the 15m.',
      spec: {
        version: 1,
        id: 'rule-fresh',
        name: 'FRESH_COMPILE',
        direction: 'long',
        series: {
          asset: 'BTC/USD',
          feed: 'pyth/btc-usd',
          cadenceSeconds: 60,
          bucketSeconds: 900,
        },
        predicates: [
          {
            kind: 'break_of_structure',
            id: 'p1',
            direction: 'long',
            swingLookbackCandles: { value: 5, inferred: true },
            timeframe: { value: '15m', inferred: false },
          },
          {
            kind: 'fair_value_gap',
            id: 'p2',
            direction: 'long',
            minGapBps: { value: 15, inferred: true },
            timeframe: { value: '15m', inferred: false },
          },
        ],
        risk: {
          riskPerTradeBps: { value: 50, inferred: true },
          stopDistanceBps: { value: 50, inferred: false },
          targetDistanceBps: { value: 100, inferred: false },
        },
      },
    };

    const result = parseCompilerResponse(toolOutput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.predicates).toHaveLength(2);
      expect(result.spec.predicates[0].kind).toBe('break_of_structure');
      expect(result.reply).toContain('Compiled');
    }
  });
});

describe('parseCompilerResponse — the asset', () => {
  const withAsset = (asset: string): CompilerToolOutput => ({
    outcome: 'compiled',
    reply: 'Compiled.',
    spec: {
      version: 1,
      id: 'rule-asset',
      name: 'ASSET',
      direction: 'long',
      series: { asset, feed: 'default', cadenceSeconds: 900, bucketSeconds: 900 },
      predicates: [
        {
          kind: 'break_of_structure',
          id: 'p1',
          direction: 'long',
          swingLookbackCandles: { value: 20, inferred: false },
          timeframe: { value: '15m', inferred: false },
        },
      ],
      risk: {
        riskPerTradeBps: { value: 100, inferred: false },
        stopDistanceBps: { value: 200, inferred: false },
        targetDistanceBps: { value: 400, inferred: false },
      },
    },
  });

  it('writes a bare base or a loosely written pair as the listed pair', () => {
    for (const [given, listed] of [
      ['BTC', 'BTC/USD'],
      ['eth', 'ETH/USD'],
      ['btc / usd', 'BTC/USD'],
      ['BTC/USD', 'BTC/USD'],
    ]) {
      const result = parseCompilerResponse(withAsset(given));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.spec.series.asset).toBe(listed);
    }
  });

  it("names the pair's Pyth feed whatever feed the model wrote", () => {
    const result = parseCompilerResponse(withAsset('BTC'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.series.feed).toBe('pyth/btc-usd');
  });

  it('sends back a market with no price series instead of guessing one', () => {
    for (const given of ['DOGE', 'BTC/USDT', 'AAPL']) {
      const result = parseCompilerResponse(withAsset(given));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('invalid');
        if (result.kind === 'invalid') expect(result.error).toContain('BTC/USD');
      }
    }
  });
});

describe('parseCompilerResponse — fixture 2: follow-up edit to a pinned spec', () => {
  it('validates an edited spec and diffs cleanly against the original', () => {
    const edited: StrategySpec = {
      ...RULE_04,
      predicates: [
        ...RULE_04.predicates,
        {
          kind: 'liquidity_sweep',
          id: 'p4',
          direction: 'long',
          referenceExtreme: { value: 'prev_session_low', inferred: false },
          lookback: { value: '1h', inferred: true },
          timeframe: { value: '15m', inferred: false },
        },
      ],
    };
    const toolOutput: CompilerToolOutput = {
      outcome: 'compiled',
      reply: 'Compiled. Added one predicate: a sweep of the previous session low.',
      spec: edited,
    };

    const result = parseCompilerResponse(toolOutput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.spec.predicates).toHaveLength(RULE_04.predicates.length + 1);

    const diff = diffSpec(RULE_04, result.spec);
    const added = diff.changes.filter((c) => c.kind === 'add');
    expect(added.length).toBeGreaterThan(0);
    // Adding a predicate tightens the rule — no removal, no loosening — so
    // this edit should not need to wait out the cooling-off period.
    expect(diff.changes.some((c) => c.kind === 'remove' || c.kind === 'loosen')).toBe(false);
    expect(diff.requiresCoolingOff).toBe(false);
  });
});

describe('parseCompilerResponse — fixture 3: not expressible as one of the three predicates', () => {
  it('rejects a standalone order-block request rather than approximating it', () => {
    const toolOutput: CompilerToolOutput = {
      outcome: 'rejected',
      reply:
        "Order block isn't one of the three predicates Kanon can enforce yet. I can bind break of structure, fair value gap, or liquidity sweep instead.",
      rejectionReason:
        'Order block requires judgment about which candle qualifies as the origin — it is not arithmetic over the canonical series the way the other three are.',
    };

    const result = parseCompilerResponse(toolOutput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.reason).toContain('judgment');
    }
  });

  it('rejects a discretionary "gut feeling" request', () => {
    const toolOutput: CompilerToolOutput = {
      outcome: 'rejected',
      reply: "That's a discretionary call, not arithmetic over the price series. I can't bind it.",
      rejectionReason: 'No parameters were given and none can be inferred from a feeling.',
    };
    const result = parseCompilerResponse(toolOutput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('rejected');
  });
});

describe('parseCompilerResponse — fixture 4: schema-invalid output triggers a retry', () => {
  it('flags a fourth predicate kind as invalid, not silently dropped', () => {
    const toolOutput = {
      outcome: 'compiled',
      reply: 'Compiled.',
      spec: {
        ...RULE_04,
        predicates: [
          {
            kind: 'order_block',
            id: 'p9',
            direction: 'long',
          },
        ],
      },
    };
    const result = parseCompilerResponse(toolOutput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('invalid');
  });

  it('flags an out-of-range parameter as invalid', () => {
    const toolOutput = {
      outcome: 'compiled',
      reply: 'Compiled.',
      spec: {
        ...RULE_04,
        predicates: [
          {
            kind: 'break_of_structure',
            id: 'p1',
            direction: 'long',
            swingLookbackCandles: { value: 999, inferred: true }, // max is 200
            timeframe: { value: '15m', inferred: false },
          },
        ],
      },
    };
    const result = parseCompilerResponse(toolOutput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.kind !== 'invalid') throw new Error('expected kind "invalid"');
    expect(result.error.length).toBeGreaterThan(0);
  });

  it('flags a missing reply as invalid before even looking at outcome', () => {
    const result = parseCompilerResponse({ outcome: 'compiled', spec: RULE_04 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// Stated exits: no stop and target the user set, no rule
// ---------------------------------------------------------------------------

const bos20 = (risk: Record<string, unknown>, extra: Partial<Record<string, unknown>> = {}) => ({
  version: 1,
  id: 'btc-long-bos-20',
  name: 'BTC Long 15m Break of Structure',
  direction: 'long',
  series: { asset: 'BTC/USD', feed: 'pyth/btc-usd', cadenceSeconds: 900, bucketSeconds: 900 },
  predicates: [
    {
      kind: 'break_of_structure',
      id: 'bos-20',
      direction: 'long',
      swingLookbackCandles: { value: 20, inferred: false },
      timeframe: { value: '15m', inferred: false },
    },
  ],
  risk,
  ...extra,
});

const compiled = (spec: unknown): CompilerToolOutput => ({ outcome: 'compiled', reply: 'Compiled.', spec });

const STOP_2 = { value: 200, inferred: false };
const RISK_1 = { value: 100, inferred: false };

describe('parseCompilerResponse — needs_input', () => {
  it('asks for a target the spec does not carry, deterministically and without a retry', () => {
    const result = parseCompilerResponse(compiled(bos20({ riskPerTradeBps: RISK_1, stopDistanceBps: STOP_2 })));
    expect(result).toEqual({
      ok: false,
      kind: 'needs_input',
      reply: exitsQuestion(['target_distance']),
      missing: ['target_distance'],
    });
  });

  it('asks for a target the model chose itself', () => {
    const result = parseCompilerResponse(
      compiled(bos20({ riskPerTradeBps: RISK_1, stopDistanceBps: STOP_2, targetDistanceBps: { value: 400, inferred: true } })),
    );
    expect(result).toMatchObject({ ok: false, kind: 'needs_input', missing: ['target_distance'] });
  });

  it('asks for both when neither was stated', () => {
    const result = parseCompilerResponse(
      compiled(bos20({ riskPerTradeBps: RISK_1, stopDistanceBps: { value: 200, inferred: true } })),
    );
    expect(result).toMatchObject({ ok: false, kind: 'needs_input', missing: ['stop_distance', 'target_distance'] });
    if (!result.ok && result.kind === 'needs_input') expect(result.reply).toBe(exitsQuestion(result.missing));
  });

  it("writes its own question, whatever the model's reply said", () => {
    const result = parseCompilerResponse({
      ...compiled(bos20({ riskPerTradeBps: RISK_1, stopDistanceBps: STOP_2 })),
      reply: 'Compiled. BOS 20 on the 15m.',
    });
    expect(!result.ok && result.kind === 'needs_input' && result.reply).toBe(exitsQuestion(['target_distance']));
  });

  it("passes the model's own needs_input through, keeping only the two exit names", () => {
    expect(
      parseCompilerResponse({ outcome: 'needs_input', reply: 'Target?', missing: ['target_distance', 'size'] }),
    ).toEqual({ ok: false, kind: 'needs_input', reply: exitsQuestion(['target_distance']), missing: ['target_distance'] });
    expect(parseCompilerResponse({ outcome: 'needs_input', reply: 'Exits?' })).toMatchObject({
      kind: 'needs_input',
      missing: ['stop_distance', 'target_distance'],
    });
  });

  it('never compiles a needs_input, even with a complete spec beside it', () => {
    const result = parseCompilerResponse({
      outcome: 'needs_input',
      reply: 'Target?',
      missing: ['target_distance'],
      spec: RULE_04,
    });
    expect(result).toMatchObject({ ok: false, kind: 'needs_input', missing: ['target_distance'] });
  });

  it('checks the market first: an unlisted market is invalid, not a question', () => {
    const result = parseCompilerResponse(
      compiled({ ...bos20({ riskPerTradeBps: RISK_1, stopDistanceBps: STOP_2 }), series: { asset: 'DOGE', feed: 'x', cadenceSeconds: 900, bucketSeconds: 900 } }),
    );
    expect(result).toMatchObject({ ok: false, kind: 'invalid' });
  });

  it('compiles once both exits are stated', () => {
    const result = parseCompilerResponse(
      compiled(bos20({ riskPerTradeBps: RISK_1, stopDistanceBps: STOP_2, targetDistanceBps: { value: 400, inferred: false } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.risk.targetDistanceBps).toEqual({ value: 400, inferred: false });
  });
});

describe('parseCompilerResponse — exits marked stated must be in the user\'s words', () => {
  const full = (target: number, stop = 200) =>
    compiled(
      bos20({
        riskPerTradeBps: RISK_1,
        stopDistanceBps: { value: stop, inferred: false },
        targetDistanceBps: { value: target, inferred: false },
      }),
    );

  it('asks again when the model invented a target the user never wrote', () => {
    const result = parseCompilerResponse(full(400), { userWords: ['BOS 20, risk 1%, stop 2%'] });
    expect(result).toMatchObject({ ok: false, kind: 'needs_input', missing: ['target_distance'] });
  });

  it('does not take the risk per trade for a target', () => {
    const result = parseCompilerResponse(full(100), { userWords: ['BOS 20, risk 1%, stop 2%'] });
    expect(result).toMatchObject({ ok: false, kind: 'needs_input', missing: ['target_distance'] });
  });

  it('compiles a target the user answered with', () => {
    const words = userWordsOf(
      [
        { from: 'user', text: 'BOS 20, risk 1%, stop 2%' },
        { from: 'assistant', text: exitsQuestion(['target_distance']) },
      ],
      'target 4%',
    );
    expect(parseCompilerResponse(full(400), { userWords: words }).ok).toBe(true);
    expect(parseCompilerResponse(full(400), { userWords: ['BOS 20, risk 1%, stop 2%', '4%'] }).ok).toBe(true);
    expect(parseCompilerResponse(full(400), { userWords: ['BOS 20, risk 1%, stop 2%', '4'] }).ok).toBe(true);
  });

  it('counts an R-multiple of a stated stop as stated', () => {
    expect(parseCompilerResponse(full(400), { userWords: ['BOS 20, risk 1%, stop 2%, target 2R'] }).ok).toBe(true);
    expect(parseCompilerResponse(full(300, 150), { userWords: ['BOS 20 risk 1% 1:2 RR with a 1.5% stop'] }).ok).toBe(true);
    expect(parseCompilerResponse(full(300, 200), { userWords: ['BOS 20, risk 1%, stop 2%, 1.5R target'] }).ok).toBe(true);
    // 3R of a 2% stop is 6%, not 4%.
    expect(parseCompilerResponse(full(400), { userWords: ['BOS 20, risk 1%, stop 2%, target 3R'] }).ok).toBe(false);
  });

  it('does not count a price level as a distance', () => {
    const result = parseCompilerResponse(full(400), { userWords: ['BOS 20, risk 1%, stop 2%, target 70k'] });
    expect(result).toMatchObject({ ok: false, kind: 'needs_input', missing: ['target_distance'] });
    const atPrice = parseCompilerResponse(full(400), { userWords: ['BOS 20, risk 1%, stop at 64,000, target 4%'] });
    expect(atPrice).toMatchObject({ ok: false, kind: 'needs_input', missing: ['stop_distance'] });
  });

  it('reads basis points and bare figures after the word', () => {
    expect(parseCompilerResponse(full(150, 75), { userWords: ['stop 75 bps, target 150bps, BOS 20'] }).ok).toBe(true);
    expect(parseCompilerResponse(full(400), { userWords: ['BOS 20 risk 1% stop 2 target 4'] }).ok).toBe(true);
  });

  it('keeps exits the edited spec already held, stated', () => {
    const previous = { ...BOS20_15M_NO_TARGET, risk: { ...BOS20_15M_NO_TARGET.risk, targetDistanceBps: { value: 400, inferred: false } } };
    const result = parseCompilerResponse(full(400), { userWords: ['make the lookback 25'], previousSpec: previous });
    expect(result.ok).toBe(true);
    // A value the previous spec held only as a guess is not the user's.
    const guessed = { ...previous, risk: { ...previous.risk, targetDistanceBps: { value: 400, inferred: true } } };
    expect(parseCompilerResponse(full(400), { userWords: ['make the lookback 25'], previousSpec: guessed }).ok).toBe(false);
  });

  it('names what it would demote', () => {
    const spec = { ...BOS20_15M_NO_TARGET, risk: { ...BOS20_15M_NO_TARGET.risk, targetDistanceBps: { value: 400, inferred: false } } };
    expect(statedExitsNotInWords(spec, ['nothing about exits'])).toEqual(['stop_distance', 'target_distance']);
    expect(statedExitsNotInWords(spec, ['stop 2%, target 4%'])).toEqual([]);
  });

  it('without the user\'s words, trusts the stated flag', () => {
    expect(parseCompilerResponse(full(400)).ok).toBe(true);
  });
});

describe('userWordsOf', () => {
  it("keeps the user's turns and the prompt, never the compiler's", () => {
    expect(
      userWordsOf(
        [
          { from: 'user', text: 'a' },
          { from: 'assistant', text: 'b' },
          { from: 'YOU', text: 'c' },
          { from: 'KANON', text: 'd' },
        ],
        'e',
      ),
    ).toEqual(['a', 'c', 'e']);
  });
});
