/**
 * Commentary v2 background persistence — the On/Off switch, the watches, the AI's day notebook and
 * the wake-up log. Same derived-table convention as store.ts (raw CREATE TABLE IF NOT EXISTS,
 * mirrored in schema.prisma so `db push` keeps them).
 *
 * The switch defaults OFF: with it off nothing here is read by the chat route, so /trade-commentary
 * (v1) behaves exactly as before.
 */

import { isAllowedMimoModel, MIMO_MODELS } from '@/lib/ai-commentary/client';
import { prisma } from '@/lib/db';
import { type AutoActions, DEFAULT_AUTO_ACTIONS, normaliseAutoActions } from './auto-act';
import { ACTION_KINDS, type ActionKind } from './format';
import type { WatchKind, WatchParams, WatchStatus } from './watches';

/** v2's chat answers with the LOWER-COST MiMo tier by default (operator 2026-10-29). Separate from the
 *  auto-trader's `mimoModel` on purpose: picking a chat model never changes how trades are decided. */
export const DEFAULT_CHAT_MODEL = 'mimo-v2.6-flash';
export const CHAT_MODELS: readonly string[] = MIMO_MODELS;

let tablesReady = false;

async function ensureTables(): Promise<void> {
  if (tablesReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS chat_background (
      id        INTEGER PRIMARY KEY,
      enabled   INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL
    )
  `);
  const bgCols = (await prisma.$queryRawUnsafe(`PRAGMA table_info(chat_background)`)) as { name: string }[];
  if (!bgCols.some((c) => c.name === 'chatModel')) {
    await prisma.$executeRawUnsafe(`ALTER TABLE chat_background ADD COLUMN chatModel TEXT`);
  }
  if (!bgCols.some((c) => c.name === 'autoActionsJson')) {
    await prisma.$executeRawUnsafe(`ALTER TABLE chat_background ADD COLUMN autoActionsJson TEXT`);
  }
  if (!bgCols.some((c) => c.name === 'nextCheckAt')) {
    await prisma.$executeRawUnsafe(`ALTER TABLE chat_background ADD COLUMN nextCheckAt TEXT`);
  }
  // NULL = the operator never touched the Background switch → default ON (operator 2026-10-30: "let AI on").
  // Needed because other setters create the row with enabled = 0 as a side effect.
  if (!bgCols.some((c) => c.name === 'backgroundSet')) {
    await prisma.$executeRawUnsafe(`ALTER TABLE chat_background ADD COLUMN backgroundSet INTEGER`);
  }
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS chat_watches (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      date          TEXT NOT NULL,
      kind          TEXT NOT NULL,
      paramsJson    TEXT NOT NULL,
      label         TEXT NOT NULL,
      createdBy     TEXT NOT NULL,
      status        TEXT NOT NULL,
      createdAt     TEXT NOT NULL,
      firedAt       TEXT,
      firedDetail   TEXT,
      lastCheckedAt TEXT,
      lastCheckNote TEXT
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_chat_watches_date ON chat_watches(date, id)`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS chat_notebook (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      at   TEXT NOT NULL,
      text TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_chat_notebook_date ON chat_notebook(date, id)`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS chat_wakeups (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      date         TEXT NOT NULL,
      at           TEXT NOT NULL,
      watchIdsJson TEXT NOT NULL,
      outcome      TEXT NOT NULL,
      messageId    INTEGER,
      detail       TEXT
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_chat_wakeups_date ON chat_wakeups(date, id)`);
  const wkCols = (await prisma.$queryRawUnsafe(`PRAGMA table_info(chat_wakeups)`)) as { name: string }[];
  if (!wkCols.some((c) => c.name === 'kind')) {
    await prisma.$executeRawUnsafe(`ALTER TABLE chat_wakeups ADD COLUMN kind TEXT NOT NULL DEFAULT 'watch'`);
  }
  tablesReady = true;
}

// ── switch ───────────────────────────────────────────────────────────────────

export async function isBackgroundEnabled(): Promise<boolean> {
  try {
    await ensureTables();
    const rows = (await prisma.$queryRawUnsafe(`SELECT enabled, backgroundSet FROM chat_background WHERE id = 1`)) as {
      enabled: number | bigint;
      backgroundSet: number | bigint | null;
    }[];
    // Default ON until the operator turns it OFF. v1 is still fully protected: everything also requires
    // v2 to be the selected page (isBackgroundActive / isV2Selected).
    if (!rows[0] || rows[0].backgroundSet == null) return true;
    return Number(rows[0].enabled) === 1;
  } catch {
    return false;
  }
}

/**
 * ONE version at a time (operator 2026-10-30): v2's background work runs only while /config selects v2
 * (COMMENTARY_V2) AND v2's own Background switch is ON. With v1 selected, nothing of v2 runs — no watch
 * checks, no wake-ups, no watch tools in the chat — whatever v2's switch says.
 */
export async function isV2Selected(): Promise<boolean> {
  const { getToggle } = await import('@/lib/config/feature-toggles');
  return getToggle('COMMENTARY_V2', false);
}

export async function isBackgroundActive(): Promise<boolean> {
  return (await isV2Selected()) && (await isBackgroundEnabled());
}

/** Make v2 the active AI Analysis (the same /config toggle the sidebar reads). */
export async function selectV2(): Promise<void> {
  const { setToggle } = await import('@/lib/config/feature-toggles');
  await setToggle('COMMENTARY_V2', true);
}

/**
 * The AI's OWN status, told to it on every v2 turn — so it never guesses. On 2026-10-30 it told the operator
 * "I have no background loop" while its check-ins were merely PAUSED (Settings still selected v1).
 */
export async function backgroundStatusBlock(): Promise<string> {
  const [v2, on] = await Promise.all([isV2Selected(), isBackgroundEnabled()]);
  if (!v2) {
    return 'YOUR BACKGROUND STATUS: PAUSED — Settings → Assistant still selects v1, so your self-paced check-ins, watches and auto actions are NOT running. If asked, say exactly that and tell the operator to tap "Make v2 active" on this page. Never say you have no background loop.';
  }
  if (!on) {
    return 'YOUR BACKGROUND STATUS: OFF — the operator switched Background off on this page, so you only answer when asked. If asked, say so and that turning Background ON starts your check-ins.';
  }
  return 'YOUR BACKGROUND STATUS: ACTIVE — in market hours you check in by yourself (every 5 min while a position is open, otherwise 5–30 min, your choice), review open positions on the thesis, and act on the operator\'s Auto actions. Watches are checked every 60s.';
}

export async function setBackgroundEnabled(enabled: boolean): Promise<void> {
  await ensureTables();
  await prisma.$executeRawUnsafe(
    `INSERT INTO chat_background (id, enabled, updatedAt, backgroundSet) VALUES (1, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updatedAt = excluded.updatedAt, backgroundSet = 1`,
    enabled ? 1 : 0,
    new Date().toISOString()
  );
}

/** Which action kinds v2 runs by itself (auto) vs as a Confirm card (ask) — operator switches on the v2 page. */
export async function getAutoActions(): Promise<AutoActions> {
  try {
    await ensureTables();
    const rows = (await prisma.$queryRawUnsafe(`SELECT autoActionsJson FROM chat_background WHERE id = 1`)) as {
      autoActionsJson: string | null;
    }[];
    const raw = rows[0]?.autoActionsJson;
    return normaliseAutoActions(raw ? JSON.parse(raw) : null);
  } catch {
    // A read failure must never make MORE things automatic: fall back to the defaults.
    return { ...DEFAULT_AUTO_ACTIONS };
  }
}

export async function setAutoAction(kind: ActionKind, auto: boolean): Promise<AutoActions> {
  if (!ACTION_KINDS.includes(kind)) throw new Error(`unknown action kind ${String(kind)}`);
  const next = { ...(await getAutoActions()), [kind]: auto };
  await ensureTables();
  await prisma.$executeRawUnsafe(
    `INSERT INTO chat_background (id, enabled, updatedAt, autoActionsJson) VALUES (1, 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET autoActionsJson = excluded.autoActionsJson, updatedAt = excluded.updatedAt`,
    new Date().toISOString(),
    JSON.stringify(next)
  );
  return next;
}

/** When the AI's self-paced check-in is next due (it picks 5–30 min each time). Null = due now. */
export async function getNextCheckAt(): Promise<string | null> {
  try {
    await ensureTables();
    const rows = (await prisma.$queryRawUnsafe(`SELECT nextCheckAt FROM chat_background WHERE id = 1`)) as {
      nextCheckAt: string | null;
    }[];
    return rows[0]?.nextCheckAt ?? null;
  } catch {
    return null;
  }
}

export async function setNextCheckAt(iso: string): Promise<void> {
  await ensureTables();
  await prisma.$executeRawUnsafe(
    `INSERT INTO chat_background (id, enabled, updatedAt, nextCheckAt) VALUES (1, 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET nextCheckAt = excluded.nextCheckAt`,
    new Date().toISOString(),
    iso
  );
}

/** The MiMo model v2's chat and wake-ups answer with. Unknown/missing → the default (Flash). */
export async function getChatModel(): Promise<string> {
  try {
    await ensureTables();
    const rows = (await prisma.$queryRawUnsafe(`SELECT chatModel FROM chat_background WHERE id = 1`)) as {
      chatModel: string | null;
    }[];
    const m = rows[0]?.chatModel ?? null;
    return m && isAllowedMimoModel(m) ? m : DEFAULT_CHAT_MODEL;
  } catch {
    return DEFAULT_CHAT_MODEL;
  }
}

export async function setChatModel(model: string): Promise<void> {
  if (!isAllowedMimoModel(model)) throw new Error(`Unsupported MiMo model "${model}". Allowed: ${MIMO_MODELS.join(', ')}`);
  await ensureTables();
  await prisma.$executeRawUnsafe(
    `INSERT INTO chat_background (id, enabled, updatedAt, chatModel) VALUES (1, 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET chatModel = excluded.chatModel, updatedAt = excluded.updatedAt`,
    new Date().toISOString(),
    model
  );
}

// ── watches ──────────────────────────────────────────────────────────────────

export interface ChatWatch {
  id: number;
  date: string;
  kind: WatchKind;
  params: WatchParams;
  label: string;
  createdBy: 'operator' | 'ai';
  status: WatchStatus;
  createdAt: string;
  firedAt: string | null;
  firedDetail: string | null;
  lastCheckedAt: string | null;
  lastCheckNote: string | null;
}

interface WatchRow {
  id: number | bigint;
  date: string;
  kind: string;
  paramsJson: string;
  label: string;
  createdBy: string;
  status: string;
  createdAt: string;
  firedAt: string | null;
  firedDetail: string | null;
  lastCheckedAt: string | null;
  lastCheckNote: string | null;
}

function toWatch(r: WatchRow): ChatWatch {
  let params: WatchParams = {};
  try {
    params = JSON.parse(r.paramsJson) as WatchParams;
  } catch {
    params = {};
  }
  return {
    id: Number(r.id),
    date: r.date,
    kind: r.kind as WatchKind,
    params,
    label: r.label,
    createdBy: r.createdBy === 'ai' ? 'ai' : 'operator',
    status: r.status as WatchStatus,
    createdAt: r.createdAt,
    firedAt: r.firedAt,
    firedDetail: r.firedDetail,
    lastCheckedAt: r.lastCheckedAt,
    lastCheckNote: r.lastCheckNote,
  };
}

const WATCH_COLS =
  'id, date, kind, paramsJson, label, createdBy, status, createdAt, firedAt, firedDetail, lastCheckedAt, lastCheckNote';

export async function listWatches(date: string): Promise<ChatWatch[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${WATCH_COLS} FROM chat_watches WHERE date = ? ORDER BY id ASC`,
    date
  )) as WatchRow[];
  return rows.map(toWatch);
}

export async function getWatch(id: number): Promise<ChatWatch | null> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(`SELECT ${WATCH_COLS} FROM chat_watches WHERE id = ?`, id)) as WatchRow[];
  return rows[0] ? toWatch(rows[0]) : null;
}

export async function insertWatch(w: {
  date: string;
  kind: WatchKind;
  params: WatchParams;
  label: string;
  createdBy: 'operator' | 'ai';
}): Promise<ChatWatch> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO chat_watches (date, kind, paramsJson, label, createdBy, status, createdAt)
     VALUES (?, ?, ?, ?, ?, 'watching', ?) RETURNING ${WATCH_COLS}`,
    w.date,
    w.kind,
    JSON.stringify(w.params),
    w.label,
    w.createdBy,
    new Date().toISOString()
  )) as WatchRow[];
  return toWatch(rows[0]);
}

/** Record a check without changing state (the panel shows "last checked … : note"). */
export async function noteWatchCheck(id: number, note: string): Promise<void> {
  await ensureTables();
  await prisma.$executeRawUnsafe(
    `UPDATE chat_watches SET lastCheckedAt = ?, lastCheckNote = ? WHERE id = ?`,
    new Date().toISOString(),
    note.slice(0, 300),
    id
  );
}

/**
 * Atomic watching → `to`. False when it already left `watching` (fired, cancelled, expired), so a
 * watch can never fire twice or be revived by a late cancel.
 */
export async function closeWatch(
  id: number,
  to: Exclude<WatchStatus, 'watching'>,
  detail: string | null = null
): Promise<boolean> {
  await ensureTables();
  const now = new Date().toISOString();
  const changed = await prisma.$executeRawUnsafe(
    `UPDATE chat_watches
        SET status = ?, firedAt = CASE WHEN ? = 'fired' THEN ? ELSE firedAt END,
            firedDetail = COALESCE(?, firedDetail), lastCheckedAt = ?
      WHERE id = ? AND status = 'watching'`,
    to,
    to,
    now,
    detail?.slice(0, 300) ?? null,
    now,
    id
  );
  return Number(changed) === 1;
}

// ── notebook ─────────────────────────────────────────────────────────────────

export interface NotebookNote {
  id: number;
  at: string;
  text: string;
}

export const NOTE_MAX_CHARS = 300;

export async function addNote(date: string, text: string): Promise<NotebookNote> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO chat_notebook (date, at, text) VALUES (?, ?, ?) RETURNING id, at, text`,
    date,
    new Date().toISOString(),
    text.trim().slice(0, NOTE_MAX_CHARS)
  )) as { id: number | bigint; at: string; text: string }[];
  return { id: Number(rows[0].id), at: rows[0].at, text: rows[0].text };
}

/** The day's notes, oldest first; `limit` keeps the NEWEST. */
export async function listNotes(date: string, limit = 50): Promise<NotebookNote[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, at, text FROM (SELECT id, at, text FROM chat_notebook WHERE date = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
    date,
    limit
  )) as { id: number | bigint; at: string; text: string }[];
  return rows.map((r) => ({ id: Number(r.id), at: r.at, text: r.text }));
}

// ── wake-ups ─────────────────────────────────────────────────────────────────

export interface WakeupRow {
  id: number;
  at: string;
  /** 'watch' = a fired watch woke it; 'heartbeat' = its own self-paced check-in. */
  kind: 'watch' | 'heartbeat';
  watchIds: number[];
  /** quiet = a check-in that found nothing worth posting (logged, not posted). */
  outcome: 'ai' | 'fallback' | 'capped' | 'quiet';
  messageId: number | null;
  detail: string | null;
}

export async function recordWakeup(w: {
  date: string;
  kind?: WakeupRow['kind'];
  watchIds: number[];
  outcome: WakeupRow['outcome'];
  messageId: number | null;
  detail: string | null;
}): Promise<void> {
  await ensureTables();
  await prisma.$executeRawUnsafe(
    `INSERT INTO chat_wakeups (date, at, watchIdsJson, outcome, messageId, detail, kind) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    w.date,
    new Date().toISOString(),
    JSON.stringify(w.watchIds),
    w.outcome,
    w.messageId,
    w.detail?.slice(0, 500) ?? null,
    w.kind ?? 'watch'
  );
}

export async function listWakeups(date: string): Promise<WakeupRow[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, at, watchIdsJson, outcome, messageId, detail, kind FROM chat_wakeups WHERE date = ? ORDER BY id ASC`,
    date
  )) as {
    id: number | bigint;
    at: string;
    watchIdsJson: string;
    outcome: string;
    messageId: number | bigint | null;
    detail: string | null;
    kind: string | null;
  }[];
  return rows.map((r) => {
    let watchIds: number[] = [];
    try {
      watchIds = JSON.parse(r.watchIdsJson) as number[];
    } catch {
      watchIds = [];
    }
    return {
      id: Number(r.id),
      at: r.at,
      kind: r.kind === 'heartbeat' ? 'heartbeat' : 'watch',
      watchIds,
      outcome: r.outcome as WakeupRow['outcome'],
      messageId: r.messageId == null ? null : Number(r.messageId),
      detail: r.detail,
    };
  });
}

// ── long-term memory (operator-approved, survives across days) ──────────────

/**
 * What the AI may remember across days: LESSONS about its own work ("I called a stale board live — check
 * boardAtIST first") and the operator's PREFERENCES ("explain exits in rupees"). Never market facts —
 * prices and levels go stale overnight. The AI only PROPOSES; nothing is used until the operator saves it.
 */
export type MemoryKind = 'lesson' | 'preference';
export type MemoryStatus = 'pending' | 'saved' | 'rejected' | 'deleted';

export interface ChatMemory {
  id: number;
  kind: MemoryKind;
  text: string;
  status: MemoryStatus;
  createdAt: string;
  decidedAt: string | null;
}

export const MEMORY_MAX_CHARS = 200;
export const MAX_PENDING_MEMORIES = 5;
export const MAX_SAVED_MEMORIES = 40;

let memoryReady = false;

async function ensureMemoryTable(): Promise<void> {
  if (memoryReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS chat_memory (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      kind      TEXT NOT NULL,
      text      TEXT NOT NULL,
      status    TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      decidedAt TEXT
    )
  `);
  memoryReady = true;
}

interface MemoryRow {
  id: number | bigint;
  kind: string;
  text: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
}

const toMemory = (r: MemoryRow): ChatMemory => ({
  id: Number(r.id),
  kind: r.kind === 'preference' ? 'preference' : 'lesson',
  text: r.text,
  status: r.status as MemoryStatus,
  createdAt: r.createdAt,
  decidedAt: r.decidedAt,
});

/** Pending + saved, newest first (rejected/deleted are kept for audit but not listed). */
export async function listMemories(): Promise<ChatMemory[]> {
  await ensureMemoryTable();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, kind, text, status, createdAt, decidedAt FROM chat_memory
      WHERE status IN ('pending', 'saved') ORDER BY id DESC`
  )) as MemoryRow[];
  return rows.map(toMemory);
}

/** Saved memories for the framing, newest first, capped. Best-effort: a DB hiccup → none. */
export async function savedMemories(): Promise<ChatMemory[]> {
  try {
    return (await listMemories()).filter((m) => m.status === 'saved').slice(0, MAX_SAVED_MEMORIES);
  } catch {
    return [];
  }
}

export async function proposeMemory(
  kind: MemoryKind,
  rawText: string
): Promise<{ ok: true; memory: ChatMemory } | { ok: false; error: string }> {
  const text = rawText.trim().replace(/\s+/g, ' ');
  if (!text) return { ok: false, error: 'empty memory' };
  if (text.length > MEMORY_MAX_CHARS) return { ok: false, error: `keep it under ${MEMORY_MAX_CHARS} characters` };
  const existing = await listMemories();
  if (existing.some((m) => m.text.toLowerCase() === text.toLowerCase())) {
    return { ok: false, error: 'already remembered (or already waiting for approval)' };
  }
  if (existing.filter((m) => m.status === 'pending').length >= MAX_PENDING_MEMORIES) {
    return { ok: false, error: `${MAX_PENDING_MEMORIES} memories already wait for the operator — ask them to review those first` };
  }
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO chat_memory (kind, text, status, createdAt) VALUES (?, ?, 'pending', ?)
     RETURNING id, kind, text, status, createdAt, decidedAt`,
    kind,
    text,
    new Date().toISOString()
  )) as MemoryRow[];
  return { ok: true, memory: toMemory(rows[0]) };
}

/** Operator decision. pending → saved | rejected; saved → deleted. False when the transition is not allowed. */
export async function decideMemory(id: number, to: 'saved' | 'rejected' | 'deleted'): Promise<boolean> {
  await ensureMemoryTable();
  const from = to === 'deleted' ? 'saved' : 'pending';
  const changed = await prisma.$executeRawUnsafe(
    `UPDATE chat_memory SET status = ?, decidedAt = ? WHERE id = ? AND status = ?`,
    to,
    new Date().toISOString(),
    id,
    from
  );
  return Number(changed) === 1;
}
