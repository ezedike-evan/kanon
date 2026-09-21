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
import { RULE_04, diffSpec, type StrategySpec } from '@kanon/spec';
import {
  buildCompilerPrompt,
  parseCompilerResponse,
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
          stopDistanceBps: { value: 50, inferred: true },
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
