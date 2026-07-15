/**
 * GET /api/health/services — at-a-glance health of the three data providers
 * (Dhan, Fyers, NSE) for the top-nav indicator.
 *
 * PASSIVE ONLY: reads in-memory token/poller/cache state — it makes NO external
 * API calls, so the nav can poll it freely (including post-market) without
 * spending any Dhan/Fyers/NSE quota. "ok/warn/down/idle" is derived from whether
 * credentials exist, the token is valid, the poller's last real cycle succeeded,
 * and how fresh the NSE cache is.
 */
import { NextResponse } from 'next/server';
import { getDhanTokenStatus, hasDhanAuth } from '@/lib/dhan/auth';
import { isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { getFyersPollerStatus } from '@/lib/fyers/poller';
import { getPulseCacheStatus } from '@/lib/nse/pulse-cache';
import { adminOnly } from '@/lib/auth/server';
import { getGuardLoopStatus } from '@/lib/auto-trade/guard-loop';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Status = 'ok' | 'warn' | 'down' | 'idle';

const NSE_FRESH_MS = 5 * 60 * 1000; // a successful pulse fetch within 5 min = healthy

export function GET(req: Request): Response {
  const denied = adminOnly(req);
  if (denied) return denied;
  const marketOpen = isMarketHours();
  const now = Date.now();
  // The poller runs the pre-open token warm-up; its lastWarmup surfaces a failed
  // pre-open Dhan mint as a warn dot BEFORE the open (needed by both providers).
  const p = getFyersPollerStatus();
  const warm = p.lastWarmup;
  const warmDhanFailedToday = warm != null && warm.date === todayIST() && warm.dhan.startsWith('error');

  // ── Dhan: config + token validity (Dhan is only called during market hours) ──
  const dhanToken = getDhanTokenStatus();
  const dhanValid = dhanToken.cached && dhanToken.expiresAt != null && dhanToken.expiresAt > now;
  let dhan: { status: Status; detail: string; tokenExpiresAt: number | null };
  if (!hasDhanAuth()) {
    dhan = {
      status: 'down',
      detail: 'Not configured (DHAN_CLIENT_ID + PIN + TOTP_SECRET)',
      tokenExpiresAt: null,
    };
  } else if (dhanValid) {
    dhan = {
      status: 'ok',
      detail: 'Token valid',
      tokenExpiresAt: dhanToken.expiresAt,
    };
  } else if (warmDhanFailedToday) {
    dhan = {
      status: 'warn',
      detail: `Pre-open warm-up failed: ${warm!.dhan.replace(/^error:\s*/, '').slice(0, 80)}`,
      tokenExpiresAt: dhanToken.expiresAt,
    };
  } else if (!marketOpen) {
    dhan = {
      status: 'idle',
      detail: 'Idle — token warms pre-open (~08:40 IST) or on the next market-hours call',
      tokenExpiresAt: dhanToken.expiresAt,
    };
  } else {
    dhan = {
      status: 'warn',
      detail: 'Configured, token not fetched yet (regenerates on next call)',
      tokenExpiresAt: dhanToken.expiresAt,
    };
  }

  // ── Fyers: the poller actually calls Fyers every cycle, so its last cycle is the real signal ──
  const lc = p.lastCycle;
  let fyers: {
    status: Status;
    detail: string;
    tokenExpiresAt: number | null;
    lastCycle: typeof lc;
  };
  if (!p.credentialsConfigured) {
    fyers = {
      status: 'down',
      detail: 'Not configured (FYERS_* env vars)',
      tokenExpiresAt: p.token.expiresAt,
      lastCycle: lc,
    };
  } else if (!p.started) {
    fyers = {
      status: 'down',
      detail: 'Poller not started',
      tokenExpiresAt: p.token.expiresAt,
      lastCycle: lc,
    };
  } else if (lc && lc.skipped === 'no-credentials') {
    fyers = {
      status: 'down',
      detail: 'Credentials rejected on last cycle',
      tokenExpiresAt: p.token.expiresAt,
      lastCycle: lc,
    };
  } else if (!marketOpen) {
    fyers = {
      status: 'idle',
      detail: 'Market closed — poller sleeping between 5-min ticks',
      tokenExpiresAt: p.token.expiresAt,
      lastCycle: lc,
    };
  } else if (lc && lc.symbolsProcessed > 0 && lc.errors.length === 0) {
    fyers = {
      status: 'ok',
      detail: `Last cycle: ${lc.symbolsProcessed}/${lc.universeSize} symbols, ${lc.futBars + lc.eqBars} bars`,
      tokenExpiresAt: p.token.expiresAt,
      lastCycle: lc,
    };
  } else if (lc && lc.symbolsProcessed === 0 && lc.errors.length > 0) {
    fyers = {
      status: 'down',
      detail: `Last cycle failed: ${lc.errors[0]?.message ?? 'unknown'}`,
      tokenExpiresAt: p.token.expiresAt,
      lastCycle: lc,
    };
  } else if (lc && lc.errors.length > 0) {
    fyers = {
      status: 'warn',
      detail: `Last cycle had ${lc.errors.length} error(s), ${lc.symbolsProcessed} ok`,
      tokenExpiresAt: p.token.expiresAt,
      lastCycle: lc,
    };
  } else {
    fyers = {
      status: 'warn',
      detail: 'Waiting for first cycle',
      tokenExpiresAt: p.token.expiresAt,
      lastCycle: lc,
    };
  }

  // ── NSE: freshness of the shared pulse cache (populated by /live list + /nse pages) ──
  const nseCache = getPulseCacheStatus();
  const nseAge = nseCache.lastSuccessAt > 0 ? now - nseCache.lastSuccessAt : null;
  let nse: { status: Status; detail: string; lastSuccessAt: number };
  if (nseCache.feedsCached === 0 && nseCache.lastSuccessAt === 0) {
    nse = {
      status: 'idle',
      detail: 'No NSE feed requested yet this session',
      lastSuccessAt: 0,
    };
  } else if (nseAge != null && nseAge < NSE_FRESH_MS) {
    nse = {
      status: 'ok',
      detail: 'Feeds fetching normally',
      lastSuccessAt: nseCache.lastSuccessAt,
    };
  } else if (nseCache.lastError) {
    nse = {
      status: 'warn',
      detail: `Last fetch failed: ${nseCache.lastError.slice(0, 80)}`,
      lastSuccessAt: nseCache.lastSuccessAt,
    };
  } else {
    nse = {
      status: 'idle',
      detail: 'No recent NSE fetch (idle)',
      lastSuccessAt: nseCache.lastSuccessAt,
    };
  }

  return NextResponse.json({
    ok: true,
    ts: new Date(now).toISOString(),
    marketOpen,
    services: { dhan, fyers, nse },
    operations: {
      guard: getGuardLoopStatus(),
      capture: {
        running: p.captureRunning,
        skips: p.captureSkips,
        last: p.lastCapture,
      },
    },
  });
}
