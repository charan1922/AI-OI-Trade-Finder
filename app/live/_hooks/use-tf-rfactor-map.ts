'use client';

import { useEffect, useState } from 'react';
import type { TfRFactorMap } from '../_lib/types';

// TradeFinder data is captured periodically (every few minutes at most, often
// once a day), never live-ticking — polling it as fast as the live quote feed
// would be pointless. This is deliberately much slower than QUOTE_POLL_MS.
const POLL_MS = 5 * 60_000;

const EMPTY: TfRFactorMap = { capturedAt: null, values: {} };

/**
 * TradeFinder's own R-Factor, fetched independently of the live quote path —
 * merging it in is purely additive display, and a failure here must never
 * affect the live rows this shares a page with.
 */
export function useTfRFactorMap(): TfRFactorMap {
  const [map, setMap] = useState<TfRFactorMap>(EMPTY);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch('/api/tf/rfactor-map', { cache: 'no-store' });
        const j = (await res.json()) as { success: boolean; capturedAt: string | null; values: TfRFactorMap['values'] };
        if (!stopped && j.success) setMap({ capturedAt: j.capturedAt, values: j.values });
      } catch {
        /* leave the previous map in place — never blank out on a transient failure */
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  return map;
}
