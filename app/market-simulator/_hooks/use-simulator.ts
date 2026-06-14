'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SimulatorConfig } from '@/lib/simulator/config';
import type { SimCandle, SimEvent, SimLoadedMeta, SimQuote, SimStatus } from '@/lib/simulator/types';

type QuoteListener = (quote: SimQuote) => void;
type SnapshotListener = (finalized: SimCandle[], quote: SimQuote | null) => void;

const EMPTY_STATUS: SimStatus = {
  state: 'idle',
  symbol: null,
  instrumentKind: null,
  interval: null,
  fromDate: null,
  toDate: null,
  speed: 1,
  cursor: 0,
  totalTicks: 0,
  totalCandles: 0,
  candleIndex: 0,
  simTime: null,
  progress: 0,
  clientCount: 0,
  error: null,
};

async function control(body: Record<string, unknown>): Promise<SimStatus | null> {
  const res = await fetch('/api/simulator/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Control request failed');
  return (json.data as SimStatus) ?? null;
}

export interface UseSimulator {
  connected: boolean;
  status: SimStatus;
  meta: SimLoadedMeta | null;
  error: string | null;
  loading: boolean;
  /** Subscribe to the raw per-tick quote stream (imperative; for the chart). */
  onQuote: (cb: QuoteListener) => () => void;
  /** Subscribe to snapshot/seek events (chart hydration + reset). */
  onSnapshot: (cb: SnapshotListener) => () => void;
  load: (config: Partial<SimulatorConfig>) => Promise<void>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  step: () => Promise<void>;
  seek: (candleIndex: number) => Promise<void>;
  seekTime: (epochSeconds: number) => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;
  reset: () => Promise<void>;
}

/** Owns the simulator SSE connection + control plane. */
export function useSimulator(): UseSimulator {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<SimStatus>(EMPTY_STATUS);
  const [meta, setMeta] = useState<SimLoadedMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const quoteListeners = useRef<Set<QuoteListener>>(new Set());
  const snapshotListeners = useRef<Set<SnapshotListener>>(new Set());

  // -- SSE connection --
  useEffect(() => {
    const es = new EventSource('/api/simulator/stream');

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      let evt: SimEvent;
      try {
        evt = JSON.parse(msg.data) as SimEvent;
      } catch {
        return;
      }
      switch (evt.event) {
        case 'info':
          setConnected(true);
          break;
        case 'status':
          setStatus(evt.data);
          setError(evt.data.error);
          break;
        case 'loaded':
          setMeta(evt.data);
          break;
        case 'quote':
          for (const cb of quoteListeners.current) cb(evt.data);
          break;
        case 'snapshot':
          for (const cb of snapshotListeners.current) cb(evt.data.finalizedCandles, evt.data.quote);
          setStatus(evt.data.status);
          break;
      }
    };

    return () => es.close();
  }, []);

  const onQuote = useCallback((cb: QuoteListener) => {
    quoteListeners.current.add(cb);
    return () => {
      quoteListeners.current.delete(cb);
    };
  }, []);

  const onSnapshot = useCallback((cb: SnapshotListener) => {
    snapshotListeners.current.add(cb);
    return () => {
      snapshotListeners.current.delete(cb);
    };
  }, []);

  const run = useCallback(async (body: Record<string, unknown>, withLoading = false) => {
    try {
      if (withLoading) setLoading(true);
      setError(null);
      const next = await control(body);
      if (next) setStatus(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (withLoading) setLoading(false);
    }
  }, []);

  const load = useCallback(
    async (config: Partial<SimulatorConfig>) => {
      setMeta(null);
      await run({ action: 'load', config }, true);
    },
    [run],
  );

  return {
    connected,
    status,
    meta,
    error,
    loading,
    onQuote,
    onSnapshot,
    load,
    play: useCallback(() => run({ action: 'play' }), [run]),
    pause: useCallback(() => run({ action: 'pause' }), [run]),
    step: useCallback(() => run({ action: 'step' }), [run]),
    seek: useCallback((candleIndex: number) => run({ action: 'seek', candleIndex }), [run]),
    seekTime: useCallback((epochSeconds: number) => run({ action: 'seekTime', time: epochSeconds }), [run]),
    setSpeed: useCallback((speed: number) => run({ action: 'speed', speed }), [run]),
    reset: useCallback(() => run({ action: 'reset' }), [run]),
  };
}

/**
 * Throttled view of the latest quote (~20fps) for panels — avoids re-rendering
 * on every raw tick while keeping the display smooth.
 */
export function useThrottledQuote(onQuote: UseSimulator['onQuote']): SimQuote | null {
  const [quote, setQuote] = useState<SimQuote | null>(null);
  const pending = useRef<SimQuote | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const flush = () => {
      raf.current = null;
      if (pending.current) setQuote(pending.current);
    };
    const unsub = onQuote((q) => {
      pending.current = q;
      if (raf.current === null) raf.current = requestAnimationFrame(flush);
    });
    return () => {
      unsub();
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [onQuote]);

  return quote;
}
