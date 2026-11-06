'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, V2Message } from '@/lib/ai-analysis-v2/types';
import type { AutoTradeState, BackgroundState, CycleTimeline, LiveTurn, RaceState, TraderRead } from '../_lib/v2-view';

/** Thread + background change fastest (a wake-up or check-in must show within seconds). */
const FAST_MS = 5_000;
/** Trader console, selector checks, cycles, log tail. /api/auto-trade's broker P&L is TTL-cached server-side. */
const SLOW_MS = 20_000;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, json };
  } catch (e) {
    return { ok: false, json: { error: `Network error: ${(e as Error).message}` } };
  }
}

/** Parse a text/event-stream body into AgentEvents as they arrive. */
async function* readEvents(res: Response): AsyncGenerator<AgentEvent> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (!event || !data) continue;
      try {
        yield { event, data: JSON.parse(data) } as AgentEvent;
      } catch {
        // a malformed chunk is skipped; the saved answer replaces the live view at the end anyway
      }
    }
  }
}

/** Everything /ai-analysis-v2 shows. One hook so the page stays a render layer. Admin-only page. */
export function useV2Data() {
  const [messages, setMessages] = useState<V2Message[]>([]);
  const [configured, setConfigured] = useState(true);
  const [background, setBackground] = useState<BackgroundState | null>(null);
  const [reads, setReads] = useState<TraderRead[]>([]);
  const [timelines, setTimelines] = useState<CycleTimeline[]>([]);
  const [autoTrade, setAutoTrade] = useState<AutoTradeState | null>(null);
  const [race, setRace] = useState<RaceState | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState<LiveTurn | null>(null);
  /** The run in flight (one at a time from this page) — what Stop aborts. */
  const runRef = useRef<string | null>(null);

  const loadFast = useCallback(async () => {
    const [chat, bg] = await Promise.all([
      runRef.current ? null : getJson<{ messages?: V2Message[]; configured?: boolean }>('/api/ai-analysis-v2/chat'),
      getJson<BackgroundState & { success?: boolean }>('/api/ai-analysis-v2/background'),
    ]);
    if (chat?.messages && !runRef.current) {
      setMessages(chat.messages);
      setConfigured(chat.configured !== false);
    }
    if (bg?.success) setBackground(bg);
  }, []);

  const loadSlow = useCallback(async () => {
    const [feed, at, rc, logs] = await Promise.all([
      getJson<{ rows?: TraderRead[]; timelines?: CycleTimeline[] }>('/api/ai-analysis-v2/feed'),
      getJson<AutoTradeState & { success?: boolean }>('/api/auto-trade'),
      getJson<RaceState & { success?: boolean }>('/api/tf/race'),
      getJson<{ lines?: string[] }>('/api/logs?lines=400'),
    ]);
    if (feed?.rows) setReads(feed.rows);
    if (feed?.timelines) setTimelines(feed.timelines);
    if (at?.success) setAutoTrade(at);
    if (rc && rc.success !== false) setRace(rc);
    if (logs?.lines) setLogLines(logs.lines.filter((l) => /\[(chat-watch|auto-trade)\]/.test(l)).slice(-60));
  }, []);

  useEffect(() => {
    const kick = setTimeout(() => {
      void loadFast();
      void loadSlow();
    }, 0);
    const fast = setInterval(() => void loadFast(), FAST_MS);
    const slow = setInterval(() => void loadSlow(), SLOW_MS);
    return () => {
      clearTimeout(kick);
      clearInterval(fast);
      clearInterval(slow);
    };
  }, [loadFast, loadSlow]);

  /** Send a message and draw the answer live from the server-sent events. `think` = the Think switch. */
  const send = useCallback(
    async (text: string, images: string[] = [], think = true): Promise<boolean> => {
      const message = text.trim();
      if (!message || runRef.current) return false;
      const runId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      runRef.current = runId;
      const tempId = -Date.now();
      setMessages((prev) => [
        ...prev,
        { id: tempId, date: '', role: 'user', content: message, at: new Date().toISOString(), model: null, details: null, action: null, images: null, partial: false, failureReason: null },
      ]);
      setLive({ startedAt: Date.now(), reasoning: '', text: '', steps: [], plan: null, notes: [] });
      try {
        const res = await fetch('/api/ai-analysis-v2/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, images, runId, think }),
        });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setMessages((prev) => prev.filter((m) => m.id !== tempId));
          setNotice(j.error ?? `Not sent (${res.status}).`);
          return false;
        }
        for await (const e of readEvents(res)) {
          setLive((cur) => {
            if (!cur) return cur;
            switch (e.event) {
              case 'reasoning':
                return { ...cur, reasoning: cur.reasoning + e.data.text };
              case 'delta':
                return { ...cur, text: cur.text + e.data.text };
              case 'reset':
                return { ...cur, text: '' };
              case 'step':
                return { ...cur, steps: [...cur.steps, { ...e.data, key: e.data.id, detail: null, ok: true, ms: null, running: true }] };
              case 'step_done':
                return { ...cur, steps: cur.steps.map((s) => (s.id === e.data.id ? { ...e.data, running: false } : s)) };
              case 'plan':
                return { ...cur, plan: e.data.steps };
              case 'note':
                return { ...cur, notes: [...cur.notes, e.data.text] };
              default:
                return cur;
            }
          });
          if (e.event === 'error') setNotice(e.data.message);
        }
        return true;
      } catch (err) {
        setNotice(`Connection lost: ${(err as Error).message}. The answer is still saved when it finishes.`);
        return false;
      } finally {
        runRef.current = null;
        setLive(null);
        await loadFast();
      }
    },
    [loadFast]
  );

  /** Stop: the server aborts the run (and its in-flight model call); the answer is saved as partial. */
  const stop = useCallback(async () => {
    const runId = runRef.current;
    if (!runId) return;
    const { ok, json } = await postJson('/api/ai-analysis-v2/chat/stop', { runId });
    if (!ok) setNotice(String(json.error ?? 'Could not stop.'));
  }, []);

  const act = useCallback(
    async (messageId: number, decision: 'confirm' | 'cancel') => {
      const { ok, json } = await postJson('/api/ai-analysis-v2/action', { messageId, decision });
      if (!ok && json.error) setNotice(String(json.error));
      await loadFast();
    },
    [loadFast]
  );

  const background_ = useCallback(
    async (body: Record<string, unknown>, okNotice?: string) => {
      const { ok, json } = await postJson('/api/ai-analysis-v2/background', body);
      if (!ok) setNotice(String(json.error ?? 'Not changed.'));
      else if (okNotice) setNotice(okNotice);
      await loadFast();
    },
    [loadFast]
  );

  const decideApproval = useCallback(
    async (tradeId: number, action: 'approve' | 'reject') => {
      const { json } = await postJson('/api/auto-trade/action', { action, tradeId });
      setNotice(String(json.message ?? json.error ?? `${action} sent`));
      await loadSlow();
    },
    [loadSlow]
  );

  return {
    messages,
    configured,
    background,
    reads,
    timelines,
    autoTrade,
    race,
    logLines,
    pending: live ? 1 : 0,
    live,
    notice,
    dismissNotice: () => setNotice(null),
    showNotice: (msg: string) => setNotice(msg),
    send,
    stop,
    act,
    setBackgroundOn: (enabled: boolean) => background_({ action: 'toggle', enabled }),
    cancelWatch: (id: number) => background_({ action: 'cancel_watch', id }),
    setAutoAction: (kind: string, auto: boolean) => background_({ action: 'set_auto_action', kind, auto }),
    decideMemory: (id: number, action: 'memory_save' | 'memory_discard' | 'memory_delete') => background_({ action, id }),
    setModel: (model: string) => background_({ action: 'set_model', model }, `v2 now answers with ${model} (the auto-trader's model is unchanged).`),
    decideApproval,
  };
}
