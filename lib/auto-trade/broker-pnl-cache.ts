/**
 * Shared, TTL-cached read of the VENUE's own session P&L.
 *
 * Why a cache: the operator console polls, and several windows may be open at
 * once. Without coalescing, every poll from every viewer would hit the broker's
 * position endpoint. Same shape (and same reasoning) as
 * app/api/live/_lib/quote-response-cache.ts — N viewers cost what 1 costs.
 *
 * Why it exists at all: `getBrokerPnl()` was reachable by the AI through
 * AccountState but rendered nowhere, so a books-vs-broker disagreement — the
 * exact thing it was built to surface — was invisible to the person who can act
 * on it (review, 2026-07-28).
 *
 * READ-ONLY. Nothing here feeds a gate. The venue's figure covers the whole
 * ACCOUNT, including orders placed by hand in the broker's own app, so it can
 * legitimately disagree with our book — see BrokerPnlRead's scope warning.
 */
import { getExecutionAdapter } from './brokers';
import type { BrokerPnlRead } from './brokers/adapter';
import { getAutoTradeSettings } from './settings';

/** Long enough that a polling console coalesces, short enough to stay current. */
const TTL_MS = 15_000;

/**
 * Short TTL for an UNAVAILABLE read.
 *
 * Errors must never pin the console to a stale "cannot read" — but caching
 * them for nothing is worse: the console polls every 5s, and a broker that
 * cannot be read would then fire one /positions call every 5s, contending for
 * the same 600ms adapter serial() slot the position guard needs to PLACE
 * EXITS. This keeps the read fresh while capping that contention.
 */
const ERROR_TTL_MS = 3_000;

export interface BrokerPnlSnapshot {
  read: BrokerPnlRead;
  /** ISO time the venue was actually asked (not the time it was served). */
  checkedAt: string;
}

interface CacheState {
  snapshot: BrokerPnlSnapshot | null;
  expiresAt: number;
  inFlight: Promise<BrokerPnlSnapshot> | null;
}

const host = globalThis as unknown as { __autoTradeBrokerPnlCache?: CacheState };
host.__autoTradeBrokerPnlCache ??= { snapshot: null, expiresAt: 0, inFlight: null };
const state = host.__autoTradeBrokerPnlCache;

/**
 * The venue's P&L, cached and coalesced across concurrent callers.
 *
 * A verified read holds for TTL_MS; an `unavailable` one only for
 * ERROR_TTL_MS, so a transient broker failure can never pin the console to a
 * stale "cannot read", and is never mistaken for a real ₹0 — while a broker
 * that is down for the whole session still cannot flood the adapter's serial
 * gate on every 5-second console poll.
 */
export async function getCachedBrokerPnl(): Promise<BrokerPnlSnapshot> {
  const settings = await getAutoTradeSettings();
  if (settings.mode !== 'approval' && settings.mode !== 'live') {
    return { read: { kind: 'unavailable', reason: 'no live venue in this mode' }, checkedAt: new Date().toISOString() };
  }
  const now = Date.now();
  if (state.snapshot != null && now < state.expiresAt) return state.snapshot;
  if (state.inFlight != null) return state.inFlight;

  const adapter = getExecutionAdapter(settings, settings.mode);
  if (adapter.getBrokerPnl == null) {
    return {
      read: { kind: 'unavailable', reason: `${adapter.id} adapter reports no P&L` },
      checkedAt: new Date().toISOString(),
    };
  }

  const work = (async (): Promise<BrokerPnlSnapshot> => {
    const read = await adapter.getBrokerPnl!();
    const snapshot: BrokerPnlSnapshot = { read, checkedAt: new Date().toISOString() };
    state.snapshot = snapshot;
    state.expiresAt = Date.now() + (read.kind === 'verified' ? TTL_MS : ERROR_TTL_MS);
    return snapshot;
  })();

  state.inFlight = work;
  try {
    return await work;
  } finally {
    state.inFlight = null;
  }
}
