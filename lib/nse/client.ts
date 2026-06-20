/**
 * Shared client for NSE's public web APIs (nseindia.com/api/*).
 *
 * NSE blocks server-side calls that arrive without a session cookie, so we warm
 * up by visiting nseindia.com first. The cookie is cached in-process (3 min) so
 * every NSE-backed route (heatmap, market-movers, market-status) shares ONE
 * warm-up instead of hammering NSE — which is what got us throttled while
 * exploring. A 401/403 invalidates the cookie and retries once with a fresh one.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const COOKIE_TTL_MS = 3 * 60 * 1000;
let cookieCache: { value: string; at: number } | null = null;
let cookiePromise: Promise<string> | null = null;

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
  cookiePromise = (async () => {
    try {
      const value = await freshCookie();
      cookieCache = { value, at: Date.now() };
      return value;
    } finally {
      cookiePromise = null;
    }
  })();
  return cookiePromise;
}

/** GET an NSE /api/* JSON endpoint. Throws on a non-OK / non-JSON response. */
export async function nseApiGet<T = unknown>(
  path: string,
  opts: { referer?: string; timeoutMs?: number } = {},
): Promise<T> {
  const referer = opts.referer ?? 'https://www.nseindia.com/';
  const timeoutMs = opts.timeoutMs ?? 9000;

  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const cookie = await getCookie(attempt > 0);
    const res = await fetchWithTimeout(
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
    if (res.status === 401 || res.status === 403) {
      cookieCache = null; // stale cookie — refresh and retry once
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
