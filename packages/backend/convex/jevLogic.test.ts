import { describe, expect, it } from 'vitest';
import { JEV_INTENTS, buildJevTriageRequest, jevTriageDecision, readJevTriage, type JevTriage } from './jevLogic';
import { JEV_DEFAULTS, parseJevEnv } from './serverEnv';

const answer = (choice: string, probabilities: Record<string, number>, model = 'jev-1.13.0') => ({
  model,
  answers: { intent: { type: 'choice', choice, probabilities, confidence: 0.8 } },
  usage: { input_tokens: 120, output_tokens: 0 },
});

describe('the Jev triage request', () => {
  it('asks one choice question about the message, with a description for every intent', () => {
    const body = buildJevTriageRequest({ model: 'jev-1.13.0', message: 'long BTC on a 15m break', hasRule: false });
    expect(body.model).toBe('jev-1.13.0');
    expect(body.state).toEqual({ message: 'long BTC on a 15m break', hasRule: false });
    expect(body.questions.intent.type).toBe('choice');
    expect(Object.keys(body.questions.intent.criteria).sort()).toEqual([...JEV_INTENTS].sort());
    expect(body.questions.intent.instructions).toContain('`message`');
  });
});

describe('reading the answer', () => {
  it('takes the choice and the probability Jev gave it', () => {
    expect(readJevTriage(answer('off_topic', { rule: 0.02, question: 0.01, not_price_rule: 0.01, off_topic: 0.96 }))).toEqual({
      model: 'jev-1.13.0',
      intent: 'off_topic',
      probability: 0.96,
    });
  });

  it('ignores an answer of the wrong shape instead of guessing at it', () => {
    expect(readJevTriage(null)).toBeNull();
    expect(readJevTriage({ answers: {} })).toBeNull();
    expect(readJevTriage(answer('buy', { buy: 1 }))).toBeNull();
    expect(readJevTriage(answer('question', { rule: 0.5 }))).toBeNull();
    expect(readJevTriage(answer('question', { question: 1.4 }))).toBeNull();
  });
});

describe('what the chat does with it', () => {
  const t = (intent: JevTriage['intent'], probability: number): JevTriage => ({ model: 'jev-1.13.0', intent, probability });

  it('compiles a rule, an unsure answer, and anything when Jev did not answer', () => {
    expect(jevTriageDecision(t('rule', 0.99), 0.9)).toEqual({ kind: 'compile' });
    expect(jevTriageDecision(t('not_price_rule', 0.89), 0.9)).toEqual({ kind: 'compile' });
    expect(jevTriageDecision(null, 0.9)).toEqual({ kind: 'compile' });
  });

  it('answers a sure non-rule at once, naming Jev and the probability, and says no compile ran', () => {
    for (const intent of ['not_price_rule', 'question', 'off_topic'] as const) {
      const d = jevTriageDecision(t(intent, 0.97), 0.9);
      expect(d.kind).toBe('answer');
      if (d.kind !== 'answer') continue;
      expect(d.reason).toBe(`triage:${intent}`);
      expect(d.reply).toContain('Jev (TypeSafe, jev-1.13.0)');
      expect(d.reply).toContain('97%');
      expect(d.reply).toContain('No compile was run.');
    }
  });

  it('never rounds a probability up past what Jev said', () => {
    const d = jevTriageDecision(t('off_topic', 0.999), 0.9);
    expect(d.kind === 'answer' && d.reply).toContain('99%');
  });
});

describe('the Jev settings', () => {
  it('is off with no key, with a pinned model and a 0.9 bar by default', () => {
    expect(parseJevEnv({})).toEqual({
      ok: true,
      value: { apiKey: undefined, baseUrl: JEV_DEFAULTS.baseUrl, model: 'jev-1.13.0', minProbability: 0.9 },
    });
  });

  it('takes a bar from 0.5 to 1 and refuses anything else by name', () => {
    expect(parseJevEnv({ JEV_API_KEY: 'ts-12345678', JEV_MIN_PROBABILITY: '0.95' })).toMatchObject({
      ok: true,
      value: { apiKey: 'ts-12345678', minProbability: 0.95 },
    });
    for (const bad of ['0.4', '1.5', 'high', '90%']) {
      expect(parseJevEnv({ JEV_MIN_PROBABILITY: bad })).toEqual({ ok: false, invalid: ['JEV_MIN_PROBABILITY'] });
    }
  });
});
