/**
 * Operator chat persistence — one append-only table, repo derived-table
 * convention (raw CREATE TABLE IF NOT EXISTS via Prisma + guarded ALTERs,
 * mirrored in schema.prisma as `OperatorChat` so `db push` keeps it).
 *
 * The thread is per IST day and shared: the page renders it, the chat
 * assistant continues it, and the auto-trader reads the operator's side of it.
 * That single source is what keeps "the chat" and "what the trader heard" from
 * ever disagreeing.
 *
 * An assistant row may carry a proposed ACTION (a Confirm card). actionStatus
 * moves pending → running → done | failed, or pending → cancelled, and the
 * pending → running step is an atomic compare-and-set (claimAction), so a
 * double tap or two open tabs can never run the same action twice.
 */

import { prisma } from '@/lib/db';
import type { ActionStatus, ChatAction, ChatToolUse, OperatorMessage } from './format';

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS operator_chat (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      date      TEXT NOT NULL,
      role      TEXT NOT NULL,
      content   TEXT NOT NULL,
      at        TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_operator_chat_date ON operator_chat(date, id)`);
  const cols = (await prisma.$queryRawUnsafe(`PRAGMA table_info(operator_chat)`)) as { name: string }[];
  const have = new Set(cols.map((c) => c.name));
  for (const col of ['actionJson TEXT', 'actionStatus TEXT', 'actionResult TEXT', 'toolsJson TEXT']) {
    if (!have.has(col.split(' ')[0])) await prisma.$executeRawUnsafe(`ALTER TABLE operator_chat ADD COLUMN ${col}`);
  }
  tableReady = true;
}

const COLS = 'id, date, role, content, at, actionJson, actionStatus, actionResult, toolsJson';

interface Row {
  id: number | bigint;
  date: string;
  role: string;
  content: string;
  at: string;
  actionJson: string | null;
  actionStatus: string | null;
  actionResult: string | null;
  toolsJson: string | null;
}

function toMessage(r: Row): OperatorMessage {
  let action: OperatorMessage['action'] = null;
  if (r.actionJson) {
    try {
      action = {
        ...(JSON.parse(r.actionJson) as ChatAction),
        status: (r.actionStatus as ActionStatus) ?? 'pending',
        result: r.actionResult,
      };
    } catch {
      action = null;
    }
  }
  let tools: ChatToolUse[] | null = null;
  if (r.toolsJson) {
    try {
      tools = JSON.parse(r.toolsJson) as ChatToolUse[];
    } catch {
      tools = null;
    }
  }
  return {
    id: Number(r.id),
    date: r.date,
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: r.content,
    at: r.at,
    action,
    tools,
  };
}

async function insertRow(
  date: string,
  role: 'user' | 'assistant',
  content: string,
  action: ChatAction | null,
  tools: ChatToolUse[] | null = null
): Promise<OperatorMessage> {
  await ensureTable();
  // RETURNING gives back THIS row — a read-back of "the newest row" could return a concurrent insert.
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO operator_chat (date, role, content, at, actionJson, actionStatus, toolsJson)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${COLS}`,
    date,
    role,
    content,
    new Date().toISOString(),
    action ? JSON.stringify(action) : null,
    action ? 'pending' : null,
    tools && tools.length > 0 ? JSON.stringify(tools) : null
  )) as Row[];
  return toMessage(rows[0]);
}

/** `tools` (assistant replies only) is DISPLAY-only: what it checked. It is never replayed to the model. */
export function addOperatorMessage(
  date: string,
  role: 'user' | 'assistant',
  content: string,
  tools: ChatToolUse[] | null = null
): Promise<OperatorMessage> {
  return insertRow(date, role, content, null, tools);
}

/** An assistant row carrying a proposed action — rendered as a Confirm card. */
export function addOperatorAction(date: string, description: string, action: ChatAction): Promise<OperatorMessage> {
  return insertRow(date, 'assistant', description, action);
}

export async function getOperatorMessage(id: number): Promise<OperatorMessage | null> {
  await ensureTable();
  const rows = (await prisma.$queryRawUnsafe(`SELECT ${COLS} FROM operator_chat WHERE id = ?`, id)) as Row[];
  return rows[0] ? toMessage(rows[0]) : null;
}

/** Atomic pending → `to`. False when someone else already decided it (double tap, second tab). */
export async function claimAction(id: number, to: 'running' | 'cancelled'): Promise<boolean> {
  await ensureTable();
  const changed = await prisma.$executeRawUnsafe(
    `UPDATE operator_chat SET actionStatus = ? WHERE id = ? AND actionStatus = 'pending'`,
    to,
    id
  );
  return Number(changed) === 1;
}

export async function finishAction(id: number, status: 'done' | 'failed', result: string): Promise<void> {
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `UPDATE operator_chat SET actionStatus = ?, actionResult = ? WHERE id = ?`,
    status,
    result,
    id
  );
}

/** The day's thread, oldest first. `limit` keeps the NEWEST rows. */
export async function listOperatorMessages(date: string, limit = 200): Promise<OperatorMessage[]> {
  await ensureTable();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${COLS} FROM (
       SELECT ${COLS} FROM operator_chat WHERE date = ? ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`,
    date,
    limit
  )) as Row[];
  return rows.map(toMessage);
}

/** Operator messages written after `afterId` — what a running pass has not seen yet. */
export async function operatorMessagesSince(date: string, afterId: number): Promise<OperatorMessage[]> {
  await ensureTable();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${COLS} FROM operator_chat WHERE date = ? AND role = 'user' AND id > ? ORDER BY id ASC`,
    date,
    afterId
  )) as Row[];
  return rows.map(toMessage);
}
