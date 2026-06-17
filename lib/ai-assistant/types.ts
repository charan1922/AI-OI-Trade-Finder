/** Shared types for the Trade Assistant module. */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** One tool invocation, surfaced to the UI for transparency (what data the bot read). */
export interface ToolTraceEntry {
  name: string;
  args: Record<string, unknown>;
  /** Short human-readable summary of what the tool returned. */
  summary: string;
  ok: boolean;
  /** The raw tool result — surfaced in the UI as a "supporting data" panel so the
   *  user can validate the answer against the actual numbers. */
  data?: unknown;
}

export interface AssistantResult {
  reply: string;
  toolTrace: ToolTraceEntry[];
  /** Set when generation failed (missing config, API error). reply holds the message. */
  error?: string;
}
