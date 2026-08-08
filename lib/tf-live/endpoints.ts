/**
 * The TradeFinder feeds we capture — the single source of truth for which
 * endpoints exist and what URL each one lives at.
 *
 * LEAF MODULE ON PURPOSE: no imports at all, so the collector, the store and
 * the DB-free CI checks can all read it. A typo in one of these URLs would
 * fail silently forever (a 404 recorded as "capture error" every 5 minutes),
 * which is exactly the kind of thing worth pinning in a test.
 *
 * DELIBERATELY ONLY THREE — scoped down 2026-08-08 to exactly what the app
 * actually uses: `all_sector` + `daily-index` feed /sector-scope's data, and
 * `market_pulse` feeds Intraday Boost / the breakout beacon. Every other
 * TradeFinder endpoint the browser relay happens to see on the page
 * (admin/users/check_signal, feature_flag/feature_read,
 * rfactor_filter/rfactor_data, servertime, TF's OWN sector_scope endpoint —
 * unrelated to this app's /sector-scope page despite the name) is real
 * traffic nobody reads, so lib/tf-live/browser.ts drops it before it ever
 * reaches the database. This list IS the allowlist — do not add an endpoint
 * here without a concrete consumer.
 *
 * Note the inconsistent paths — `all_sector` and `daily-index` sit under
 * `/api_be/data/order/`, while `market_pulse` sits directly under
 * `/api_be/data/`. That is TradeFinder's layout, not a mistake here.
 *
 * PARSED vs RAW: `all_sector` and `daily-index` have parsers whose shape was
 * confirmed against a real payload (lib/tf-live/parse.ts). `market_pulse` has
 * NO parser yet, because no successful capture has been inspected — it is
 * still captured in full (`recordTfLiveCapture` stores the raw `payloadJson`
 * on every capture), so its data banks from the first successful tick and a
 * parser can be written later and back-applied to everything already stored.
 * Guessing a schema is how param_2/param_3 got swapped once; never again.
 */

export const TF_ENDPOINTS = ['all_sector', 'daily-index', 'market_pulse'] as const;

export type TfEndpoint = (typeof TF_ENDPOINTS)[number];

export const TF_ENDPOINT_URL: Record<TfEndpoint, string> = {
  'all_sector': 'https://tradefinder.in/api_be/data/order/all_sector',
  'daily-index': 'https://tradefinder.in/api_be/data/order/daily-index',
  'market_pulse': 'https://tradefinder.in/api_be/data/market_pulse',
};

/** Endpoints whose payload shape has been confirmed and has a parser. The rest
 *  are captured raw — see the module note above. */
export const TF_PARSED_ENDPOINTS: readonly TfEndpoint[] = ['all_sector', 'daily-index'];
