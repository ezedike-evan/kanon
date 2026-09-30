"use node";

/**
 * The chat-to-spec compiler (`docs/ARCHITECTURE.md` -> "Compiler").
 *
 * An LLM turns natural language into a candidate spec. The model's job is
 * translation, not prediction. Output is schema-validated against
 * `StrategySpec` from `@kanon/spec`; a schema failure retries with the
 * validation error fed back to the model, up to `MAX_ATTEMPTS` times. A
 * partially valid spec is never returned to the caller — either a full
 * `StrategySpec`, a typed rejection (the request wasn't expressible as one
 * of the three predicates), or a typed failure.
 *
 * This file only wires the LLM API call together. The prompt and the
 * response validation are pure functions in `compilerLogic.ts`, so they can
 * be snapshot-tested against a fixture set without hitting the network —
 * see `compilerLogic.test.ts` and the "Compiler drift" failure mode in
 * `docs/ARCHITECTURE.md`.
 *
 * Provider: Alibaba Cloud Model Studio (DashScope), Qwen3.8-Max, via its
 * OpenAI-compatible `chat.completions` endpoint. Chosen over Moonshot Kimi
 * K3 and Tencent Hunyuan because DashScope is the only one of the three with
 * an officially documented, schema-*enforced* structured-output mode
 * (`response_format: {type: "json_schema", json_schema: {..., strict: true}}`,
 * per https://www.alibabacloud.com/help/en/model-studio/json-mode) — Kimi's
 * "JSON Mode" only guarantees syntactically valid JSON, not a specific
 * shape, and Hunyuan's English documentation does not clearly specify
 * structured-output behavior at all. All three are OpenAI-API-compatible,
 * so this module uses the `openai` package pointed at DashScope's base URL
 * rather than a bespoke client or raw `fetch`.
 *
 * This module is action-only ("use node" — the OpenAI SDK needs the Node
 * runtime), so it exports nothing but the action below.
 */

import { action } from './_generated/server';
import { v } from 'convex/values';
import OpenAI from 'openai';
import { specHash, diffSpec, parseSpec, type StrategySpec, type SpecDiff } from '@kanon/spec';
import { requireSubject } from './authz';
import { buildCompilerPrompt, parseCompilerResponse, type CompilerTurn } from './compilerLogic';

/**
 * DashScope's OpenAI-compatible endpoint. International (Singapore) region —
 * see https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope.
 * Use the China (Beijing) endpoint (`https://dashscope.aliyuncs.com/compatible-mode/v1`)
 * instead if the DashScope account/workspace is provisioned in mainland China.
 */
const DASHSCOPE_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

/**
 * Pinned model version. Per docs/ARCHITECTURE.md's "Compiler drift" failure
 * mode ("the same prompt producing different specs"), this must be bumped
 * deliberately, never silently — and the fixture set in
 * compilerLogic.test.ts should be re-run against the new version before the
 * bump ships.
 *
 * qwen3.8-max-0902 is Alibaba's current flagship Qwen model as of this
 * writing (released 2026-09-02, a post-training update to Qwen3.8-Max,
 * itself released 2026-08-03 — see
 * https://openrouter.ai/qwen/qwen3.8-max-0902 and
 * https://www.marktechpost.com/2026/08/03/alibaba-qwen-releases-qwen3-8-max/).
 * It is one of the model families DashScope's JSON Schema structured-output
 * mode explicitly supports
 * (https://www.alibabacloud.com/help/en/model-studio/json-mode).
 */
const COMPILER_MODEL = 'qwen3.8-max-0902';

/** Small fixed retry count on schema-validation failure, per ARCHITECTURE.md. */
const MAX_ATTEMPTS = 3;

type CompileResult =
  | {
      status: 'compiled';
      spec: StrategySpec;
      reply: string;
      specHash: string;
      diff: SpecDiff | null;
    }
  | { status: 'rejected'; reply: string; reason: string }
  | { status: 'failed'; error: string };

/** Input caps. Every call spends model credits, so nothing unbounded reaches the prompt. */
const MAX_PROMPT_CHARS = 4_000;
const MAX_HISTORY_TURNS = 20;
const MAX_TURN_CHARS = 4_000;
const REQUEST_TIMEOUT_MS = 60_000;

export const compileStrategy = action({
  args: {
    prompt: v.string(),
    previousSpec: v.optional(v.any()),
    conversationHistory: v.optional(
      v.array(v.object({ from: v.union(v.literal('user'), v.literal('assistant')), text: v.string() })),
    ),
  },
  handler: async (ctx, args): Promise<CompileResult> => {
    // Every call spends model credits: signed-in users only.
    await requireSubject(ctx);

    const history = args.conversationHistory ?? [];
    if (
      args.prompt.length === 0 ||
      args.prompt.length > MAX_PROMPT_CHARS ||
      history.length > MAX_HISTORY_TURNS ||
      history.some((turn) => turn.text.length > MAX_TURN_CHARS)
    ) {
      return { status: 'failed', error: 'Input is empty or too long. Shorten it and try again.' };
    }

    // previousSpec is user-controlled and is interpolated into the prompt: it must be a real spec.
    let previousSpec: StrategySpec | undefined;
    if (args.previousSpec !== undefined) {
      try {
        previousSpec = parseSpec(args.previousSpec);
      } catch {
        return { status: 'failed', error: 'The previous spec is not a valid strategy spec.' };
      }
    }

    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      console.error('compileStrategy: DASHSCOPE_API_KEY is not set');
      return { status: 'failed', error: 'The compiler is unavailable right now.' };
    }
    const client = new OpenAI({
      apiKey,
      baseURL: DASHSCOPE_BASE_URL,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 1,
    });

    let retryFeedback: string | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const request = buildCompilerPrompt(
        {
          prompt: args.prompt,
          previousSpec,
          conversationHistory: args.conversationHistory as CompilerTurn[] | undefined,
        },
        retryFeedback,
      );

      // Adapt the provider-agnostic request built by compilerLogic.ts into
      // the OpenAI-compatible `chat.completions` wire shape: a leading
      // system message, a `{type: "function", function: {...}}` tool
      // definition, and forced tool choice by name.
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: 'system', content: request.system },
        ...request.messages,
      ];

      const tool: OpenAI.ChatCompletionTool = {
        type: 'function',
        function: {
          name: request.tool.name,
          description: request.tool.description,
          parameters: request.tool.input_schema,
        },
      };

      let response: OpenAI.ChatCompletion;
      try {
        response = await client.chat.completions.create({
          model: COMPILER_MODEL,
          max_tokens: 8192,
          messages,
          tools: [tool],
          tool_choice: { type: 'function', function: { name: request.tool.name } },
        });
      } catch (err) {
        // Provider detail stays in the server log; the client gets a generic message.
        console.error('compileStrategy: provider call failed', err);
        if (err instanceof OpenAI.RateLimitError) {
          return { status: 'failed', error: 'The compiler is busy. Try again shortly.' };
        }
        return { status: 'failed', error: 'The compiler is unavailable right now.' };
      }

      const choice = response.choices[0];

      if (choice?.finish_reason === 'content_filter') {
        return { status: 'failed', error: 'The compiler declined to process this request.' };
      }

      const toolCall = choice?.message?.tool_calls?.find(
        (call): call is OpenAI.ChatCompletionMessageFunctionToolCall =>
          call.type === 'function' && call.function.name === request.tool.name,
      );

      if (!toolCall) {
        retryFeedback =
          'You did not call emit_compiled_spec. You must always call it — never respond in plain text.';
        continue;
      }

      let toolInput: unknown;
      try {
        toolInput = JSON.parse(toolCall.function.arguments);
      } catch {
        // Not syntactically valid JSON — feed that back and retry rather
        // than crash. Per ARCHITECTURE.md: "Retry on schema failure. Never
        // accept partially valid output."
        retryFeedback = 'Your last call to emit_compiled_spec did not have valid JSON arguments.';
        continue;
      }

      const parsed = parseCompilerResponse(toolInput);

      if (parsed.ok) {
        const hash = await specHash(parsed.spec);
        const diff: SpecDiff | null = previousSpec ? diffSpec(previousSpec, parsed.spec) : null;
        return { status: 'compiled', spec: parsed.spec, reply: parsed.reply, specHash: hash, diff };
      }

      if (parsed.kind === 'rejected') {
        return { status: 'rejected', reply: parsed.reply, reason: parsed.reason };
      }

      // Schema validation failed — retry with the error fed back, per
      // ARCHITECTURE.md: "Retry on schema failure. Never accept partially
      // valid output."
      retryFeedback = parsed.error;
    }

    return {
      status: 'failed',
      error: `Could not produce a valid spec after ${MAX_ATTEMPTS} attempts. Last error: ${retryFeedback}`,
    };
  },
});
