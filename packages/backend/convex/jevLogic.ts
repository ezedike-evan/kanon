/**
 * Chat triage with Jev (TypeSafe AI's "System One" decision model). Pure: the
 * request, the reading of the answer, and what the compile action does with it.
 * The call itself is in `compiler.ts`.
 *
 * Jev does not write and does not compile. It is asked one typed question about
 * the message in the strategy chat: is it a rule, a question, a rule on
 * something other than price, or not about trading rules at all. When it is
 * sure enough (`JEV_MIN_PROBABILITY`, default 0.9) that the message is not a
 * rule, the chat answers at once in a fixed sentence that names Jev and the
 * probability it gave, and the compiler model is not called. In every other
 * case, and whenever Jev is unset, slow or wrong-shaped, the message goes to the
 * compiler exactly as before. So Jev can only ever save a compile; it never
 * produces a spec, and the deterministic checks still decide what compiles.
 *
 * Request and answer shapes: POST {base}/systemone with
 * `{ model, state, questions: { intent: { type: 'choice', instructions, criteria } } }`,
 * answered by `{ model, answers: { intent: { type: 'choice', choice, probabilities, confidence } } }`.
 */

import { z } from 'zod';

export const JEV_INTENTS = ['rule', 'question', 'not_price_rule', 'off_topic'] as const;
export type JevIntent = (typeof JEV_INTENTS)[number];

/** What each answer means, as Jev is told it. Every key is one `JevIntent`. */
const CRITERIA: Record<JevIntent, string> = {
  rule:
    'A trading rule, or a change to the current rule: entries, exits, stop, target, risk, timeframe or market, ' +
    'including a short answer to a question the compiler asked (such as "target 4%").',
  question: 'A question about how Kanon, the compiler or the current rule works, with no change asked for.',
  not_price_rule:
    'A trading rule that depends on something other than price candles: news, sentiment, social media, ' +
    'fundamentals, on-chain flows, opinions or predictions.',
  off_topic: 'Not about a trading rule at all: greetings, chatter, requests for advice, anything else.',
};

const INSTRUCTIONS =
  'What is `message`, sent to a chat that turns a trader\'s rule into a machine-checkable spec? ' +
  '`hasRule` says whether a rule is already being written in this chat.';

export function buildJevTriageRequest(input: { model: string; message: string; hasRule: boolean }) {
  return {
    model: input.model,
    state: { message: input.message, hasRule: input.hasRule },
    questions: {
      intent: { type: 'choice' as const, instructions: INSTRUCTIONS, criteria: CRITERIA },
    },
  };
}

const JevAnswer = z.object({
  model: z.string().optional(),
  answers: z.object({
    intent: z.object({
      choice: z.enum(JEV_INTENTS),
      probabilities: z.record(z.string(), z.number().min(0).max(1)),
    }),
  }),
});

export interface JevTriage {
  /** The model version that answered (`jev-1.13.0`), when the answer named it. */
  model: string | undefined;
  intent: JevIntent;
  /** The probability Jev gave its own choice, 0..1. */
  probability: number;
}

/** The answer, or null when it is not the shape asked for: a wrong-shaped answer is ignored, never guessed at. */
export function readJevTriage(body: unknown): JevTriage | null {
  const parsed = JevAnswer.safeParse(body);
  if (!parsed.success) return null;
  const { choice, probabilities } = parsed.data.answers.intent;
  const probability = probabilities[choice];
  if (probability === undefined) return null;
  return { model: parsed.data.model, intent: choice, probability };
}

/** Whole percent, rounded down: a 0.899 is not shown as 90%. */
const percent = (p: number): string => `${Math.floor(p * 100)}%`;

const who = (t: JevTriage): string => `Jev (TypeSafe${t.model ? `, ${t.model}` : ''})`;

/**
 * What the compile action does with a triage: go on to the compiler, or answer
 * now with a sentence that says who decided and how sure it was.
 */
export function jevTriageDecision(
  triage: JevTriage | null,
  minProbability: number,
): { kind: 'compile' } | { kind: 'answer'; reason: string; reply: string } {
  if (!triage || triage.intent === 'rule' || triage.probability < minProbability) return { kind: 'compile' };
  const read = `${who(triage)} read this, at ${percent(triage.probability)}, as`;
  const none = 'No compile was run.';
  switch (triage.intent) {
    case 'not_price_rule':
      return {
        kind: 'answer',
        reason: 'triage:not_price_rule',
        reply:
          `${read} a rule on something other than price. Kanon compiles only rules that are arithmetic over ` +
          `price candles (break of structure, fair value gap, liquidity sweep) with a stop and a target you state. ` +
          `If it is a price rule, say it in those terms. ${none}`,
      };
    case 'question':
      return {
        kind: 'answer',
        reason: 'triage:question',
        reply:
          `${read} a question rather than a rule. This chat turns a rule into a spec; the info button says what it ` +
          `can compile. Describe a rule, or a change to yours. ${none}`,
      };
    case 'off_topic':
      return {
        kind: 'answer',
        reason: 'triage:off_topic',
        reply: `${read} not about a trading rule. Describe the rule you keep breaking, or a change to yours. ${none}`,
      };
  }
}
