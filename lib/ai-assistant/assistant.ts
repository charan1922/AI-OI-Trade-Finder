/**
 * Trade Assistant orchestration — the OpenAI Responses API function-calling loop.
 *
 * Flow: send the conversation + tool schemas → if the model emits function_call
 * items, run them (real trade data) and feed the outputs back → repeat until the
 * model answers with text. Tool calls are capped so a loop can't run away.
 */

import type OpenAI from 'openai';
import { getAzureClient, getChatDeployment } from './azure-client';
import { SYSTEM_PROMPT } from './system-prompt';
import { executeTool, TOOL_DEFS } from './tools';
import type { AssistantResult, ChatMessage, ToolTraceEntry } from './types';

const MAX_TOOL_STEPS = 5;

export async function runAssistant(message: string, history: ChatMessage[] = []): Promise<AssistantResult> {
  const client = getAzureClient();
  const model = getChatDeployment();
  const toolTrace: ToolTraceEntry[] = [];

  const priorTurns = history
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content }) satisfies OpenAI.Responses.ResponseInputItem);
  const input: OpenAI.Responses.ResponseInputItem[] = [...priorTurns, { role: 'user', content: message }];

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const res = await client.responses.create({
      model,
      instructions: SYSTEM_PROMPT,
      input,
      tools: TOOL_DEFS,
      tool_choice: 'auto',
    });

    const calls = res.output.filter(
      (o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === 'function_call',
    );
    if (calls.length === 0) {
      return { reply: res.output_text || '(no reply produced)', toolTrace };
    }

    // Echo the model's FULL output back (reasoning items + function_call items),
    // then append each tool's output. Reasoning models require the reasoning item
    // to accompany its function_call, so we re-send everything the model produced.
    input.push(...(res.output as OpenAI.Responses.ResponseInputItem[]));
    for (const call of calls) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(call.arguments || '{}');
      } catch {
        parsedArgs = {};
      }
      const { result, trace } = await executeTool(call.name, parsedArgs);
      toolTrace.push(trace);
      input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
    }
  }

  // Tool budget exhausted — force a final text answer with no further tool use.
  const final = await client.responses.create({
    model,
    instructions: SYSTEM_PROMPT,
    input,
    tools: TOOL_DEFS,
    tool_choice: 'none',
  });
  return { reply: final.output_text || '(no reply produced)', toolTrace };
}
