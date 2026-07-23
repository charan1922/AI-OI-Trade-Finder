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

/** Aborts the request after `timeoutMs`, always clearing its own timer.
 *
 * NOTE: this bounds only the wait for RESPONSE HEADERS. The moment a Response
 * is returned the timer is cleared, so reading the body afterwards is UNBOUNDED.
 * Anything that consumes a body inside the serial quote queue must use
 * fetchJsonWithTimeout instead. */
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

/**
 * Bounded fetch AND body read, under ONE deadline.
 *
 * A server can complete the header exchange and then stall the body forever.
 * With a header-only timeout the caller's `await response.json()` never
 * settles — so `fetchDetailedOptionChainShadow` would never resolve and the
 * option-shadow worker would stay `running` for the life of the process,
 * silently ending all future option evidence (PR#15 re-review).
 *
 * The abort controller stays armed across body consumption, so a stalled body
 * aborts exactly like stalled headers. `json` is null for a non-OK response
 * (the body is still drained under the same deadline so the socket is freed)
 * and for a malformed one — an unreadable body is a failed request, not a
 * reason to hang.
 */
export async function fetchJsonWithTimeout<T>(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; json: T | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (!response.ok) {
      try {
        await response.text();
      } catch (error) {
        if (isAbortError(error)) throw error;
      }
      return { response, json: null };
    }
    try {
      return { response, json: (await response.json()) as T };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { response, json: null };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** True when an error came from `fetchWithTimeout` aborting, not from the server. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
