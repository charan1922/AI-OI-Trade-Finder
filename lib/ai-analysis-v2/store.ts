/**
 * AI Analysis v2 — its OWN thread (table `ai_v2_messages`), per IST day. Never the v1 `operator_chat` table:
 * v1 and v2 are independent (operator 2026-11-06), and the auto-trader never reads this table.
 *
 * As in the operator's reference agent: a turn saves the question and an EMPTY answer first (reserveTurn), then
 * fills the answer in at the end (finishAnswer) — so an answer that fails or is stopped part way is still recorded,
 * marked partial with its reason. Repo convention: raw CREATE TABLE IF NOT EXISTS, mirrored in schema.prisma.
 */

import { prisma } from '@/lib/db';
import type { ActionStatus, ActionView, AnswerDetails, V2Action, V2Message } from './types';

let ready = false;

async function ensureTable(): Promise<void> {
  if (ready) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ai_v2_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      date          TEXT NOT NULL,
      role          TEXT NOT NULL,
      content       TEXT NOT NULL,
      at            TEXT NOT NULL,
      model         TEXT,
      detailsJson   TEXT,
      actionJson    TEXT,
      actionStatus  TEXT,
      actionResult  TEXT,
      imagesJson    TEXT,
      partial       INTEGER NOT NULL DEFAULT 0,
      failureReason TEXT
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_ai_v2_messages_date ON ai_v2_messages(date, id)`);
  ready = true;
}

const COLS = 'id, date, role, content, at, model, detailsJson, actionJson, actionStatus, actionResult, imagesJson, partial, failureReason';

interface Row {
  id: number | bigint;
  date: string;
  role: string;
  content: string;
  at: string;
  model: string | null;
  detailsJson: string | null;
  actionJson: string | null;
  actionStatus: string | null;
  actionResult: string | null;
  imagesJson: string | null;
  partial: number | bigint;
  failureReason: string | null;
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toMessage(r: Row): V2Message {
  const a = parse<V2Action>(r.actionJson);
  const action: ActionView | null = a
    ? { ...a, status: (r.actionStatus as ActionStatus) ?? 'pending', result: r.actionResult }
    : null;
  return {
    id: Number(r.id),
    date: r.date,
    role: r.role === 'user' ? 'user' : 'assistant',
    content: r.content,
    at: r.at,
    model: r.model,
    details: parse<AnswerDetails>(r.detailsJson),
    action,
    images: parse<string[]>(r.imagesJson),
    partial: Number(r.partial) === 1,
    failureReason: r.failureReason,
  };
}

async function insert(row: {
  date: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string | null;
  details?: AnswerDetails | null;
  action?: V2Action | null;
  images?: string[] | null;
}): Promise<V2Message> {
  await ensureTable();
  // RETURNING gives back THIS row — a read-back of "the newest row" could return a concurrent insert.
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO ai_v2_messages (date, role, content, at, model, detailsJson, actionJson, actionStatus, imagesJson)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLS}`,
    row.date,
    row.role,
    row.content,
    new Date().toISOString(),
    row.model ?? null,
    row.details ? JSON.stringify(row.details) : null,
    row.action ? JSON.stringify(row.action) : null,
    row.action ? 'pending' : null,
    row.images?.length ? JSON.stringify(row.images) : null
  )) as Row[];
  return toMessage(rows[0]);
}

/** The operator's question and an empty answer, saved together before the agent runs. */
export async function reserveTurn(
  date: string,
  question: string
): Promise<{ user: V2Message; answer: V2Message }> {
  const user = await insert({ date, role: 'user', content: question });
  const answer = await insert({ date, role: 'assistant', content: '' });
  return { user, answer };
}

export async function setMessageImages(id: number, names: string[]): Promise<void> {
  await ensureTable();
  await prisma.$executeRawUnsafe(`UPDATE ai_v2_messages SET imagesJson = ? WHERE id = ?`, JSON.stringify(names), id);
}

/** Fill in the answer reserved by reserveTurn. `failureReason` marks it partial. */
export async function finishAnswer(
  id: number,
  text: string,
  details: AnswerDetails,
  model: string | null,
  failureReason: string | null
): Promise<V2Message | null> {
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `UPDATE ai_v2_messages SET content = ?, detailsJson = ?, model = ?, partial = ?, failureReason = ? WHERE id = ?`,
    text,
    JSON.stringify(details),
    model,
    failureReason ? 1 : 0,
    failureReason,
    id
  );
  return getMessage(id);
}

/** An answer the AI posted on its own (a fired watch, a check-in, or a code-written fallback note). */
export function addAssistantMessage(
  date: string,
  content: string,
  details: AnswerDetails,
  model: string | null
): Promise<V2Message> {
  return insert({ date, role: 'assistant', content, details, model });
}

/** An action row — a Confirm card (Ask) or the record of an Auto action. */
export function addActionRow(date: string, description: string, action: V2Action): Promise<V2Message> {
  return insert({ date, role: 'assistant', content: description, action });
}

export async function getMessage(id: number): Promise<V2Message | null> {
  await ensureTable();
  const rows = (await prisma.$queryRawUnsafe(`SELECT ${COLS} FROM ai_v2_messages WHERE id = ?`, id)) as Row[];
  return rows[0] ? toMessage(rows[0]) : null;
}

/** Atomic pending → `to`. False when someone else already decided it (double tap, second tab, auto). */
export async function claimAction(id: number, to: 'running' | 'cancelled'): Promise<boolean> {
  await ensureTable();
  const changed = await prisma.$executeRawUnsafe(
    `UPDATE ai_v2_messages SET actionStatus = ? WHERE id = ? AND actionStatus = 'pending'`,
    to,
    id
  );
  return Number(changed) === 1;
}

export async function finishAction(id: number, status: 'done' | 'failed', result: string): Promise<void> {
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `UPDATE ai_v2_messages SET actionStatus = ?, actionResult = ? WHERE id = ?`,
    status,
    result.slice(0, 500),
    id
  );
}

/** The day's thread, oldest first. `limit` keeps the NEWEST rows. Empty reserved answers are left out. */
export async function listMessages(date: string, limit = 200): Promise<V2Message[]> {
  await ensureTable();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${COLS} FROM (
       SELECT ${COLS} FROM ai_v2_messages WHERE date = ? ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`,
    date,
    limit
  )) as Row[];
  return rows.map(toMessage).filter((m) => !(m.role === 'assistant' && !m.action && m.content === '' && !m.partial));
}
