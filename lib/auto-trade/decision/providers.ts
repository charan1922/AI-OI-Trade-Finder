/**
 * Provider-agnostic tool loop — the ONE place that knows how to run a
 * function-calling conversation on each backend:
 *
 *   azure — Azure OpenAI Responses API (mirrors lib/ai-assistant/assistant.ts:
 *           echo the model's full output back, reasoning items included).
 *   mimo  — Xiaomi MiMo chat.completions with `tools` (OpenAI-compatible;
 *           thinking explicitly disabled for stable multi-round tool use).
 *
 * Both loops execute tools SEQUENTIALLY (they share the Dhan/broker rate
 * gates) and stop on a plain-text answer or the step cap.
 */

import type OpenAI from 'openai';
import { getAzureClient, getChatDeployment } from '@/lib/ai-assistant/azure-client';
import { getMimoClient, getMimoModel } from '@/lib/ai-commentary/client';
import { MAX_TOOL_STEPS } from '../config';
import type { AiProvider, ToolTraceEntry } from '../types';
import type { NeutralToolDef } from '../tools/defs';

export interface ToolLoopRequest {
  provider: AiProvider;
  /** Runtime MiMo tier. Ignored by Azure; falls back to env/default when absent. */
  mimoModel?: string;
  system: string;
  user: string;
  tools: NeutralToolDef[];
  /** Operator chat only (Commentary v2): screenshots as data URLs, sent with the user turn. MiMo only —
   *  the auto-trader never sets this. */
  images?: string[];
  /** Operator chat (Commentary v2, agentic) may take more steps than a trading pass; default MAX_TOOL_STEPS. */
  maxSteps?: number;
  /** Commentary v2 only, MiMo only: run WITH thinking and replay each step's reasoning_content (MiMo's rule —
   *  dropping it is a 400). The auto-trader never sets this; its calls stay thinking-disabled. */
  thinking?: boolean | 'first';
  /** Commentary v2 only: live progress — called as each model call / tool starts and ends. Never awaited. */
  onStep?: (e: LoopStepEvent) => void;
  execute: (name: string, args: Record<string, unknown>) => Promise<{ result: unknown; trace: ToolTraceEntry }>;
}

/** One timed sub-action of the loop (a model call or a tool execution) — the
 *  cycle timeline renders these so a slow pass shows WHERE the time went. */
export interface LoopSpan {
  name: string;
  ms: number;
}

/** One live progress event of the loop (Commentary v2 shows these as they happen). */
export type LoopStepEvent =
  | { kind: 'model'; phase: 'start' | 'end'; step: number; ms?: number }
  | { kind: 'tool'; phase: 'start' | 'end'; name: string; args: Record<string, unknown>; ok?: boolean; summary?: string; ms?: number };

export interface ToolLoopResult {
  text: string;
  model: string;
  trace: ToolTraceEntry[];
  promptTokens: number | null;
  completionTokens: number | null;
  spans: LoopSpan[];
  /** Thinking runs only (req.thinking): the model's own reasoning text, one entry per model call that had any. */
  reasoning?: string[];
  /** Thinking runs only: MiMo's own count of reasoning tokens (usage.completion_tokens_details.reasoning_tokens). */
  reasoningTokens?: number;
  /** MiMo: prompt tokens served from its prompt cache (usage.prompt_tokens_details.cached_tokens), summed. */
  cachedTokens?: number;
}

function parseArgs(raw: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Hard wall-clock deadline for one full decision pass. Without it a hung
 * provider endpoint stalls the pass forever: the engine lease keeps renewing,
 * every later cycle reports "previous pass still running", and decisions +
 * commentary silently stop until a restart (H2, forensic audit). The signal is
 * threaded into every SDK call; ipv4Fetch honors it, so the socket actually
 * dies when the deadline fires. The guard is unaffected — it runs before the AI.
 */
const AI_PASS_DEADLINE_MS = 3 * 60_000;

// ─── Azure OpenAI (Responses API) ────────────────────────────────────────────

async function runAzureLoop(req: ToolLoopRequest, signal: AbortSignal): Promise<ToolLoopResult> {
  const client = getAzureClient();
  const model = getChatDeployment();
  const tools: OpenAI.Responses.Tool[] = req.tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    strict: false,
    parameters: t.parameters,
  }));
  const trace: ToolTraceEntry[] = [];
  const spans: LoopSpan[] = [];
  const input: OpenAI.Responses.ResponseInputItem[] = [{ role: 'user', content: req.user }];
  let promptTokens = 0;
  let completionTokens = 0;

  for (let step = 0; step < (req.maxSteps ?? MAX_TOOL_STEPS); step++) {
    const modelT0 = Date.now();
    const res = await client.responses.create(
      {
        model,
        instructions: req.system,
        input,
        tools,
        tool_choice: 'auto',
      },
      { signal },
    );
    spans.push({ name: `model call #${step + 1}`, ms: Date.now() - modelT0 });
    promptTokens += res.usage?.input_tokens ?? 0;
    completionTokens += res.usage?.output_tokens ?? 0;

    const calls = res.output.filter(
      (o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === 'function_call',
    );
    if (calls.length === 0) {
      return { text: res.output_text || '(no summary produced)', model, trace, promptTokens, completionTokens, spans };
    }
    // Echo the full output back (reasoning items must accompany their calls).
    input.push(...(res.output as OpenAI.Responses.ResponseInputItem[]));
    for (const call of calls) {
      const toolT0 = Date.now();
      const { result, trace: t } = await req.execute(call.name, parseArgs(call.arguments));
      t.ms = Date.now() - toolT0;
      spans.push({ name: `tool ${call.name}`, ms: t.ms });
      trace.push(t);
      input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
    }
  }

  // Step cap hit — force a final text summary with tools disabled.
  const finalT0 = Date.now();
  const final = await client.responses.create(
    {
      model,
      instructions: req.system,
      input,
      tools,
      tool_choice: 'none',
    },
    { signal },
  );
  spans.push({ name: 'model call (forced final)', ms: Date.now() - finalT0 });
  promptTokens += final.usage?.input_tokens ?? 0;
  completionTokens += final.usage?.output_tokens ?? 0;
  return { text: final.output_text || '(no summary produced)', model, trace, promptTokens, completionTokens, spans };
}

// ─── MiMo (chat.completions + tools) ─────────────────────────────────────────

export const MIMO_TOOL_THINKING = { type: 'disabled' } as const;

type MimoChatBody = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
  thinking: typeof MIMO_TOOL_THINKING;
};

function disableMimoThinking(
  body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
): MimoChatBody {
  // Xiaomi's OpenAI-compatible endpoint accepts this provider extension at the
  // top level. The upstream OpenAI type does not declare provider extensions,
  // but the SDK serializes the supplied body verbatim (proved by CI's mocked
  // HTTP transport test in verify-ai-decision-context.ts).
  return { ...body, thinking: MIMO_TOOL_THINKING };
}

/** Exported only to contract-test the serialized MiMo HTTP exchange without a
 * real API call. Production uses the wrapper below with the configured client. */
export async function runMimoLoopWithClient(
  req: ToolLoopRequest,
  client: OpenAI,
  model: string,
  signal: AbortSignal
): Promise<ToolLoopResult> {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = req.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const trace: ToolTraceEntry[] = [];
  const spans: LoopSpan[] = [];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: req.system },
    {
      role: 'user',
      content: req.images?.length
        ? [
            { type: 'text', text: req.user },
            ...req.images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          ]
        : req.user,
    },
  ];
  let promptTokens = 0;
  let completionTokens = 0;
  const reasoning: string[] = [];
  let reasoningTokens = 0;
  let cachedTokens = 0;
  const emit = (e: LoopStepEvent) => {
    try {
      req.onStep?.(e);
    } catch {
      // progress is display-only — never let it break the loop
    }
  };
  const done = (text: string): ToolLoopResult => ({
    text,
    model,
    trace,
    promptTokens,
    completionTokens,
    spans,
    ...(req.thinking ? { reasoning, reasoningTokens } : {}),
    cachedTokens,
  });

  for (let step = 0; step < (req.maxSteps ?? MAX_TOOL_STEPS); step++) {
    const modelT0 = Date.now();
    emit({ kind: 'model', phase: 'start', step: step + 1 });
    // 'first' = think only on the planning round; later rounds (reading tool results, writing) run thinking
    // OFF — much faster. Earlier rounds' reasoning_content is still replayed as MiMo requires.
    const thinkNow = req.thinking === true || (req.thinking === 'first' && step === 0);
    const res = await client.chat.completions.create(
      thinkNow
        ? // Thinking ON (v2 chat only): MiMo ignores temperature in thinking mode; the budget covers the
          // reasoning AND the call/answer, so it is larger than the thinking-off budget below.
          ({ model, messages, tools, tool_choice: 'auto', max_tokens: 12000, thinking: { type: 'enabled' } } as never)
        : disableMimoThinking({
            model,
            messages,
            tools,
            tool_choice: 'auto',
            temperature: 0.2,
            // Tool calls run with thinking disabled, so this budget is available to
            // the actual calls and final audit read rather than hidden reasoning.
            max_tokens: 6000,
          }),
      { timeout: 90_000, signal },
    );
    const modelMs = Date.now() - modelT0;
    spans.push({ name: `model call #${step + 1}`, ms: modelMs });
    emit({ kind: 'model', phase: 'end', step: step + 1, ms: modelMs });
    promptTokens += res.usage?.prompt_tokens ?? 0;
    completionTokens += res.usage?.completion_tokens ?? 0;
    reasoningTokens += res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    cachedTokens += res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const msg = res.choices?.[0]?.message;
    if (!msg) throw new Error('MiMo returned no message');
    // MiMo's provider extension: present only when thinking is on.
    const thought = thinkNow ? ((msg as { reasoning_content?: string | null }).reasoning_content ?? '').trim() : '';
    if (thought) reasoning.push(thought);

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      const text = (msg.content ?? '').trim();
      if (!text) throw new Error('MiMo returned empty content (reasoning may have consumed the token budget).');
      return done(text);
    }
    // MiMo rule (thinking mode): an assistant message with tool calls must be replayed WITH its
    // reasoning_content on every later request, or the API answers 400.
    messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      tool_calls: calls,
      ...(req.thinking && thought ? { reasoning_content: thought } : {}),
    } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam);
    for (const call of calls) {
      if (call.type !== 'function') continue;
      const toolT0 = Date.now();
      const args = parseArgs(call.function.arguments);
      emit({ kind: 'tool', phase: 'start', name: call.function.name, args });
      const { result, trace: t } = await req.execute(call.function.name, args);
      t.ms = Date.now() - toolT0;
      emit({ kind: 'tool', phase: 'end', name: call.function.name, args, ok: t.ok, summary: t.summary, ms: t.ms });
      spans.push({ name: `tool ${call.function.name}`, ms: t.ms });
      trace.push(t);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  // Step cap hit — one final call with tools removed to force a summary.
  const finalT0 = Date.now();
  const final = await client.chat.completions.create(
    disableMimoThinking({ model, messages, temperature: 0.2, max_tokens: 6000 }),
    { timeout: 90_000, signal },
  );
  spans.push({ name: 'model call (forced final)', ms: Date.now() - finalT0 });
  promptTokens += final.usage?.prompt_tokens ?? 0;
  completionTokens += final.usage?.completion_tokens ?? 0;
  const text = (final.choices?.[0]?.message?.content ?? '').trim();
  return done(text || '(no summary produced)');
}

async function runMimoLoop(req: ToolLoopRequest, signal: AbortSignal): Promise<ToolLoopResult> {
  return runMimoLoopWithClient(req, getMimoClient(), getMimoModel(req.mimoModel), signal);
}

export async function runToolLoop(req: ToolLoopRequest): Promise<ToolLoopResult> {
  const signal = AbortSignal.timeout(AI_PASS_DEADLINE_MS);
  try {
    return await (req.provider === 'mimo' ? runMimoLoop(req, signal) : runAzureLoop(req, signal));
  } catch (err) {
    if (signal.aborted) {
      throw new Error(
        `AI pass exceeded the ${Math.round(AI_PASS_DEADLINE_MS / 60_000)}-min hard deadline and was aborted (provider ${req.provider})`
      );
    }
    throw err;
  }
}
