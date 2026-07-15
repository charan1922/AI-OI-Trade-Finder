import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';

const owner = `${process.pid}-${randomUUID()}`;
let tableReady = false;

async function ensureLeaseTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS runtime_leases (
      name       TEXT PRIMARY KEY,
      owner      TEXT NOT NULL,
      expiresAt  INTEGER NOT NULL,
      updatedAt  TEXT NOT NULL
    )
  `);
  tableReady = true;
}

/**
 * Acquire or renew a process lease atomically. It protects singleton loops
 * during rolling deploy overlap; a dead process loses ownership after ttlMs.
 * Database failures fail closed so a second process cannot assume leadership.
 */
export async function tryAcquireRuntimeLease(name: string, ttlMs: number): Promise<boolean> {
  try {
    await ensureLeaseTable();
    const now = Date.now();
    const rows = (await prisma.$queryRawUnsafe(
      `INSERT INTO runtime_leases (name, owner, expiresAt, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         owner = excluded.owner,
         expiresAt = excluded.expiresAt,
         updatedAt = excluded.updatedAt
       WHERE runtime_leases.expiresAt < ? OR runtime_leases.owner = ?
       RETURNING owner`,
      name,
      owner,
      now + ttlMs,
      new Date(now).toISOString(),
      now,
      owner
    )) as { owner: string }[];
    return rows[0]?.owner === owner;
  } catch (err) {
    console.warn(`[RuntimeLease] ${name} acquisition failed: ${(err as Error).message}`);
    return false;
  }
}

/** Release only this process's lease. A stale process can never release a
 * lease that a replacement process has already acquired. */
export async function releaseRuntimeLease(name: string): Promise<void> {
  try {
    await ensureLeaseTable();
    await prisma.$executeRawUnsafe(`DELETE FROM runtime_leases WHERE name = ? AND owner = ?`, name, owner);
  } catch (err) {
    console.warn(`[RuntimeLease] ${name} release failed: ${(err as Error).message}`);
  }
}
