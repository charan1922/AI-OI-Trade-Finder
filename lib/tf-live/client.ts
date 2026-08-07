/**
 * The ONLY place that makes an HTTP request to TradeFinder.
 *
 * WHY THIS EXISTS — read the evidence before changing any constant here.
 *
 * On 2026-08-07 a freshly pasted token produced this exact sequence in prod:
 *
 *   04:10:56.158Z  validate      (daily-index)   -> SUCCESS
 *   04:10:59.122Z  all_sector                    -> SUCCESS (210 stocks)
 *   04:11:05.910Z  all_sector                    -> AT_ERROR: INVALID TOKEN
 *   04:11:05.957Z  daily-index                   -> AT_ERROR: INVALID TOKEN
 *   04:11:05.983Z  sector_scope                  -> AT_ERROR: INVALID TOKEN
 *   04:11:06.015Z  market_pulse                  -> AT_ERROR: INVALID TOKEN
 *
 * The two requests spaced ~3 SECONDS apart both succeeded. The four fired
 * ~50ms apart all failed. The token was identical throughout, and its `lt` JWT
 * had ~3 hours left. So the discriminator is REQUEST SPACING, not expiry:
 * TradeFinder appears to throttle bursts per account and reports the refusal
 * with the (misleading) code AT_ERROR — the same code a genuinely bad token
 * gets, which is why this looked like an auth problem for two days.
 *
 * That also explains the 75/75 failures on 2026-08-06: the old collector fired
 * its endpoints back-to-back in a tight loop, so EVERY tick was a burst.
 *
 * The fix is architectural, not a retry sprinkled at the call site:
 *   1. ONE global queue — no two TradeFinder requests can ever overlap, even
 *      across a scheduled tick and a manual "Capture now" click.
 *   2. A MINIMUM GAP between consecutive requests, enforced by the queue.
 *   3. ONE retry after a longer pause when TF refuses, because the refusal is
 *      usually transient throttling rather than a dead credential.
 *
 * This mirrors the discipline the repo already applies to Dhan ("No parallel
 * Dhan calls. Always sequential with appropriate delay per category").
 *
 * HONEST LIMIT: the burst-throttle reading is inferred from one clean
 * observation, not from TradeFinder documentation. An alternative explanation
 * is that `at` is simply very short-lived. Spacing + retry is the right
 * response to EITHER, which is why this design does not depend on knowing
 * which is true. If captures still fail with generous spacing and a live `lt`,
 * that distinguishes the two and this comment should be updated with the
 * result.
 */

/** Minimum time between any two TradeFinder requests. The observed success
 *  gap was ~3s; 4s leaves margin without starving a 60s tick of 4 feeds. */
export const MIN_REQUEST_GAP_MS = 4_000;
/** Extra pause before the single retry when TradeFinder refuses a request. */
export const RETRY_PAUSE_MS = 9_000;
/** Per-request network timeout. */
export const REQUEST_TIMEOUT_MS = 15_000;

export interface TfTokens {
  lt: string;
  at: string;
}

export interface TfFetchResult {
  ok: boolean;
  /** Raw response body, retained on success so the caller can store it verbatim. */
  body?: string;
  /** Parsed body when it was valid JSON. */
  payload?: unknown;
  /** Human-readable failure reason; always set when ok is false. */
  error?: string;
  /** True when TradeFinder answered but refused (as opposed to a network fault). */
  refused?: boolean;
  /** How many attempts were made (1 or 2). */
  attempts: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Global serialization state. Held on globalThis so Next's dev-mode module
 * reloading cannot create a second, independent queue that would defeat the
 * whole point by allowing two "serialized" callers to run concurrently.
 */
interface QueueState {
  chain: Promise<unknown>;
  lastRequestAt: number;
}
const store = globalThis as unknown as { __tfRequestQueue?: QueueState };
store.__tfRequestQueue ??= { chain: Promise.resolve(), lastRequestAt: 0 };

/** Run `task` after every previously queued task, and never sooner than
 *  MIN_REQUEST_GAP_MS after the previous request actually went out. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const state = store.__tfRequestQueue as QueueState;
  const run = state.chain.then(async () => {
    const waitFor = state.lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
    if (waitFor > 0) await sleep(waitFor);
    state.lastRequestAt = Date.now();
    return task();
  });
  // Keep the chain alive even if this task rejects, or one failure would
  // permanently wedge every future TradeFinder request.
  state.chain = run.catch(() => undefined);
  return run;
}

/** One attempt, no queueing and no retry. */
async function attempt(url: string, tokens: TfTokens): Promise<TfFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { accept: 'application/json', jwtToken: tokens.lt, accessToken: tokens.at },
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      return { ok: false, error: `TradeFinder returned HTTP ${response.status}`, refused: true, attempts: 1 };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return { ok: false, error: 'TradeFinder returned non-JSON', refused: true, attempts: 1 };
    }
    const shape = payload as { status?: string; code?: string; message?: string } | null;
    if (shape?.status !== 'SUCCESS') {
      const detail = shape?.code ? `${shape.code}: ${shape.message ?? 'rejected'}` : 'no response body';
      return {
        ok: false,
        error: `TradeFinder rejected it (${detail.slice(0, 200)})`,
        refused: true,
        attempts: 1,
      };
    }
    return { ok: true, body, payload, attempts: 1 };
  } catch (error) {
    const timedOut = (error as Error).name === 'AbortError';
    return {
      ok: false,
      error: timedOut ? `TradeFinder timed out (${REQUEST_TIMEOUT_MS / 1000}s)` : 'TradeFinder request failed (network)',
      refused: false,
      attempts: 1,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch one TradeFinder endpoint: queued behind every other TF request, spaced
 * by MIN_REQUEST_GAP_MS, and retried ONCE after RETRY_PAUSE_MS if TradeFinder
 * refuses (the throttle signature). A network fault is NOT retried here — the
 * caller's next tick is the retry, and hammering a broken link adds nothing.
 */
export async function tfFetch(url: string, tokens: TfTokens): Promise<TfFetchResult> {
  const first = await enqueue(() => attempt(url, tokens));
  if (first.ok || !first.refused) return first;

  const second = await enqueue(async () => {
    await sleep(RETRY_PAUSE_MS);
    return attempt(url, tokens);
  });
  return {
    ...second,
    attempts: 2,
    error: second.ok ? undefined : `${second.error} (after 1 retry)`,
  };
}
