'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClimbersResponse, RankFeed } from '../_lib/types';

// Rank snapshots are recorded every 5 min by the poller, so a 60s poll is plenty
// to keep the view fresh without hammering the (local-DB-only) endpoint.
const POLL_MS = 60_000;

export interface UseClimbers {
  data: ClimbersResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Load the "running race" climbers for one feed + window (polls every 60s). */
export function useClimbers(feed: RankFeed, windowMin: number, refreshSignal: number): UseClimbers {
  const [data, setData] = useState<ClimbersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchClimbers = useCallback(async () => {
    try {
      const res = await fetch(`/api/live/climbers?feed=${feed}&window=${windowMin}`);
      const d = (await res.json()) as ClimbersResponse;
      if (d.success) {
        setData(d);
        setError(null);
      } else {
        setError(d.error ?? 'Failed to load climbers');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [feed, windowMin]);

  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (!stopped) void fetchClimbers();
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [fetchClimbers]);

  // Re-fetch when the page's "Refresh all" fires. Latest-ref indirection avoids
  // re-running (and re-fetching) every time fetchClimbers's identity changes.
  const fetchRef = useRef(fetchClimbers);
  useEffect(() => {
    fetchRef.current = fetchClimbers;
  }, [fetchClimbers]);
  useEffect(() => {
    if (refreshSignal === 0) return;
    void fetchRef.current();
  }, [refreshSignal]);

  return { data, loading, error, refresh: fetchClimbers };
}
