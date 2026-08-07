/**
 * PURE checks for lib/tf-live/parse-curl.ts.
 *
 * The fixture below is shaped exactly like the real "Copy as cURL" pastes that
 * proved this feature was needed (2026-08-08, Windows cmd.exe escaping,
 * caret-before-percent, caret-before-quote). Getting this parser wrong is
 * silent and expensive: a slightly-wrong cookie header means the browser
 * relay launches "successfully" and then never actually logs in.
 */
import {
  cookieHeaderToPlaywrightCookies,
  extractCookieHeaderFromCurl,
  hasSessionCookie,
  SESSION_COOKIE_NAME,
  unescapeCmdCaret,
} from '../lib/tf-live/parse-curl';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

/** Shaped like a real Windows "Copy as cURL (cmd)" paste: the -b value is
 *  wrapped in ^"..."^, a nested JSON value is percent-encoded and each %
 *  is further escaped as ^%^, and unrelated -H lines carry their own
 *  independent caret-escaped quoting that must NOT leak into the cookie match. */
const REAL_SHAPED_CURL = String.raw`curl --url ^"https://tradefinder.in/api_be/rfactor_filter/rfactor_data^" ^
  -H ^"accept: */*^" ^
  -H ^"accesstoken: 358836^" ^
  -b ^"_ga=GA1.1.1323846545.1780340323; deviceInfo=^%^7B^%^22ua^%^22^%^3A^%^22Mozilla^%^2F5.0^%^22^%^7D; __Secure-next-auth.session-token=abc123DEF; lt=eyJhbGciOiJIUzI1NiJ9.payload.sig; servertime=1786126010000^" ^
  -H ^"jwttoken: eyJhbGciOiJIUzI1NiJ9.payload.sig^" ^
  -H ^"sec-ch-ua: ^\^"Not=A?Brand^\^";v=^\^"99^\^", ^\^"Google Chrome^\^";v=^\^"151^\^"^" ^
  -H ^"referer: https://tradefinder.in/market-pulse^"`;

export function runTfParseCurlChecks(check: CheckFn): void {
  // ── caret unescaping ──────────────────────────────────────────────────────
  check('parse-curl: unescapes ^%^ back to a literal %', unescapeCmdCaret('a^%^7Bb') === 'a%7Bb');
  check('parse-curl: unescapes ^" back to a literal "', unescapeCmdCaret('^"hello^"') === '"hello"');
  check('parse-curl: unescapes ^& back to a literal &', unescapeCmdCaret('a^&b') === 'a&b');
  check('parse-curl: a bash-style paste (no carets) passes through unchanged', unescapeCmdCaret('a=1; b=2') === 'a=1; b=2');

  // ── extraction from the realistic fixture ─────────────────────────────────
  const result = extractCookieHeaderFromCurl(REAL_SHAPED_CURL);
  check('parse-curl: extracts a cookie header from the cmd-escaped fixture', !('error' in result), 'error' in result ? result.error : '');
  if (!('error' in result)) {
    check(
      'parse-curl: the extracted header contains the session cookie, unescaped',
      result.cookieHeader.includes(`${SESSION_COOKIE_NAME}=abc123DEF`),
      result.cookieHeader
    );
    check(
      'parse-curl: percent-encoded values inside cookies are restored, not left double-escaped',
      result.cookieHeader.includes('deviceInfo=%7B%22ua%22%3A%22Mozilla%2F5.0%22%7D'),
      result.cookieHeader
    );
    check(
      "parse-curl: unrelated -H lines' own escaped quotes don't leak into the cookie value",
      !result.cookieHeader.includes('sec-ch-ua') && !result.cookieHeader.includes('Not=A?Brand'),
      result.cookieHeader
    );
    check('parse-curl: the target URL is captured when present', result.url === 'https://tradefinder.in/api_be/rfactor_filter/rfactor_data', result.url ?? 'null');
  }

  // ── missing / malformed input ─────────────────────────────────────────────
  check('parse-curl: empty input is a plain error, not a crash', 'error' in extractCookieHeaderFromCurl(''));
  check('parse-curl: whitespace-only input is an error', 'error' in extractCookieHeaderFromCurl('   \n  '));
  check(
    'parse-curl: a curl with no -b flag at all is an error naming the fix',
    (() => {
      const r = extractCookieHeaderFromCurl('curl --url "https://tradefinder.in/x" -H "accept: */*"');
      return 'error' in r && r.error.toLowerCase().includes('cookie');
    })()
  );
  check(
    'parse-curl: a cookie header missing the session cookie is refused, not silently accepted',
    (() => {
      const r = extractCookieHeaderFromCurl('curl -b "_ga=GA1.1.1; alertCounter=1" --url "https://tradefinder.in/x"');
      return 'error' in r && r.error.includes(SESSION_COOKIE_NAME);
    })(),
    'a cookie jar without the login cookie must never be treated as a valid session'
  );

  // ── session-cookie detection ──────────────────────────────────────────────
  check('parse-curl: hasSessionCookie finds it mid-string', hasSessionCookie(`a=1; ${SESSION_COOKIE_NAME}=xyz; b=2`));
  check('parse-curl: hasSessionCookie finds it at the very start', hasSessionCookie(`${SESSION_COOKIE_NAME}=xyz; b=2`));
  check('parse-curl: hasSessionCookie is false without it', !hasSessionCookie('a=1; b=2'));
  check(
    'parse-curl: hasSessionCookie does not false-positive on a similar-looking name',
    !hasSessionCookie('__Secure-next-auth.session-token-old=xyz')
  );

  // ── cookie-header → Playwright cookie objects ─────────────────────────────
  const cookies = cookieHeaderToPlaywrightCookies('a=1; b=2; malformed; c=3', '.tradefinder.in');
  check('playwright cookies: parses every well-formed pair', cookies.length === 3, `got ${cookies.length}`);
  check('playwright cookies: a pair with no = is dropped, not guessed', !cookies.some((c) => c.name === 'malformed'));
  check(
    'playwright cookies: every cookie carries the requested domain and root path',
    cookies.every((c) => c.domain === '.tradefinder.in' && c.path === '/')
  );
  check(
    'playwright cookies: names and values are trimmed',
    cookieHeaderToPlaywrightCookies(' x = y ; z=w', '.tradefinder.in')[0]?.name === 'x'
  );
  check('playwright cookies: an empty header yields an empty list, never a crash', cookieHeaderToPlaywrightCookies('', '.tradefinder.in').length === 0);
}
