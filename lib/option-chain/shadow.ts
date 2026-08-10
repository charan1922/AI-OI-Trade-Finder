import { fetchDetailedOptionChainShadow, todayIST } from '@/lib/dhan/market-feed';
import { prisma } from '@/lib/db';
import { deriveOptionActivityEvidence } from './evidence';
import { loadSameTimeOptionBaseline, recordOptionEvidence } from './store';
import type { OptionActivityEvidence } from './types';

const REFRESH_MS = 5 * 60_000;
const REQUEST_SPACING_MS = 4_000;
/**
 * Raised 12 → 20 (2026-08-11) to answer a question the evidence could not.
 *
 * Phase 1 (scripts/measure-option-evidence.ts) paired 13 sessions of recorded
 * chain reads against graded suggestions and came back inconclusive — but the
 * reason was sample size, not a flat result: the chain CONTRADICTED the scanner
 * only 6 times in 91 pairs, and six observations cannot settle anything. The
 * bottleneck is coverage, because only the top MAX_TRACKED names by priority
 * ever get a snapshot at all, and the chain read cannot be backfilled (Dhan's
 * /v2/optionchain is live-only — there is no historical option-chain endpoint),
 * so every extra name is evidence that otherwise never exists.
 *
 * Rate-limit headroom, so this stays honest: Dhan documents "one unique request
 * every 3 seconds" for the option chain. 20 names at REQUEST_SPACING_MS (4s)
 * cycle in ~80s, comfortably inside REFRESH_MS, and average one call per 15s —
 * five times slower than the documented ceiling. Every call still goes out on
 * the low-priority lane of lib/dhan/quote-gate.ts (which enforces the 3s
 * option-chain sub-limit centrally, gives up after LOW_PRIORITY_GIVE_UP_MS and
 * caps each request at SHADOW_REQUEST_TIMEOUT_MS), so a busy money path starves
 * this worker rather than the other way round.
 */
const MAX_TRACKED = 20;
const CACHE_FRESH_MS = 10 * 60_000;

interface Candidate {
  symbol: string;
  priority: number;
  queuedAt: number;
}
interface ShadowState {
  candidates: Map<string, Candidate>;
  cache: Map<string, OptionActivityEvidence>;
  attemptedAt: Map<string, number>;
  running: boolean;
  lastRequestAt: number;
}

const host = globalThis as unknown as { __optionChainShadow?: ShadowState };
host.__optionChainShadow ??= {
  candidates: new Map(),
  cache: new Map(),
  attemptedAt: new Map(),
  running: false,
  lastRequestAt: 0,
};
const state = host.__optionChainShadow;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function getCachedOptionEvidence(symbols: string[], nowMs = Date.now()): Map<string, OptionActivityEvidence> {
  const output = new Map<string, OptionActivityEvidence>();
  for (const symbol of symbols) {
    const value = state.cache.get(symbol);
    if (value != null && nowMs - Date.parse(value.capturedAt) <= CACHE_FRESH_MS) output.set(symbol, value);
  }
  return output;
}

/** Enqueue only the strongest shadow names. This never awaits network I/O. */
export function scheduleOptionEvidenceShadow(candidates: { symbol: string; priority: number }[]): void {
  const now = Date.now();
  for (const candidate of candidates.slice(0, MAX_TRACKED)) {
    const previous = state.candidates.get(candidate.symbol);
    state.candidates.set(candidate.symbol, {
      symbol: candidate.symbol,
      priority: Math.max(candidate.priority, previous?.priority ?? 0),
      queuedAt: previous?.queuedAt ?? now,
    });
  }
  const keep = [...state.candidates.values()]
    .sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt)
    .slice(0, MAX_TRACKED);
  state.candidates = new Map(keep.map((candidate) => [candidate.symbol, candidate]));
  if (!state.running) void runWorker();
}

async function resolveContract(
  symbol: string,
): Promise<{ securityId: number; expiry: string; lotSize: number } | null> {
  const [equity, option] = await Promise.all([
    prisma.masterContract.findFirst({
      where: { symbol, segment: 'NSE_EQ' },
      select: { securityId: true },
    }),
    // `gte: now` keeps the current contract for the whole of its own expiry
    // session: master_contracts stores expiries at 14:30Z (20:00 IST), i.e.
    // AFTER the close, so an expiry-day quote at 10:00 IST still matches it.
    // Verified against the loaded master; if that convention ever changes, this
    // silently rolls to the next month mid-session.
    prisma.masterContract.findFirst({
      where: { underlying: symbol, segment: 'NSE_FNO', instrument: 'OPTSTK', expiryDate: { gte: new Date() } },
      orderBy: { expiryDate: 'asc' },
      select: { expiryDate: true, lotSize: true },
    }),
  ]);
  if (equity == null || option?.expiryDate == null) return null;
  return {
    securityId: Number(equity.securityId),
    expiry: option.expiryDate.toISOString().slice(0, 10),
    // Only scales the recorded gamma evidence; never a position size here.
    lotSize: Number(option.lotSize) > 0 ? Number(option.lotSize) : 1,
  };
}

async function runWorker(): Promise<void> {
  state.running = true;
  try {
    while (state.candidates.size > 0) {
      const now = Date.now();
      const candidate = [...state.candidates.values()]
        .filter((item) => now - (state.attemptedAt.get(item.symbol) ?? 0) >= REFRESH_MS)
        .sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt)[0];
      if (candidate == null) break;
      state.candidates.delete(candidate.symbol);
      state.attemptedAt.set(candidate.symbol, now);
      const spacing = REQUEST_SPACING_MS - (Date.now() - state.lastRequestAt);
      if (spacing > 0) await sleep(spacing);
      const contract = await resolveContract(candidate.symbol);
      if (contract == null) continue;
      state.lastRequestAt = Date.now();
      try {
        const chain = await fetchDetailedOptionChainShadow(contract.securityId, contract.expiry);
        if (chain == null) continue;
        // Prefer this underlying's own same-clock premium history over the
        // linear prior-session estimate. Null until a few sessions of evidence
        // exist, in which case the fallback is used AND labelled as such.
        const baseline = await loadSameTimeOptionBaseline(
          candidate.symbol,
          contract.expiry,
          todayIST(),
          Date.now(),
        ).catch(() => null);
        const evidence = deriveOptionActivityEvidence(
          chain,
          contract.expiry,
          baseline,
          contract.lotSize,
        );
        state.cache.set(candidate.symbol, evidence);
        await recordOptionEvidence(candidate.symbol, evidence);
      } catch (error) {
        console.warn(`[OptionChain] option shadow failed for ${candidate.symbol}: ${(error as Error).message}`);
      }
    }
  } finally {
    state.running = false;
  }
}
