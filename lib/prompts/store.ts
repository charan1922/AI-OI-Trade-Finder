/**
 * Prompt versioning — every AI system prompt the app uses is recorded in the
 * prompt_versions table, one row per distinct text. Recording is AUTOMATIC:
 * each generation path calls recordPromptVersion(key, text) with the prompt it
 * is about to use; when the text differs from the key's latest stored version
 * a new version row is inserted (v1, v2, …), otherwise the existing version
 * number is returned. So the table is a complete, hands-off history of how
 * each prompt evolved, and rows in trade_commentary carry (promptKey,
 * promptVersion) saying exactly which prompt wrote them.
 *
 * The CODE remains the source of truth for what runs — this table is history
 * and audit, not a live override (deliberate: editing prompts in the DB with
 * no bench run would bypass the battle-testing).
 *
 * Keys in use:
 *   'trade-commentary' — lib/ai-commentary/generate.ts COMMENTARY_SYSTEM
 *   'auto-trader'      — lib/auto-trade/decision/system-prompt.ts AUTO_TRADER_SYSTEM
 *
 * Same derived-table convention as the rest of the repo (raw CREATE TABLE IF
 * NOT EXISTS, mirrored in schema.prisma).
 */

import { prisma } from '@/lib/db';

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS prompt_versions (
      key       TEXT    NOT NULL,
      version   INTEGER NOT NULL,
      text      TEXT    NOT NULL,
      createdAt TEXT    NOT NULL,
      PRIMARY KEY (key, version)
    )
  `);
  tableReady = true;
}

/** Record the prompt text about to be used; returns its version number.
 *  Inserts a new version only when the text actually changed. Best-effort:
 *  any DB hiccup returns null — versioning must never block generation. */
export async function recordPromptVersion(key: string, text: string): Promise<number | null> {
  try {
    await ensureTable();
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT version, text FROM prompt_versions WHERE key = ? ORDER BY version DESC LIMIT 1`,
      key,
    )) as { version: number; text: string }[];
    const latest = rows[0];
    if (latest && latest.text === text) return Number(latest.version);
    const next = latest ? Number(latest.version) + 1 : 1;
    await prisma.$executeRawUnsafe(
      `INSERT INTO prompt_versions (key, version, text, createdAt) VALUES (?, ?, ?, ?)`,
      key,
      next,
      text,
      new Date().toISOString(),
    );
    return next;
  } catch {
    return null;
  }
}

export interface PromptVersionMeta {
  key: string;
  version: number;
  createdAt: string;
  chars: number;
}

/** All stored versions of every prompt (metadata only), newest first per key. */
export async function listPromptVersions(): Promise<PromptVersionMeta[]> {
  await ensureTable();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT key, version, createdAt, LENGTH(text) AS chars
       FROM prompt_versions ORDER BY key ASC, version DESC`,
  )) as { key: string; version: number; createdAt: string; chars: number }[];
  return rows.map((r) => ({ ...r, version: Number(r.version), chars: Number(r.chars) }));
}

/** Full text of one stored prompt version (latest of the key when version is
 *  omitted). Null when nothing is stored. */
export async function getPromptText(key: string, version?: number): Promise<{ version: number; text: string } | null> {
  await ensureTable();
  const rows = version
    ? ((await prisma.$queryRawUnsafe(
        `SELECT version, text FROM prompt_versions WHERE key = ? AND version = ?`,
        key,
        version,
      )) as { version: number; text: string }[])
    : ((await prisma.$queryRawUnsafe(
        `SELECT version, text FROM prompt_versions WHERE key = ? ORDER BY version DESC LIMIT 1`,
        key,
      )) as { version: number; text: string }[]);
  return rows.length > 0 ? { version: Number(rows[0].version), text: rows[0].text } : null;
}
