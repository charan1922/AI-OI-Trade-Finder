/**
 * Operator chat persistence — one append-only table, repo derived-table
 * convention (raw CREATE TABLE IF NOT EXISTS via Prisma, mirrored in
 * schema.prisma as `OperatorChat` so `db push` keeps it).
 *
 * The thread is per IST day and shared: the page renders it, the chat
 * assistant continues it, and the auto-trader reads the operator's side of it.
 * That single source is what keeps "the chat" and "what the trader heard" from
 * ever disagreeing.
 */

import { prisma } from '@/lib/db';
import type { OperatorMessage } from './format';

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
  tableReady = true;
}

interface Row {
  id: number | bigint;
  date: string;
  role: string;
  content: string;
  at: string;
}

function toMessage(r: Row): OperatorMessage {
  return {
    id: Number(r.id),
    date: r.date,
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: r.content,
    at: r.at,
  };
}

export async function addOperatorMessage(
  date: string,
  role: 'user' | 'assistant',
  content: string
): Promise<OperatorMessage> {
  await ensureTable();
  const at = new Date().toISOString();
  await prisma.$executeRawUnsafe(
    `INSERT INTO operator_chat (date, role, content, at) VALUES (?, ?, ?, ?)`,
    date,
    role,
    content,
    at
  );
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, date, role, content, at FROM operator_chat WHERE date = ? ORDER BY id DESC LIMIT 1`,
    date
  )) as Row[];
  return toMessage(rows[0]);
}

/** The day's thread, oldest first. `limit` keeps the NEWEST rows. */
export async function listOperatorMessages(date: string, limit = 200): Promise<OperatorMessage[]> {
  await ensureTable();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, date, role, content, at FROM (
       SELECT id, date, role, content, at FROM operator_chat WHERE date = ? ORDER BY id DESC LIMIT ?
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
    `SELECT id, date, role, content, at FROM operator_chat WHERE date = ? AND role = 'user' AND id > ? ORDER BY id ASC`,
    date,
    afterId
  )) as Row[];
  return rows.map(toMessage);
}
