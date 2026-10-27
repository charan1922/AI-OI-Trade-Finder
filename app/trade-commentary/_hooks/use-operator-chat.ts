'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ChatMessage {
  id: number;
  date: string;
  role: 'user' | 'assistant';
  content: string;
  /** ISO timestamp (UTC) — the same format as commentary rows, so one thread sorts correctly. */
  at: string;
}

/** A line that is not stored (model unavailable / not sent). Transient, never part of the thread. */
export interface ChatNotice {
  key: string;
  text: string;
}

const SYNC_MS = 15_000;

/** YYYY-MM-DD in IST — groups an optimistic message under the right day divider. */
function istToday(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * The operator's side of the /trade-commentary thread. Messages come back as
 * rows the page merges into the SAME stream as the AI's commentary reads — it
 * is one conversation, not a second box. Independent of commentary generation
 * on purpose: nothing here waits on, or is disabled by, a generating pass, and
 * every message is its own request so a slow reply never blocks the next one.
 */
export function useOperatorChat(enabled = true) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notices, setNotices] = useState<ChatNotice[]>([]);
  const [pending, setPending] = useState(0);
  const [configured, setConfigured] = useState(true);
  const pendingRef = useRef(0);

  const sync = useCallback(async () => {
    // Viewers never see (or fetch) the operator's thread. Never overwrite it while a send is in flight —
    // it would drop the optimistic message.
    if (!enabled || pendingRef.current > 0) return;
    try {
      const res = await fetch('/api/trade-commentary/chat', { cache: 'no-store' });
      const j = (await res.json()) as { messages?: ChatMessage[]; configured?: boolean };
      if (res.ok && j.messages && pendingRef.current === 0) {
        setMessages(j.messages);
        setConfigured(j.configured !== false);
      }
    } catch {
      // Best effort — the thread simply stays as it is.
    }
  }, [enabled]);

  useEffect(() => {
    // Same kick-off pattern as the page's own load(): first fetch on the next tick, not in the effect body.
    const kick = setTimeout(() => void sync(), 0);
    const t = setInterval(() => void sync(), SYNC_MS);
    return () => {
      clearTimeout(kick);
      clearInterval(t);
    };
  }, [sync]);

  const addNotice = useCallback((text: string) => {
    setNotices((n) => [...n.slice(-2), { key: `${Date.now()}-${Math.random()}`, text }]);
  }, []);

  /** Resolves true once the message is SAVED (so the trader will read it); false if it was not sent. */
  const send = useCallback(
    async (raw: string): Promise<boolean> => {
      const text = raw.trim();
      if (!text) return false;
      pendingRef.current += 1;
      setPending(pendingRef.current);
      // Optimistic: show it immediately; the server's saved copy replaces it below.
      const tempId = -Date.now();
      setMessages((prev) => [
        ...prev,
        { id: tempId, date: istToday(), role: 'user', content: text, at: new Date().toISOString() },
      ]);
      try {
        const res = await fetch('/api/trade-commentary/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text }),
        });
        const j = (await res.json()) as {
          error?: string;
          saved?: ChatMessage;
          reply?: ChatMessage | null;
          notice?: string;
        };
        if (!res.ok) {
          // Not saved — take the bubble back so the thread never claims the trader heard it.
          setMessages((prev) => prev.filter((m) => m.id !== tempId));
          addNotice(j.error ?? `Failed (${res.status}) — not sent.`);
          return false;
        }
        setMessages((prev) => {
          const next = prev.map((m) => (m.id === tempId && j.saved ? j.saved : m));
          return j.reply ? [...next, j.reply] : next;
        });
        if (j.notice) addNotice(j.notice);
        return true;
      } catch (e) {
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        addNotice(`Network error — not sent: ${(e as Error).message}`);
        return false;
      } finally {
        pendingRef.current -= 1;
        setPending(pendingRef.current);
      }
    },
    [addNotice]
  );

  const dismissNotice = useCallback((key: string) => setNotices((n) => n.filter((x) => x.key !== key)), []);

  return { messages, notices, pending, configured, send, dismissNotice };
}
