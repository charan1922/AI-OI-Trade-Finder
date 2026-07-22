/**
 * Bounded fetch. Node's global fetch has NO default timeout: if a server accepts
 * the socket and then never sends response headers, the promise stays pending
 * forever.
 *
 * That matters here because Dhan Quote-API calls run through a single serial
 * queue (`gate.tail` in market-feed.ts). One request that never settles wedges
 * the queue, so every later call — including a live quote on the trade path —
 * waits behind it indefinitely. A timeout converts an unbounded stall into a
 * bounded, visible failure.
 *
 * Deliberately dependency-free (no env, no db) so it can be unit-tested without
 * standing up the rest of the app.
 */

/** Aborts the request after `timeoutMs`, always clearing its own timer. */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** True when an error came from `fetchWithTimeout` aborting, not from the server. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
