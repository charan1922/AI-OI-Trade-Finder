/**
 * The TradeFinder feeds we capture — the single source of truth for which
 * endpoints exist and what URL each one lives at.
 *
 * LEAF MODULE ON PURPOSE: no imports at all, so the collector, the store and
 * the DB-free CI checks can all read it. A typo in one of these URLs would
 * fail silently forever (a 404 recorded as "capture error" every 5 minutes),
 * which is exactly the kind of thing worth pinning in a test.
 *
 * SCOPED DELIBERATELY — narrowed 2026-08-08 to what the app actually uses:
 * `all_sector` + `daily-index` feed /sector-scope's data, `market_pulse` is
 * banked raw, and `check_signal` is TradeFinder's own session/entitlement probe
 * (added 2026-08-26, operator request). Everything else the relay sees on the
 * page (feature_flag/feature_read, rfactor_filter/rfactor_data, servertime,
 * TF's OWN sector_scope endpoint — unrelated to this app's /sector-scope page
 * despite the name) is real traffic nobody reads, so it is dropped before it
 * ever reaches the database. This list IS the allowlist.
 *
 * `check_signal` needs no polling of its own: TradeFinder's page fires it on
 * every load, and the relay reloads on its own schedule, so allowlisting it is
 * what makes it periodic. Nothing here is ever fetched by us directly — that
 * is the lt/at replay approach which is proven impossible (see client.ts).
 *
 * Note the inconsistent paths — `all_sector` and `daily-index` sit under
 * `/api_be/data/order/`, `market_pulse` directly under `/api_be/data/`, and
 * `check_signal` under `/api_be/admin/users/`. That is TradeFinder's layout,
 * not a mistake here — and it is exactly why each one needs its own explicit
 * match (see the standing consequences below).
 *
 * PARSED vs RAW: `all_sector` and `daily-index` have parsers whose shape was
 * confirmed against a real payload (lib/tf-live/parse.ts). `market_pulse` has
 * NO parser yet — it is captured in full (`recordTfLiveCapture` stores the raw
 * `payloadJson` on every capture), so its data banks from each successful tick
 * and a parser can be written later and back-applied to everything stored.
 * Guessing a schema is how param_2/param_3 got swapped once; never again.
 *
 * WHY THERE WAS NOTHING TO INSPECT UNTIL 2026-08-26. This note used to say the
 * parser was missing "because no successful capture has been inspected", which
 * was true but badly misleading about the cause: `market_pulse` was not merely
 * un-inspected, it was never STORED. Its path is `/api_be/data/market_pulse`,
 * one segment shallower than the other two (`/api_be/data/order/…`), and
 * `endpointTagFor()` in lib/tf-live/ingest.ts had no `endsWith` case for it, so
 * the generic fallback produced `'data/market_pulse'` — not in this list — and
 * every single response was dropped from the moment the browser relay replaced
 * the fetch collector (2026-08-08). Production held 1,667 `all_sector` and
 * 1,825 `daily-index` captures against ZERO `market_pulse`. Fixed 2026-08-26
 * (first successful capture the same day, 12:15 IST).
 *
 * TWO STANDING CONSEQUENCES:
 *   1. ADDING AN ENDPOINT HERE IS NOT ENOUGH — it also needs its own `endsWith`
 *      case in `endpointTagFor()`. The generic fallback matches none of
 *      TradeFinder's real paths, so an entry without one is silently dead.
 *      `scripts/verify-tf-ingest.ts` now asserts every entry in this list
 *      round-trips from its real URL, so that mistake fails in CI.
 *   2. `market_pulse` has no CONSUMER either — nothing in this app reads it
 *      today (the `get_market_pulse` AI-assistant tool is unrelated: it reads
 *      NSE data, not TradeFinder). Write the parser when something needs it,
 *      against the real payloads now accumulating — not speculatively.
 */

export const TF_ENDPOINTS = ['all_sector', 'daily-index', 'market_pulse', 'check_signal'] as const;

export type TfEndpoint = (typeof TF_ENDPOINTS)[number];

export const TF_ENDPOINT_URL: Record<TfEndpoint, string> = {
  'all_sector': 'https://tradefinder.in/api_be/data/order/all_sector',
  'daily-index': 'https://tradefinder.in/api_be/data/order/daily-index',
  'market_pulse': 'https://tradefinder.in/api_be/data/market_pulse',
  'check_signal': 'https://tradefinder.in/api_be/admin/users/check_signal',
};

/** Endpoints whose payload shape has been confirmed and has a parser. The rest
 *  are captured raw — see the module note above. */
export const TF_PARSED_ENDPOINTS: readonly TfEndpoint[] = ['all_sector', 'daily-index'];
