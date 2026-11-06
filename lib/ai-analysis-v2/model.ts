/**
 * AI Analysis v2 — ONE streamed MiMo call (chat.completions, OpenAI-compatible) through the openai SDK.
 *
 * Why not LangChain's model wrapper: MiMo's thinking mode requires every assistant message that carried tool calls to
 * be replayed WITH its `reasoning_content` on later requests (MiMo docs; dropping it is a 400). Here the messages are
 * plain objects we control, so the replay is exact. The graph around this call is LangGraph (graph.ts).
 *
 * Verified against MiMo on 2026-11-06 with stream + thinking + tools: deltas carry `reasoning_content`, `content`
 * and `tool_calls`; the last chunk carries `usage` when `stream_options.include_usage` is set.
 */

import type OpenAI from 'openai';
import { getMimoClient } from '@/lib/ai-commentary/client';

/** A chat message as sent to MiMo. `reasoning_content` is MiMo's extension on assistant messages. */
export type MimoMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] }
  | {
      role: 'assistant';
      content: string;
      reasoning_content?: string;
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface MimoTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ModelResult {
  content: string;
  reasoning: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  ms: number;
}

/** A thinking round is abandoned past this (a live reply once thought for 163 s); the caller retries thinking-off. */
export const THINKING_CALL_TIMEOUT_MS = 45_000;
const CALL_TIMEOUT_MS = 90_000;

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    completion_tokens_details?: { reasoning_tokens?: number } | null;
  };
}

export async function callMimo(req: {
  model: string;
  messages: MimoMessage[];
  tools?: MimoTool[];
  thinking: boolean;
  signal?: AbortSignal;
  onReasoning?: (delta: string) => void;
  onText?: (delta: string) => void;
}): Promise<ModelResult> {
  const started = Date.now();
  const body = {
    model: req.model,
    messages: req.messages,
    ...(req.tools?.length ? { tools: req.tools, tool_choice: 'auto' } : {}),
    // MiMo ignores temperature in thinking mode; the budget covers reasoning AND the call / answer.
    ...(req.thinking ? { max_tokens: 12_000, thinking: { type: 'enabled' } } : { max_tokens: 6_000, temperature: 0.2, thinking: { type: 'disabled' } }),
    stream: true,
    stream_options: { include_usage: true },
  };
  // maxRetries 0 on a thinking round: the SDK's own retry would double the 45 s cap; the caller's thinking-off retry
  // is the recovery. A thinking-off round keeps one SDK retry for a dropped connection.
  // The SDK `timeout` stops waiting for the FIRST byte only — measured 2026-11-06, a thinking round streamed for 64 s
  // under a 45 s timeout. So the whole call (stream included) gets its own deadline, joined with the operator's Stop.
  const deadline = AbortSignal.timeout(req.thinking ? THINKING_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS);
  const signal = req.signal ? AbortSignal.any([req.signal, deadline]) : deadline;
  const stream = (await getMimoClient().chat.completions.create(body as never, {
    timeout: req.thinking ? THINKING_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS,
    maxRetries: req.thinking ? 0 : 1,
    signal,
  })) as unknown as AsyncIterable<StreamChunk>;

  let content = '';
  let reasoning = '';
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: StreamChunk['usage'] | undefined;
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const d = chunk.choices?.[0]?.delta;
    if (!d) continue;
    if (d.reasoning_content) {
      reasoning += d.reasoning_content;
      req.onReasoning?.(d.reasoning_content);
    }
    if (d.content) {
      content += d.content;
      req.onText?.(d.content);
    }
    for (const tc of d.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { id: '', name: '', arguments: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(tc.index, cur);
    }
  }
  // An aborted stream can end quietly instead of throwing. Partial output is never an answer: fail, so the caller's
  // self-healing retries (deadline) or the run stops (operator).
  if (signal.aborted) {
    throw new Error(req.signal?.aborted ? 'Stopped by the operator.' : `model call over ${Math.round((req.thinking ? THINKING_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS) / 1000)}s — abandoned`);
  }
  return {
    content,
    reasoning,
    toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).filter((c) => c.name),
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    ms: Date.now() - started,
  };
}

/** Our tool definitions in the shape MiMo takes. */
export function toMimoTools(defs: readonly { name: string; description: string; parameters: Record<string, unknown> }[]): MimoTool[] {
  return defs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export type { OpenAI };
