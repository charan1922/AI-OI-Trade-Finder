/**
 * Provider-agnostic tool loop — the ONE place that knows how to run a
 * function-calling conversation on each backend:
 *
 *   azure — Azure OpenAI Responses API (mirrors lib/ai-assistant/assistant.ts:
 *           echo the model's full output back, reasoning items included).
 *   mimo  — Xiaomi MiMo chat.completions with `tools` (OpenAI-compatible;
 *           reasoning model — budget covers thinking + answer, read `content`).
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
  execute: (name: string, args: Record<string, unknown>) => Promise<{ result: unknown; trace: ToolTraceEntry }>;
}

/** One timed sub-action of the loop (a model call or a tool execution) — the
 *  cycle timeline renders these so a slow pass shows WHERE the time went. */
export interface LoopSpan {
  name: string;
  ms: number;
}

export interface ToolLoopResult {
  text: string;
  model: string;
  trace: ToolTraceEntry[];
  promptTokens: number | null;
  completionTokens: number | null;
  spans: LoopSpan[];
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

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
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

async function runMimoLoop(req: ToolLoopRequest, signal: AbortSignal): Promise<ToolLoopResult> {
  const client = getMimoClient();
  const model = getMimoModel(req.mimoModel);
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = req.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const trace: ToolTraceEntry[] = [];
  const spans: LoopSpan[] = [];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: req.system },
    { role: 'user', content: req.user },
  ];
  let promptTokens = 0;
  let completionTokens = 0;

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const modelT0 = Date.now();
    const res = await client.chat.completions.create(
      {
        model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.2,
        // Reasoning model: thinking bills against this too (same budget logic
        // as lib/ai-commentary/generate.ts — an exhausted budget = empty content).
        max_tokens: 6000,
      },
      { timeout: 90_000, signal },
    );
    spans.push({ name: `model call #${step + 1}`, ms: Date.now() - modelT0 });
    promptTokens += res.usage?.prompt_tokens ?? 0;
    completionTokens += res.usage?.completion_tokens ?? 0;
    const msg = res.choices?.[0]?.message;
    if (!msg) throw new Error('MiMo returned no message');

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      const text = (msg.content ?? '').trim();
      if (!text) throw new Error('MiMo returned empty content (reasoning may have consumed the token budget).');
      return { text, model, trace, promptTokens, completionTokens, spans };
    }
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
    for (const call of calls) {
      if (call.type !== 'function') continue;
      const toolT0 = Date.now();
      const { result, trace: t } = await req.execute(call.function.name, parseArgs(call.function.arguments));
      t.ms = Date.now() - toolT0;
      spans.push({ name: `tool ${call.function.name}`, ms: t.ms });
      trace.push(t);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  // Step cap hit — one final call with tools removed to force a summary.
  const finalT0 = Date.now();
  const final = await client.chat.completions.create(
    { model, messages, temperature: 0.2, max_tokens: 6000 },
    { timeout: 90_000, signal },
  );
  spans.push({ name: 'model call (forced final)', ms: Date.now() - finalT0 });
  promptTokens += final.usage?.prompt_tokens ?? 0;
  completionTokens += final.usage?.completion_tokens ?? 0;
  const text = (final.choices?.[0]?.message?.content ?? '').trim();
  return { text: text || '(no summary produced)', model, trace, promptTokens, completionTokens, spans };
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
