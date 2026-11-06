/**
 * AI Analysis v2 — the chat runs in flight, so the Stop button can abort one (the in-flight MiMo call stops at once:
 * the run's AbortSignal reaches the openai SDK and LangGraph). In-process only; a run lives until it finishes.
 */

const store = (): Map<string, AbortController> => {
  const g = globalThis as unknown as { __aiV2Runs?: Map<string, AbortController> };
  g.__aiV2Runs ??= new Map();
  return g.__aiV2Runs;
};

export const isRunId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);

export function startRun(id: string): AbortSignal {
  const c = new AbortController();
  store().set(id, c);
  return c.signal;
}

export function endRun(id: string): void {
  store().delete(id);
}

/** True when a running run was stopped. */
export function stopRun(id: string): boolean {
  const c = store().get(id);
  if (!c) return false;
  c.abort();
  return true;
}
