import { fetchDetailedOptionChainShadow, todayIST } from '@/lib/dhan/market-feed';
import { prisma } from '@/lib/db';
import { deriveOptionActivityEvidence } from './option-evidence';
import { loadSameTimeOptionBaseline, recordOptionEvidence } from './store';
import type { OptionActivityEvidence } from './types';

const REFRESH_MS = 5 * 60_000;
const REQUEST_SPACING_MS = 4_000;
const MAX_TRACKED = 12;
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

const host = globalThis as unknown as { __rfactorV2OptionShadow?: ShadowState };
host.__rfactorV2OptionShadow ??= {
  candidates: new Map(),
  cache: new Map(),
  attemptedAt: new Map(),
  running: false,
  lastRequestAt: 0,
};
const state = host.__rfactorV2OptionShadow;
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
        console.warn(`[RFactorV2] option shadow failed for ${candidate.symbol}: ${(error as Error).message}`);
      }
    }
  } finally {
    state.running = false;
  }
}
