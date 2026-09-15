/**
 * Extracts the Cookie header from a pasted "Copy as cURL" command.
 *
 * WHY THIS EXISTS — read lib/tf-live/browser.ts first for the full story.
 * Short version: TradeFinder's `at` token is single-use and minted by their
 * own frontend JS at the instant of each request — no copied value survives
 * being replayed, even milliseconds later (proven exhaustively 2026-08-07/08).
 * The fix is to run a REAL browser and let TradeFinder's own code mint its own
 * tokens, exactly as it does for a human. That browser needs to start out
 * LOGGED IN, which means injecting the one cookie that actually carries the
 * login: `__Secure-next-auth.session-token`. The operator gets it the same
 * way they've been pasting curls all along — DevTools Network tab → right-
 * click any tradefinder.in request → Copy → Copy as cURL — and this module
 * pulls the Cookie header back out of that paste.
 *
 * WHY NOT `document.cookie` (the simpler approach used for lt/at): the session
 * cookie is HttpOnly, specifically so page JavaScript CANNOT read it (a
 * security property, not an oversight). It never appears in `document.cookie`.
 * It DOES appear in a captured request's Cookie header, because the browser
 * attaches HttpOnly cookies to outgoing requests regardless — which is exactly
 * what "Copy as cURL" captures.
 *
 * WINDOWS CMD ESCAPING: Chrome DevTools on Windows copies curl in `cmd.exe`
 * syntax, prefixing every shell-special character (", %, &, <, >, |, ^ itself)
 * with `^`. `unescapeCmdCaret` undoes exactly that, turning the pasted text
 * back into the literal header value the browser actually sent. A macOS/Linux
 * paste ("Copy as cURL (bash)") has no such escaping and passes through
 * unchanged — the replacements are no-ops on text that doesn't contain them.
 *
 * PURE (no imports, no I/O) — driven identically by CI and the API route.
 */

/**
 * The cookies that actually keep the session alive; everything else in the
 * header (analytics ids, device fingerprint, csrf token) rides along but is not
 * load-bearing for staying logged in.
 *
 * ANY ONE OF THESE IS ENOUGH — TradeFinder changed how it authenticates and
 * requiring the old name locked the operator out of their own tool.
 *
 * Until 2026-09 the NextAuth session cookie was the whole story. A real paste on
 * 2026-09-15 carried NO `__Secure-next-auth.session-token` at all; TradeFinder
 * now authenticates its `/api_be/` calls with a JWT it ships as BOTH
 * `tradefinder_token` and `lt`, and echoes as an `authorization: Bearer` header.
 * The old check rejected that perfectly valid paste with "missing
 * __Secure-next-auth.session-token", so the operator could not restore capture
 * no matter how correct their copy was.
 *
 * The legacy name is retained rather than replaced: an account still on the old
 * flow must keep working, and this is a gate on the operator's own credentials —
 * it should fail only when there is genuinely nothing to log in with.
 *
 * Decoding that JWT also answered a long-standing question. Its `exp - iat` is
 * exactly **6 hours**, which is why capture "dies daily": the token is short
 * lived by design, not being evicted. (Its separate `expires_at` is the
 * subscription, running to 2027.)
 */
export const SESSION_COOKIE_NAMES = ['tradefinder_token', 'lt', '__Secure-next-auth.session-token'] as const;

/** Kept for the error text and for tests that pin the legacy name. */
export const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';

export interface ParsedCurlCookies {
  /** The full "name=value; name2=value2" header, ready for Playwright/fetch. */
  cookieHeader: string;
  /** The request URL the curl targeted, when present — informational only. */
  url: string | null;
}

export interface ParsedCurlError {
  error: string;
}

/** Undo Windows cmd.exe's caret-escaping of shell-special characters. A
 *  bash-style paste has none of these sequences, so this is a no-op on it. */
export function unescapeCmdCaret(raw: string): string {
  return raw
    .replace(/\^%\^/g, '%')
    .replace(/\^"/g, '"')
    .replace(/\^&/g, '&')
    .replace(/\^</g, '<')
    .replace(/\^>/g, '>')
    .replace(/\^\|/g, '|')
    .replace(/\^\^/g, '^');
}

/**
 * Pull the `-b`/`--cookie` header value and (if present) the target URL out of
 * a pasted curl command. Never guesses: anything it can't confidently parse
 * returns a plain-English error instead of a partial or wrong cookie string.
 */
export function extractCookieHeaderFromCurl(raw: string): ParsedCurlCookies | ParsedCurlError {
  if (!raw || !raw.trim()) {
    return { error: 'Paste a curl command — right-click a tradefinder.in request in the Network tab, Copy, Copy as cURL.' };
  }
  const cleaned = unescapeCmdCaret(raw.trim());

  const cookieMatch = cleaned.match(/(?:-b|--cookie)\s+"([^"]*)"/) ?? cleaned.match(/(?:-b|--cookie)\s+'([^']*)'/);
  if (!cookieMatch) {
    return {
      error:
        'No -b/--cookie flag found in that paste. Make sure you used "Copy as cURL" on a real request to tradefinder.in, not a different site or a plain URL.',
    };
  }
  const cookieHeader = cookieMatch[1].trim();
  if (!cookieHeader) return { error: 'The cookie value in that curl is empty.' };
  if (!hasSessionCookie(cookieHeader)) {
    return {
      error: `That cookie string carries none of TradeFinder's login cookies (${SESSION_COOKIE_NAMES.join(', ')}) — those are what keep you signed in. Make sure the request you copied was made while signed in to tradefinder.in.`,
    };
  }

  const urlMatch = cleaned.match(/--url\s+"([^"]*)"/) ?? cleaned.match(/curl\s+"(https?:\/\/[^"]*)"/);
  return { cookieHeader, url: urlMatch ? urlMatch[1] : null };
}

/** True when the cookie string carries ANY of TradeFinder's login cookies — see
 *  SESSION_COOKIE_NAMES for why one is enough and why the list has three names.
 *  Still anchored to a cookie boundary so `lt` cannot match inside a longer
 *  name like `alt=` or `servertime_lt=`. */
export function hasSessionCookie(cookieHeader: string): boolean {
  return SESSION_COOKIE_NAMES.some((name) =>
    new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=`).test(cookieHeader),
  );
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  url: string;
  secure: true;
}

/** Parse a "a=1; b=2" cookie header into the shape Playwright's
 *  `context.addCookies()` expects. Pairs with no `=` (malformed) are dropped
 *  rather than guessed.
 *
 *  Uses `url` rather than `domain`+`path`, and always sets `secure: true`.
 *  This isn't stylistic — TradeFinder's own session cookies carry the
 *  `__Secure-` and `__Host-` name prefixes, which Chromium enforces at the
 *  protocol level: `__Secure-*` cookies MUST have Secure set, and `__Host-*`
 *  cookies MUST have NO Domain attribute at all. Passing an explicit `domain`
 *  (even one that matches) violates that second rule for every `__Host-`
 *  cookie in the jar, and CDP's `Storage.setCookies` rejects the WHOLE batch
 *  rather than skipping the bad one — which is what actually broke the first
 *  version of this (2026-08-08: "Protocol error (Storage.setCookies)" on
 *  every real paste, because the fixture cookie names didn't happen to use
 *  either prefix). `url` alone makes every cookie host-only with no Domain
 *  attribute, satisfying both prefixes at once. */
export function cookieHeaderToPlaywrightCookies(cookieHeader: string, url: string): PlaywrightCookie[] {
  return cookieHeader
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair): PlaywrightCookie | null => {
      const eq = pair.indexOf('=');
      if (eq <= 0) return null;
      return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), url, secure: true };
    })
    .filter((c): c is PlaywrightCookie => c != null);
}
