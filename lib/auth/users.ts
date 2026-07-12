/**
 * app_users — the persistent registry of every Google account that has signed
 * in, plus the subscription fields the future billing step (Razorpay) will
 * enforce. Same derived-table convention as the other runtime tables: raw
 * CREATE TABLE IF NOT EXISTS via Prisma, mirrored by AppUser in schema.prisma.
 *
 * Policy (user rule 2026-07-12): charan192219@gmail.com (ADMIN_GOOGLE_EMAILS)
 * → role 'admin', plan 'owner'; EVERY other Google account that registers →
 * role 'viewer', plan 'trial' (read-only — all mutating actions 403).
 *
 * ENFORCEMENT today is unchanged and stays in proxy.ts via the
 * ADMIN_GOOGLE_EMAILS policy (rbac.ts) — this table RECORDS who exists so the
 * subscription step can later flip role resolution to DB-driven (active
 * subscriber vs expired trial) without a schema change. Manual edits survive:
 * an upsert never overwrites an existing row's role/plan/status (except the
 * bootstrap rule that the owner email is always admin/owner).
 *
 * Recording happens from the root layout on page render (nodejs), NOT inside
 * the Auth.js callbacks — auth.ts is imported by proxy.ts, which may run on
 * the Edge runtime where better-sqlite3 cannot load. Best-effort + throttled:
 * a DB hiccup must never break page rendering.
 */

import { prisma } from '@/lib/db';
import { ADMIN_GOOGLE_EMAILS } from '@/lib/auth/rbac';

export interface AppUserRow {
  email: string;
  name: string | null;
  image: string | null;
  role: string; // 'admin' | 'viewer'
  plan: string; // 'owner' | 'trial' (later: 'monthly')
  status: string; // 'active' (later: 'blocked' | 'expired')
  subscriptionEndsAt: string | null; // ISO date; null = no paid subscription
  createdAt: string;
  lastSeenAt: string;
}

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS app_users (
      email              TEXT PRIMARY KEY,
      name               TEXT,
      image              TEXT,
      role               TEXT NOT NULL DEFAULT 'viewer',
      plan               TEXT NOT NULL DEFAULT 'trial',
      status             TEXT NOT NULL DEFAULT 'active',
      subscriptionEndsAt TEXT,
      createdAt          TEXT NOT NULL,
      lastSeenAt         TEXT NOT NULL
    )
  `);
  tableReady = true;
}

// Throttle DB touches per email per process: the layout calls recordUserSeen on
// every page render — once per 15 min per user is plenty for "last seen".
const SEEN_THROTTLE_MS = 15 * 60 * 1000;
const seenHost = globalThis as unknown as { __appUsersSeen?: Map<string, number> };

/**
 * Record (or refresh) a signed-in Google account in app_users. Fire-and-forget
 * safe: never throws. New accounts register as viewer/trial; the owner email
 * always lands (and stays) admin/owner.
 */
export async function recordUserSeen(user: { email: string; name?: string | null; image?: string | null }): Promise<void> {
  try {
    const email = user.email.trim().toLowerCase();
    if (!email) return;

    seenHost.__appUsersSeen ??= new Map();
    const last = seenHost.__appUsersSeen.get(email) ?? 0;
    const now = Date.now();
    if (now - last < SEEN_THROTTLE_MS) return;
    seenHost.__appUsersSeen.set(email, now);

    await ensureTable();
    const isOwner = ADMIN_GOOGLE_EMAILS.has(email);
    const nowIso = new Date(now).toISOString();
    // Existing rows keep their role/plan/status (manual upgrades survive);
    // only identity + lastSeenAt refresh.
    await prisma.$executeRawUnsafe(
      `INSERT INTO app_users (email, name, image, role, plan, status, subscriptionEndsAt, createdAt, lastSeenAt)
       VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         name = excluded.name,
         image = excluded.image,
         lastSeenAt = excluded.lastSeenAt`,
      email,
      user.name ?? null,
      user.image ?? null,
      isOwner ? 'admin' : 'viewer',
      isOwner ? 'owner' : 'trial',
      nowIso,
      nowIso,
    );
    if (isOwner) {
      // Bootstrap rule: the owner email is always admin/owner, even if the row
      // was somehow edited — the same guarantee the proxy's email policy gives.
      await prisma.$executeRawUnsafe(
        `UPDATE app_users SET role = 'admin', plan = 'owner' WHERE email = ? AND (role != 'admin' OR plan != 'owner')`,
        email,
      );
    }
  } catch (err) {
    console.warn('[app-users] recordUserSeen failed:', (err as Error).message);
  }
}

/** All registered users, newest first — for a future admin users page. */
export async function listUsers(): Promise<AppUserRow[]> {
  await ensureTable();
  return (await prisma.$queryRawUnsafe(
    `SELECT email, name, image, role, plan, status, subscriptionEndsAt, createdAt, lastSeenAt
       FROM app_users ORDER BY lastSeenAt DESC`,
  )) as AppUserRow[];
}
