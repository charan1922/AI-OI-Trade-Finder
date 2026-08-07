/**
 * The TradeFinder feeds we capture — the single source of truth for which
 * endpoints exist and what URL each one lives at.
 *
 * LEAF MODULE ON PURPOSE: no imports at all, so the collector, the store and
 * the DB-free CI checks can all read it. A typo in one of these URLs would
 * fail silently forever (a 404 recorded as "capture error" every 5 minutes),
 * which is exactly the kind of thing worth pinning in a test.
 *
 * Note the inconsistent paths — `all_sector` and `daily-index` sit under
 * `/api_be/data/order/`, while `sector_scope` and `market_pulse` sit directly
 * under `/api_be/data/`. That is TradeFinder's layout, not a mistake here.
 *
 * PARSED vs RAW: `all_sector` and `daily-index` have parsers whose shape was
 * confirmed against a real payload (lib/tf-live/parse.ts). `sector_scope` and
 * `market_pulse` were added 2026-08-07 and have NO parser yet, because no
 * successful capture of either has been inspected. They are still captured in
 * full — `recordTfLiveCapture` stores the raw `payloadJson` on every capture —
 * so their data banks from the first successful tick and a parser can be
 * written later and back-applied to everything already stored. Guessing a
 * schema is how param_2/param_3 got swapped once; never again.
 */

export const TF_ENDPOINTS = ['all_sector', 'daily-index', 'sector_scope', 'market_pulse'] as const;

export type TfEndpoint = (typeof TF_ENDPOINTS)[number];

export const TF_ENDPOINT_URL: Record<TfEndpoint, string> = {
  'all_sector': 'https://tradefinder.in/api_be/data/order/all_sector',
  'daily-index': 'https://tradefinder.in/api_be/data/order/daily-index',
  'sector_scope': 'https://tradefinder.in/api_be/data/sector_scope',
  'market_pulse': 'https://tradefinder.in/api_be/data/market_pulse',
};

/** Endpoints whose payload shape has been confirmed and has a parser. The rest
 *  are captured raw — see the module note above. */
export const TF_PARSED_ENDPOINTS: readonly TfEndpoint[] = ['all_sector', 'daily-index'];
