import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { prisma } from '@/lib/db';
import type { TfEndpoint } from '@/lib/tf-live/endpoints';
import { TF_BOARD_ENDPOINTS_SQL, TF_INDEX_ENDPOINTS_SQL } from '@/lib/tf-live/endpoints';
import { parseTfBoard, parseTfIndices } from '@/lib/tf-live/parse';

const SESSION_KEY_ENV = 'TF_LIVE_SESSION_KEY';
const MAX_TOKEN_LENGTH = 8_000;

let tablesReady = false;

async function ensureTables(): Promise<void> {
  if (tablesReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS tf_live_session (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      encryptedLt   TEXT NOT NULL,
      encryptedAt   TEXT NOT NULL,
      jwtExpiresAt  TEXT,
      updatedAt     TEXT NOT NULL,
      verifiedAt    TEXT,
      lastError     TEXT
    )
  `);
  // Guarded ALTER for boxes whose tf_live_session predates this column —
  // CREATE TABLE IF NOT EXISTS is a no-op once the table already exists.
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE tf_live_session ADD COLUMN jwtExpiresAt TEXT`);
  } catch {
    /* column already exists */
  }
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS tf_live_captures (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      capturedAt  TEXT NOT NULL,
      endpoint    TEXT NOT NULL,
      status      TEXT NOT NULL,
      payloadHash TEXT,
      payloadJson TEXT,
      error       TEXT
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_tf_live_captures_at ON tf_live_captures(capturedAt)`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS tf_live_rows (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      captureId   INTEGER NOT NULL,
      rowKey      TEXT NOT NULL,
      symbol      TEXT,
      payloadJson TEXT NOT NULL,
      UNIQUE(captureId, rowKey)
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_tf_live_rows_symbol ON tf_live_rows(symbol)`);
  // tf_live_session (the retired lt/at tokens) and tf_live_rows (parsed rows
  // nothing read) are kept only because schema.prisma declares them and old
  // boxes hold data in them — no code writes or reads them any more.
  // The browser-relay's cookie jar:
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS tf_browser_session (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      encryptedCookies  TEXT NOT NULL,
      updatedAt         TEXT NOT NULL,
      verifiedAt        TEXT,
      lastError         TEXT
    )
  `);
  tablesReady = true;
}

function sessionKey(): Buffer {
  const value = process.env[SESSION_KEY_ENV];
  if (!value) throw new Error(`${SESSION_KEY_ENV} is not configured`);
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error(`${SESSION_KEY_ENV} must be a base64-encoded 32-byte key`);
  return key;
}

/** Fail before accepting a sensitive value if encrypted storage is not ready. */
export function assertTfLiveSessionKeyConfigured(): void {
  sessionKey();
}

function encryptValue(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptValue(encrypted: string): string {
  const [version, ivText, tagText, ciphertextText] = encrypted.split(':');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) throw new Error('stored TradeFinder token is malformed');
  const decipher = createDecipheriv('aes-256-gcm', sessionKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64')), decipher.final()]).toString('utf8');
}

// ─── Browser-relay cookie session (lib/tf-live/browser.ts) ──────────────────

export interface TfBrowserSessionStatus {
  configured: boolean;
  updatedAt: string | null;
  verifiedAt: string | null;
  lastError: string | null;
}

/** Store the cookie jar the browser relay injects to start out logged in.
 *  Encrypted at rest (AES-256-GCM, TF_LIVE_SESSION_KEY). */
export async function saveTfBrowserCookies(cookieHeader: string): Promise<void> {
  if (!cookieHeader || cookieHeader.length > MAX_TOKEN_LENGTH) {
    throw new Error('cookie header is empty or too large');
  }
  await ensureTables();
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe(
    `INSERT INTO tf_browser_session (id, encryptedCookies, updatedAt, verifiedAt, lastError)
     VALUES (1, ?, ?, NULL, NULL)
     ON CONFLICT(id) DO UPDATE SET
       encryptedCookies = excluded.encryptedCookies,
       updatedAt = excluded.updatedAt,
       verifiedAt = NULL,
       lastError = NULL`,
    encryptValue(cookieHeader),
    now
  );
}

/** Used by the browser relay only; never return this from a Route Handler. */
export async function getTfBrowserCookies(): Promise<string | null> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT encryptedCookies FROM tf_browser_session WHERE id = 1`
  )) as { encryptedCookies: string }[];
  const row = rows[0];
  return row ? decryptValue(row.encryptedCookies) : null;
}

export async function getTfBrowserSessionStatus(): Promise<TfBrowserSessionStatus> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT updatedAt, verifiedAt, lastError FROM tf_browser_session WHERE id = 1`
  )) as { updatedAt: string; verifiedAt: string | null; lastError: string | null }[];
  const row = rows[0];
  return row
    ? { configured: true, updatedAt: row.updatedAt, verifiedAt: row.verifiedAt, lastError: row.lastError }
    : { configured: false, updatedAt: null, verifiedAt: null, lastError: null };
}

/** Called by the browser relay after every capture attempt: `ok` on at least
 *  one successful TradeFinder response seen, otherwise `error` describing why
 *  (crash, looks logged out, no response at all yet). */
export async function recordTfBrowserOutcome(ok: boolean, error?: string): Promise<void> {
  await ensureTables();
  const now = new Date().toISOString();
  if (ok) {
    await prisma.$executeRawUnsafe(`UPDATE tf_browser_session SET verifiedAt = ?, lastError = NULL WHERE id = 1`, now);
  } else {
    await prisma.$executeRawUnsafe(`UPDATE tf_browser_session SET lastError = ? WHERE id = 1`, error ?? 'unknown error');
  }
}

/** Retain an immutable response without exposing it through status APIs. */
export async function recordTfLiveCapture(input: {
  endpoint: string;
  status: 'success' | 'error';
  payloadJson?: string;
  error?: string;
}): Promise<number> {
  await ensureTables();
  const hash = input.payloadJson ? createHash('sha256').update(input.payloadJson).digest('hex') : null;
  await prisma.$executeRawUnsafe(
    `INSERT INTO tf_live_captures (capturedAt, endpoint, status, payloadHash, payloadJson, error) VALUES (?, ?, ?, ?, ?, ?)`,
    new Date().toISOString(),
    input.endpoint,
    input.status,
    hash,
    input.payloadJson ?? null,
    input.error ?? null
  );
  const idRows = (await prisma.$queryRawUnsafe(`SELECT last_insert_rowid() AS id`)) as { id: number }[];
  return Number(idRows[0]?.id ?? 0);
}

/** Wipe every stored capture and its rows — used to clear out the pile of
 *  error records left over from the lt/at-replay debugging period (2026-08-07/08)
 *  once the browser relay is confirmed working, so the /tf history tables
 *  start clean instead of showing weeks of now-irrelevant failures. Does NOT
 *  touch tf_live_session or tf_browser_session — those hold live credentials,
 *  not history. */
export async function clearTfLiveCaptureHistory(): Promise<void> {
  await ensureTables();
  await prisma.$executeRawUnsafe(`DELETE FROM tf_live_rows`);
  await prisma.$executeRawUnsafe(`DELETE FROM tf_live_captures`);
}

/** Latest capture per endpoint, for the /tf status panel's headline chips. */
export async function getLatestTfLiveCaptures(): Promise<
  { endpoint: string; capturedAt: string; status: string; error: string | null }[]
> {
  await ensureTables();
  return (await prisma.$queryRawUnsafe(`
    SELECT endpoint, capturedAt, status, error
      FROM tf_live_captures c
     WHERE capturedAt = (
       SELECT MAX(capturedAt) FROM tf_live_captures c2 WHERE c2.endpoint = c.endpoint
     )
     ORDER BY endpoint
  `)) as { endpoint: string; capturedAt: string; status: string; error: string | null }[];
}

/** Successes and errors per feed on one IST calendar date — the counts on /tf. */
export async function getTfCaptureCountsForDate(
  date: string
): Promise<{ endpoint: string; success: number; error: number }[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `
    SELECT endpoint,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error
      FROM tf_live_captures
     WHERE date(datetime(capturedAt, '+5 hours', '+30 minutes')) = ?
     GROUP BY endpoint
  `,
    date
  )) as { endpoint: string; success: unknown; error: unknown }[];
  // SQLite SUMs arrive as BigInt, which JSON cannot serialize — normalize here.
  return rows.map((r) => ({ endpoint: r.endpoint, success: Number(r.success ?? 0), error: Number(r.error ?? 0) }));
}

/** Every successful capture time on one IST date for the given feeds, oldest
 *  first — the /tf time picker's stops. */
export async function getTfCaptureTimesForDate(endpoints: readonly TfEndpoint[], date: string): Promise<string[]> {
  if (endpoints.length === 0) return [];
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `
    SELECT capturedAt FROM tf_live_captures
     WHERE endpoint IN (${endpoints.map(() => '?').join(', ')}) AND status = 'success'
       AND date(datetime(capturedAt, '+5 hours', '+30 minutes')) = ?
     ORDER BY capturedAt ASC
  `,
    ...endpoints,
    date
  )) as { capturedAt: string }[];
  return rows.map((r) => r.capturedAt);
}

/** Every IST calendar date with at least one SUCCESSFUL capture for the given
 *  endpoint, most recent first — the EOD page's date picker. */
export async function getTfLiveCaptureDates(endpoint: TfEndpoint): Promise<string[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `
    SELECT DISTINCT date(datetime(capturedAt, '+5 hours', '+30 minutes')) AS captureDate
    FROM tf_live_captures
    WHERE endpoint = ? AND status = 'success'
    ORDER BY captureDate DESC
  `,
    endpoint
  )) as { captureDate: string }[];
  return rows.map((r) => r.captureDate);
}

/** The LAST successful capture on the given IST calendar date for one
 *  endpoint — the EOD (closing) snapshot, not an intraday one, even if the
 *  collector ran several times that day. Returns the raw parsed payload plus
 *  when it was actually captured. */
export async function getTfLiveCaptureForDate(
  endpoint: TfEndpoint,
  date: string,
  /** ISO time: return the last capture AT OR BEFORE it (the /tf time picker). */
  atOrBefore?: string
): Promise<{ capturedAt: string; payload: unknown } | null> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `
    SELECT capturedAt, payloadJson
    FROM tf_live_captures
    WHERE endpoint = ? AND status = 'success'
      AND date(datetime(capturedAt, '+5 hours', '+30 minutes')) = ?
      AND capturedAt <= ?
    ORDER BY capturedAt DESC
    LIMIT 1
  `,
    endpoint,
    date,
    // ISO strings compare in time order; '9999' = no upper bound.
    atOrBefore ?? '9999'
  )) as { capturedAt: string; payloadJson: string | null }[];
  const row = rows[0];
  if (!row || !row.payloadJson) return null;
  try {
    return { capturedAt: row.capturedAt, payload: JSON.parse(row.payloadJson) };
  } catch {
    return null;
  }
}

/** Everything TradeFinder's own `all_sector` board carries per stock — the
 *  complete set, verified against a real captured payload (2026-08-10: each
 *  leaf holds exactly Symbol, param_0..param_3 and nothing else). /sector-scope
 *  renders entirely from this, which is why `ltp` is here: without it that page
 *  needed a Dhan quote call purely to fill one column TradeFinder was already
 *  sending us. */
export interface TfSymbolQuote {
  ltp: number | null;
  rFactor: number | null;
  pctChange: number | null;
  previousClose: number | null;
}

/**
 * Per-symbol lookup from the MOST RECENT successful board capture
 * (TF_BOARD_ENDPOINTS),
 * whatever date that was — feeds the Live Urgency page's TF column. The schema
 * is owned by lib/tf-live/parse.ts and was CONFIRMED against a real payload
 * (2026-08-06), so nothing here guesses at field names; an unparseable payload
 * yields no rows rather than invented values.
 *
 * Note the deliberate difference from lib/tf-live/snapshot.ts: this returns the
 * latest capture from ANY date, because a display column showing yesterday's TF
 * number is acceptable. Anything feeding a TRADE decision must use the
 * date-scoped snapshot instead — a stale board must never be read as today's.
 */
export async function getLatestTfRFactorBySymbol(): Promise<{
  capturedAt: string | null;
  bySymbol: Map<string, TfSymbolQuote>;
}> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(`
    SELECT endpoint, capturedAt, payloadJson
    FROM tf_live_captures
    WHERE endpoint IN (${TF_BOARD_ENDPOINTS_SQL}) AND status = 'success'
    ORDER BY capturedAt DESC
    LIMIT 1
  `)) as { endpoint: string; capturedAt: string; payloadJson: string | null }[];
  const row = rows[0];
  const bySymbol = new Map<string, TfSymbolQuote>();
  if (!row?.payloadJson) return { capturedAt: null, bySymbol };

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadJson);
  } catch {
    return { capturedAt: null, bySymbol };
  }
  const parsedRows = parseTfBoard(row.endpoint, parsed);
  for (const r of parsedRows) {
    bySymbol.set(r.symbol, { ltp: r.ltp, rFactor: r.rFactor, pctChange: r.pctChange, previousClose: r.previousClose });
  }
  return { capturedAt: row.capturedAt, bySymbol };
}

/**
 * The latest successful sector-values capture (TF_INDEX_ENDPOINTS) — TradeFinder's own per-index
 * chart values (param_3), used by /sector-scope's sector-level bar chart.
 * Same "latest from any date" rule as getLatestTfRFactorBySymbol above: this
 * feeds a display chart, never a trade decision.
 */
export async function getLatestTfDailyIndexValues(): Promise<{
  capturedAt: string | null;
  byIndex: Map<string, number>;
}> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(`
    SELECT endpoint, capturedAt, payloadJson
    FROM tf_live_captures
    WHERE endpoint IN (${TF_INDEX_ENDPOINTS_SQL}) AND status = 'success'
    ORDER BY capturedAt DESC
    LIMIT 1
  `)) as { endpoint: string; capturedAt: string; payloadJson: string | null }[];
  const row = rows[0];
  const byIndex = new Map<string, number>();
  if (!row?.payloadJson) return { capturedAt: null, byIndex };

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadJson);
  } catch {
    return { capturedAt: null, byIndex };
  }
  for (const r of parseTfIndices(row.endpoint, parsed)) {
    if (r.value != null) byIndex.set(r.name, r.value);
  }
  return { capturedAt: row.capturedAt, byIndex };
}
