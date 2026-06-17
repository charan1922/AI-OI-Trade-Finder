'use client';

import { useCallback, useState } from 'react';

export interface ToolTraceEntry {
  name: string;
  args: Record<string, unknown>;
  summary: string;
  ok: boolean;
  data?: unknown;
}

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  toolTrace?: ToolTraceEntry[];
  pending?: boolean;
  isError?: boolean;
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [loading, setLoading] = useState(false);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;

      // History = the conversation so far (before this turn), text only.
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '', pending: true },
      ]);
      setLoading(true);

      try {
        const res = await fetch('/api/ai-assistant/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: trimmed, history }),
        });
        const data = (await res.json()) as {
          reply?: string;
          toolTrace?: ToolTraceEntry[];
          error?: string;
        };
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            role: 'assistant',
            content: data.reply ?? data.error ?? 'No reply.',
            toolTrace: data.toolTrace ?? [],
            isError: Boolean(data.error),
          };
          return copy;
        });
      } catch (e) {
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            role: 'assistant',
            content: `Network error: ${(e as Error).message}`,
            isError: true,
          };
          return copy;
        });
      } finally {
        setLoading(false);
      }
    },
    [messages, loading],
  );

  const reset = useCallback(() => setMessages([]), []);

  return { messages, loading, send, reset };
}
