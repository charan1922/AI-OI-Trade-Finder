/**
 * Persistent risk latch — the AUTOMATIC counterpart of the operator's kill
 * switch (gap analysis §6.1). When code discovers that the local model of the
 * account can no longer be trusted — an orphan broker position, a quantity
 * mismatch, an unexpected short, prolonged guard blindness — it latches, and
 * EVERY new entry is blocked (risk/gates.ts consumes the reasons) until an
 * operator clears it from /auto-trade. Exits are NEVER blocked by the latch:
 * it only stops risk being added, never risk being removed.
 *
 * Reasons are keyed and deduplicated so a repeating scan cannot spam alerts:
 * activating an already-latched key is a no-op. Transient keys (guard-blind)
 * are auto-cleared by their owner when the condition heals; incident keys
 * (orphan, mismatch, short) persist across restarts until explicitly cleared.
 *
 * Storage: runtime-created single-row table (same convention as the other
 * auto_trade_* tables), mirrored in schema.prisma. Reading FAILS CLOSED — an
 * unreadable latch blocks entries rather than assuming all-clear.
 */

import { prisma } from '@/lib/db';
import { sendCriticalAlert } from '../alerts';

const TAG = '[RiskLatch]';

export interface RiskLatchReason {
  key: string;
  detail: string;
  at: string;
}

export interface RiskLatchState {
  blocked: boolean;
  reasons: RiskLatchReason[];
  activatedAt: string | null;
}

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS auto_trade_risk_latch (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      reasonsJson TEXT NOT NULL,
      activatedAt TEXT,
      updatedAt   TEXT NOT NULL
    )
  `);
  tableReady = true;
}

/** Raw read that THROWS on failure — internal; public reads fail closed. */
async function readReasons(): Promise<{ reasons: RiskLatchReason[]; activatedAt: string | null }> {
  await ensureTable();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT reasonsJson, activatedAt FROM auto_trade_risk_latch WHERE id = 1`
  )) as { reasonsJson: string; activatedAt: string | null }[];
  if (rows.length === 0) return { reasons: [], activatedAt: null };
  let reasons: RiskLatchReason[] = [];
  try {
    const parsed = JSON.parse(rows[0].reasonsJson) as RiskLatchReason[];
    if (Array.isArray(parsed)) reasons = parsed.filter((r) => typeof r?.key === 'string');
  } catch {
    // Corrupt JSON = untrustworthy latch state — surface it as a latch reason
    // instead of silently unlatching.
    reasons = [{ key: 'latch-state-corrupt', detail: 'stored latch reasons failed to parse', at: new Date().toISOString() }];
  }
  return { reasons, activatedAt: rows[0].activatedAt };
}

async function writeReasons(reasons: RiskLatchReason[], activatedAt: string | null): Promise<void> {
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO auto_trade_risk_latch (id, reasonsJson, activatedAt, updatedAt) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET reasonsJson = excluded.reasonsJson,
                                     activatedAt = excluded.activatedAt,
                                     updatedAt   = excluded.updatedAt`,
    JSON.stringify(reasons),
    activatedAt,
    new Date().toISOString()
  );
}

/** Current latch state. FAILS CLOSED: an unreadable latch blocks entries. */
export async function getRiskLatch(): Promise<RiskLatchState> {
  try {
    const { reasons, activatedAt } = await readReasons();
    return { blocked: reasons.length > 0, reasons, activatedAt };
  } catch (err) {
    return {
      blocked: true,
      reasons: [
        {
          key: 'latch-unreadable',
          detail: `risk latch state unreadable (${(err as Error).message}) — failing closed for new entries`,
          at: new Date().toISOString(),
        },
      ],
      activatedAt: null,
    };
  }
}

/**
 * Latch one incident. Deduplicates by key — returns true only when the key is
 * NEW (the caller can use that to avoid double-logging). A newly added key
 * always fires a critical alert; delivery failure never blocks the caller.
 */
export async function activateRiskLatch(key: string, detail: string): Promise<boolean> {
  try {
    const { reasons, activatedAt } = await readReasons();
    if (reasons.some((r) => r.key === key)) return false;
    const now = new Date().toISOString();
    reasons.push({ key, detail, at: now });
    await writeReasons(reasons, activatedAt ?? now);
    console.error(`${TAG} LATCHED [${key}]: ${detail}`);
    sendCriticalAlert(
      `🔒 RISK LATCH [${key}]: ${detail}. New entries are BLOCKED until an operator clears the latch on /auto-trade.`
    );
    return true;
  } catch (err) {
    // The latch write failed — the alert must still go out (the gates will
    // fail closed anyway via the unreadable-latch read path).
    console.error(`${TAG} activation failed for [${key}]: ${(err as Error).message}`);
    sendCriticalAlert(`🔒 RISK LATCH [${key}] (state write FAILED — check DB): ${detail}`);
    return false;
  }
}

/** Remove ONE keyed reason (owners of transient conditions auto-heal, e.g.
 *  guard-blind clears when quotes return). Best-effort. */
export async function clearRiskLatchReason(key: string): Promise<void> {
  try {
    const { reasons, activatedAt } = await readReasons();
    const kept = reasons.filter((r) => r.key !== key);
    if (kept.length === reasons.length) return;
    await writeReasons(kept, kept.length === 0 ? null : activatedAt);
    console.log(`${TAG} cleared [${key}] (${kept.length} reason(s) remain)`);
  } catch (err) {
    console.warn(`${TAG} clear of [${key}] failed: ${(err as Error).message}`);
  }
}

/** Operator action: clear EVERYTHING. Returns what was cleared for the audit. */
export async function clearRiskLatch(): Promise<RiskLatchReason[]> {
  const { reasons } = await readReasons();
  await writeReasons([], null);
  if (reasons.length > 0) console.warn(`${TAG} operator cleared ${reasons.length} reason(s): ${reasons.map((r) => r.key).join(', ')}`);
  return reasons;
}
