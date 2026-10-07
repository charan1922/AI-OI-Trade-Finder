/**
 * The TradeFinder feeds we capture — the single source of truth for which
 * endpoints exist and what URL each one lives at.
 *
 * LEAF MODULE ON PURPOSE: no imports at all, so the ingest route, the store and
 * the DB-free CI checks can all read it.
 *
 * EXACTLY TWO FEEDS (operator request 2026-10-08): `market_pulse` and
 * `sector_scope`. This list IS the allowlist — every other /api_be/ response the
 * relay sees is dropped before it reaches the database. Both are fired by the
 * single https://tradefinder.in/marketPulse page (verified on the worker box),
 * so that is the only page the worker opens.
 *
 * Both are captured RAW: `recordTfLiveCapture` stores the full `payloadJson`
 * on every capture, so a parser can be written later and back-applied to
 * everything stored. Guessing a schema is how param_2/param_3 got swapped once.
 *
 * The retired feeds (`all_sector`, `daily-index`, `rfactor_data`,
 * `check_signal`) are no longer captured, but their tags stay in `TfEndpoint`
 * because old rows remain in tf_live_captures and the history readers query them.
 * Re-capturing one means adding it to TF_ENDPOINTS, TF_ENDPOINT_URL AND its own
 * `endsWith` case in `endpointTagFor()` (lib/tf-live/ingest.ts) — the generic
 * fallback matches none of TradeFinder's real paths, so an entry without one is
 * silently dead (market_pulse was dropped on every response for 18 days this
 * way). `scripts/verify-tf-ingest.ts` asserts every entry round-trips.
 *
 * Note this is TradeFinder's OWN sector_scope, unrelated to this app's
 * /sector-scope page (which reads the now-retired all_sector feed).
 */

export const TF_ENDPOINTS = ['market_pulse', 'sector_scope'] as const;

/** What we CAPTURE today. */
export type TfCapturedEndpoint = (typeof TF_ENDPOINTS)[number];

/** Every tag that may exist in stored history. The retired feeds stay READABLE
 *  (old rows are still in tf_live_captures and the history/EOD pages query
 *  them) but are no longer captured — narrowed to two feeds 2026-10-08 at the
 *  operator's request. */
export type TfEndpoint = TfCapturedEndpoint | 'all_sector' | 'rfactor_data' | 'daily-index' | 'check_signal';

export const TF_ENDPOINT_URL: Record<TfCapturedEndpoint, string> = {
  'market_pulse': 'https://tradefinder.in/api_be/data/market_pulse',
  'sector_scope': 'https://tradefinder.in/api_be/data/sector_scope',
};

/**
 * Every stored feed that holds TradeFinder's per-stock R-Factor BOARD, newest
 * source first. `sector_scope` (captured since 2026-10-08) carries the same
 * basket → symbol → param_N board the retired feeds did, so the Running Race,
 * the TF snapshot and the /live TF column read all three: today's data comes
 * from sector_scope, older days from whatever was captured then. Parse with
 * `parseTfBoard()` — each feed nests the board differently.
 */
export const TF_BOARD_ENDPOINTS = ['sector_scope', 'rfactor_data', 'all_sector'] as const;

/** Every stored feed that holds TradeFinder's per-SECTOR values (param_3):
 *  sector_scope embeds the old `daily-index` list. Parse with `parseTfIndices()`. */
export const TF_INDEX_ENDPOINTS = ['sector_scope', 'daily-index'] as const;

/** SQL `IN (…)` lists for the two sets above — fixed literals, never user input. */
export const TF_BOARD_ENDPOINTS_SQL = TF_BOARD_ENDPOINTS.map((e) => `'${e}'`).join(', ');
export const TF_INDEX_ENDPOINTS_SQL = TF_INDEX_ENDPOINTS.map((e) => `'${e}'`).join(', ');
