'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AutoTradeState,
  BackgroundState,
  CycleTimeline,
  LiveTurn,
  RaceState,
  TraderRead,
  V2Message,
} from '../_lib/v2-view';

/** Thread + background change fastest (a wake-up must show within seconds). */
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

/**
 * Everything /trade-commentary-v2 shows. One polling hook so the page stays a render layer.
 * `admin` = false skips the admin-only feeds (chat, background, console, logs) — viewers see reads.
 */
export function useV2Data(admin: boolean) {
  const [messages, setMessages] = useState<V2Message[]>([]);
  const [configured, setConfigured] = useState(true);
  const [background, setBackground] = useState<BackgroundState | null>(null);
  const [reads, setReads] = useState<TraderRead[]>([]);
  const [timelines, setTimelines] = useState<CycleTimeline[]>([]);
  const [autoTrade, setAutoTrade] = useState<AutoTradeState | null>(null);
  const [race, setRace] = useState<RaceState | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [pending, setPending] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const pendingRef = useRef(0);

  const loadFast = useCallback(async () => {
    if (!admin) return;
    const [chat, bg] = await Promise.all([
      pendingRef.current > 0 ? null : getJson<{ messages?: V2Message[]; configured?: boolean }>('/api/trade-commentary/chat'),
      getJson<BackgroundState & { success?: boolean }>('/api/trade-commentary/chat/background'),
    ]);
    if (chat?.messages && pendingRef.current === 0) {
      setMessages(chat.messages);
      setConfigured(chat.configured !== false);
    }
    if (bg?.success) setBackground(bg);
  }, [admin]);

  const loadSlow = useCallback(async () => {
    const [commentary, at, rc, logs] = await Promise.all([
      getJson<{ rows?: TraderRead[]; timelines?: CycleTimeline[] }>('/api/trade-commentary?limit=40'),
      admin ? getJson<AutoTradeState & { success?: boolean }>('/api/auto-trade') : null,
      getJson<RaceState & { success?: boolean }>('/api/tf/race'),
      admin ? getJson<{ lines?: string[] }>('/api/logs?lines=400') : null,
    ]);
    if (commentary?.rows) setReads(commentary.rows);
    if (commentary?.timelines) setTimelines(commentary.timelines);
    if (at?.success) setAutoTrade(at);
    if (rc?.success !== false && rc) setRace(rc);
    if (logs?.lines) {
      setLogLines(logs.lines.filter((l) => /\[(chat-watch|operator-chat|auto-trade)\]/.test(l)).slice(-60));
    }
  }, [admin]);

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

  /**
   * Sends as the agentic v2 surface; `images` are downsized data URLs; `think` is the Think switch.
   * While the reply runs, the live steps are polled every second from /chat/progress (display only).
   */
  const send = useCallback(
    async (text: string, images: string[] = [], think = true): Promise<boolean> => {
      const message = text.trim();
      if (!message) return false;
      pendingRef.current += 1;
      setPending(pendingRef.current);
      const tempId = -Date.now();
      const turnId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      setLive({ steps: [], done: false, elapsedMs: 0 });
      const poll = setInterval(() => {
        void getJson<{ turn?: LiveTurn | null }>(`/api/trade-commentary/chat/progress?turn=${turnId}`).then((j) => {
          if (j?.turn) setLive(j.turn);
        });
      }, 1000);
      setMessages((prev) => [...prev, { id: tempId, date: '', role: 'user', content: message, at: new Date().toISOString() }]);
      try {
        const { ok, json } = await postJson('/api/trade-commentary/chat', { message, surface: 'v2', images, turnId, think });
        if (!ok) {
          setMessages((prev) => prev.filter((m) => m.id !== tempId));
          setNotice(String(json.error ?? 'Not sent.'));
          return false;
        }
        if (typeof json.notice === 'string') setNotice(json.notice);
        return true;
      } finally {
        clearInterval(poll);
        setLive(null);
        pendingRef.current -= 1;
        setPending(pendingRef.current);
        await loadFast();
      }
    },
    [loadFast]
  );

  const act = useCallback(
    async (messageId: number, decision: 'confirm' | 'cancel') => {
      const { ok, json } = await postJson('/api/trade-commentary/chat/action', { messageId, decision });
      if (!ok && json.error) setNotice(String(json.error));
      await loadFast();
    },
    [loadFast]
  );

  const setBackgroundOn = useCallback(
    async (enabled: boolean) => {
      const { ok, json } = await postJson('/api/trade-commentary/chat/background', { action: 'toggle', enabled });
      if (!ok) setNotice(String(json.error ?? 'Could not change Background.'));
      await loadFast();
    },
    [loadFast]
  );

  const cancelWatch = useCallback(
    async (id: number) => {
      const { ok, json } = await postJson('/api/trade-commentary/chat/background', { action: 'cancel_watch', id });
      if (!ok) setNotice(String(json.error ?? 'Could not cancel.'));
      await loadFast();
    },
    [loadFast]
  );

  /** Per-action switch: let the AI do this kind by itself, or ask first. */
  const setAutoAction = useCallback(
    async (kind: string, auto: boolean) => {
      const { ok, json } = await postJson('/api/trade-commentary/chat/background', { action: 'set_auto_action', kind, auto });
      if (!ok) setNotice(String(json.error ?? 'Not changed.'));
      await loadFast();
    },
    [loadFast]
  );

  /** Long-term memory: the operator's Save / Discard / Delete. */
  const decideMemory = useCallback(
    async (id: number, action: 'memory_save' | 'memory_discard' | 'memory_delete') => {
      const { ok, json } = await postJson('/api/trade-commentary/chat/background', { action, id });
      if (!ok) setNotice(String(json.error ?? 'Not changed.'));
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

  /** v2's own chat model — never the auto-trader's. */
  const setModel = useCallback(
    async (model: string) => {
      const { ok, json } = await postJson('/api/trade-commentary/chat/background', { action: 'set_model', model });
      setNotice(ok ? `v2 chat now answers with ${model} (the auto-trader's model is unchanged).` : String(json.error ?? 'Model not changed.'));
      await loadFast();
    },
    [loadFast]
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
    pending,
    notice,
    dismissNotice: () => setNotice(null),
    showNotice: (msg: string) => setNotice(msg),
    send,
    act,
    setBackgroundOn,
    cancelWatch,
    decideApproval,
    setModel,
    decideMemory,
    setAutoAction,
    live,
  };
}
