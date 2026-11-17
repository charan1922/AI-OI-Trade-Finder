/**
 * Shared client for NSE's public web APIs (nseindia.com/api/*).
 *
 * Calls go WITHOUT a cookie first (see nseApiGet — since 2026-11 NSE hangs
 * calls that carry one). The warm-up below (visit nseindia.com for a session
 * cookie) is now only the fallback. The cookie is cached in-process (3 min) so
 * every NSE-backed route (heatmap, market-movers, market-status) shares ONE
 * warm-up instead of hammering NSE — which is what got us throttled while
 * exploring. A 401/403 invalidates the cookie and retries once with a fresh one.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const COOKIE_TTL_MS = 3 * 60 * 1000;
/**
 * How long to skip the warm-up after it produced nothing. The warm-up costs two
 * page loads with a 6s timeout each, so a blocked/stalled NSE made every single
 * API call pay ~12s before even attempting the request (the empty string cached
 * below fails the truthiness check, so it was never treated as a cache hit).
 * Backing off means one wasted warm-up per window instead of one per call.
 */
const COOKIE_FAILURE_COOLDOWN_MS = 60 * 1000;
let cookieCache: { value: string; at: number } | null = null;
let cookiePromise: Promise<string> | null = null;
let cookieRetryAfter = 0;

export const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};
export const intOrNull = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
};

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function freshCookie(): Promise<string> {
  const jar: string[] = [];
  for (const url of [
    'https://www.nseindia.com/',
    'https://www.nseindia.com/market-data/live-equity-market',
  ]) {
    try {
      const res = await fetchWithTimeout(
        url,
        {
          headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          redirect: 'follow',
        },
        6000,
      );
      jar.push(...(res.headers.getSetCookie?.() ?? []));
    } catch {
      // ignore — partial/empty cookie still worth trying
    }
  }
  return jar.map((c) => c.split(';')[0]).join('; ');
}

async function getCookie(force = false): Promise<string> {
  if (!force && cookieCache && Date.now() - cookieCache.at < COOKIE_TTL_MS && cookieCache.value) {
    return cookieCache.value;
  }
  // Dedupe: if a warm-up is already in flight, share it instead of stampeding NSE.
  if (cookiePromise) return cookiePromise;
  // The last warm-up came back empty — don't burn another ~12s on it yet. NSE
  // sometimes still answers the API without a fresh cookie, so we go on and try.
  if (!force && Date.now() < cookieRetryAfter) return cookieCache?.value ?? '';
  cookiePromise = (async () => {
    try {
      const value = await freshCookie();
      if (value) {
        cookieCache = { value, at: Date.now() };
        cookieRetryAfter = 0;
      } else {
        cookieRetryAfter = Date.now() + COOKIE_FAILURE_COOLDOWN_MS;
      }
      return value;
    } finally {
      cookiePromise = null;
    }
  })();
  return cookiePromise;
}

/**
 * GET an NSE /api/* JSON endpoint. Throws on a non-OK / non-JSON response.
 *
 * Tries WITHOUT a cookie first. From ~2026-11-13 NSE's Akamai edge HANGS any
 * request carrying the homepage cookies (AKA_A2/ak_bmsc/bm_mi) — measured from
 * the prod container 2026-11-17: oi-spurts / most-active / marketStatus answer
 * in 40–84ms with no cookie and time out (10s) with one, which emptied every
 * /live NSE list and so failed selector check ⑧ closed. The warm-up cookie is
 * kept only as the fallback (attempts 2–3) in case NSE flips the rule back.
 */
export async function nseApiGet<T = unknown>(
  path: string,
  opts: { referer?: string; timeoutMs?: number } = {},
): Promise<T> {
  const referer = opts.referer ?? 'https://www.nseindia.com/';
  const timeoutMs = opts.timeoutMs ?? 9000;

  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const cookie = attempt === 0 ? '' : await getCookie(attempt > 1);
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `https://www.nseindia.com${path}`,
        {
          headers: {
            'User-Agent': UA,
            Accept: 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: referer,
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        timeoutMs,
      );
    } catch (err) {
      // The cookie-less try failing (timeout/network) falls through to the
      // cookie; a failure on a cookie attempt stays fatal, as before.
      if (attempt > 0) throw err;
      lastErr = (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message;
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      if (attempt > 0) cookieCache = null; // stale cookie — refresh and retry once
      lastErr = `HTTP ${res.status}`;
      continue;
    }
    if (!res.ok) throw new Error(`NSE ${path} HTTP ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) throw new Error(`NSE ${path} returned non-JSON (likely blocked)`);
    return (await res.json()) as T;
  }
  throw new Error(`NSE ${path} blocked after cookie refresh (${lastErr})`);
}
