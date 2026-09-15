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

  // ── TradeFinder's CURRENT auth (2026-09) ──────────────────────────────────
  // A REAL paste on 2026-09-15 carried no __Secure-next-auth.session-token at
  // all — TF now ships a JWT as tradefinder_token AND lt. The old check rejected
  // that valid paste, locking the operator out of restoring capture. Any one of
  // the three names must be enough.
  check(
    'parse-curl: tradefinder_token alone is accepted (current TF auth)',
    hasSessionCookie('_ga=GA1.1.x; tradefinder_token=eyJhbGciOiJIUzI1NiJ9.p.s; servertime=1')
  );
  check('parse-curl: lt alone is accepted (current TF auth)', hasSessionCookie('_ga=GA1.1.x; lt=eyJhbGciOiJIUzI1NiJ9.p.s'));
  check(
    'parse-curl: the legacy NextAuth cookie still works on its own',
    hasSessionCookie(`_ga=GA1.1.x; ${SESSION_COOKIE_NAME}=xyz`)
  );
  // `lt` is only two characters, so a naive substring test would match plenty of
  // unrelated cookie names. The boundary anchor is what stops that.
  check('parse-curl: `lt` does not match inside a longer cookie name', !hasSessionCookie('alt=1; salt=2; result=3'));
  check('parse-curl: `lt` does not match a suffix like servertime_lt', !hasSessionCookie('servertime_lt=1'));
  check(
    'parse-curl: a cookie string with only analytics/csrf is still rejected',
    !hasSessionCookie('_ga=GA1.1.x; __Host-next-auth.csrf-token=abc; tradefinder_push_prompt=denied')
  );
  // The real thing, trimmed: this exact shape was refused in production.
  const realWorld =
    '_ga=GA1.1.1323846545.1780340323; __Secure-next-auth.callback-url=https%3A%2F%2Ftradefinder.in%2F; ' +
    '__Host-next-auth.csrf-token=9381430c%7Ce7d2e6c4; servertime=1789454765045.5; ' +
    'tradefinder_token=eyJhbGciOiJIUzI1NiJ9.payload.sig; lt=eyJhbGciOiJIUzI1NiJ9.payload.sig';
  check('parse-curl: the real 2026-09-15 cookie string is ACCEPTED', hasSessionCookie(realWorld));

  // ── cookie-header → Playwright cookie objects ─────────────────────────────
  const SITE_URL = 'https://tradefinder.in/';
  const cookies = cookieHeaderToPlaywrightCookies('a=1; b=2; malformed; c=3', SITE_URL);
  check('playwright cookies: parses every well-formed pair', cookies.length === 3, `got ${cookies.length}`);
  check('playwright cookies: a pair with no = is dropped, not guessed', !cookies.some((c) => c.name === 'malformed'));
  check(
    'playwright cookies: every cookie uses url (not domain) and is marked secure — required for __Secure-/__Host- prefixed cookies',
    cookies.every((c) => c.url === SITE_URL && c.secure === true)
  );
  check(
    'playwright cookies: __Host- and __Secure- prefixed cookie names carry no domain field at all',
    (() => {
      const c = cookieHeaderToPlaywrightCookies('__Host-x=1; __Secure-y=2', SITE_URL);
      return c.every((cookie) => !('domain' in cookie));
    })()
  );
  check(
    'playwright cookies: names and values are trimmed',
    cookieHeaderToPlaywrightCookies(' x = y ; z=w', SITE_URL)[0]?.name === 'x'
  );
  check('playwright cookies: an empty header yields an empty list, never a crash', cookieHeaderToPlaywrightCookies('', SITE_URL).length === 0);
}
