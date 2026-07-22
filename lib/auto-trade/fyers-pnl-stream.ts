/**
 * FYERS WebSocket monitor for filled Auto Trade option positions.
 *
 * The market-data subscription is read-only and tracks only exact filled
 * symbols. A valid full-quantity bid at or above the target may call the same
 * deterministic, idempotent exit path used by the REST guard. The 5-second
 * REST guard remains the fallback when the socket is disconnected or stale.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fyersDataSocket, type FyersDataSocketInstance } from 'fyers-api-v3';
import { fyersAppId, getFyersAccessToken } from '@/lib/fyers/auth';
import { toFyersOptionSymbol } from './brokers/fyers-adapter';
import { exitTrade } from './execution';
import { insertQuoteSnapshots } from './store';
import type { AutoTrade } from './types';

const TAG = '[FyersPnlStream]';
const STALE_AFTER_MS = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const CHANNEL = 1;

export interface ParsedFyersPnlTick {
  symbol: string;
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
}

export interface LiveTradePnl {
  tradeId: number;
  symbol: string;
  optionSymbol: string;
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  executablePnlRupees: number | null;
  ltpPnlRupees: number | null;
  targetPnlRupees: number;
  updatedAt: string | null;
  fresh: boolean;
}

export interface FyersPnlStreamStatus {
  connected: boolean;
  connecting: boolean;
  trackedTrades: number;
  subscribedSymbols: number;
  lastMessageAt: string | null;
  lastError: string | null;
  reconnectAttempts: number;
  nextReconnectAt: string | null;
  executablePnlRupees: number | null;
  ltpPnlRupees: number | null;
  executablePricedTrades: number;
  trades: LiveTradePnl[];
}

interface TrackedTrade {
  trade: AutoTrade;
  optionSymbol: string;
}

interface LatestTick {
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  receivedAt: number;
  ltpReceivedAt: number | null;
  depthReceivedAt: number | null;
}

interface StreamState {
  socket: FyersDataSocketInstance | null;
  socketTokenFingerprint: string | null;
  connecting: boolean;
  connected: boolean;
  tracked: Map<string, TrackedTrade>;
  subscribed: Set<string>;
  latest: Map<string, LatestTick>;
  lastMessageAt: string | null;
  /** Numeric mirror of lastMessageAt, and when the socket last came up. The
   *  silence watchdog compares against whichever is later. */
  lastMessageAtMs: number | null;
  connectedAtMs: number | null;
  lastError: string | null;
  syncPromise: Promise<void> | null;
  exitingTradeIds: Set<number>;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connectWatchdog: ReturnType<typeof setTimeout> | null;
  nextReconnectAt: string | null;
}

const host = globalThis as unknown as { __fyersPnlStream?: StreamState };

function state(): StreamState {
  host.__fyersPnlStream ??= {
    socket: null,
    socketTokenFingerprint: null,
    connecting: false,
    connected: false,
    tracked: new Map(),
    subscribed: new Set(),
    latest: new Map(),
    lastMessageAt: null,
    lastMessageAtMs: null,
    connectedAtMs: null,
    lastError: null,
    syncPromise: null,
    exitingTradeIds: new Set(),
    reconnectAttempts: 0,
    reconnectTimer: null,
    connectWatchdog: null,
    nextReconnectAt: null,
  };
  // Survive a dev hot reload from an older state shape.
  host.__fyersPnlStream.reconnectAttempts ??= 0;
  host.__fyersPnlStream.reconnectTimer ??= null;
  host.__fyersPnlStream.connectWatchdog ??= null;
  host.__fyersPnlStream.nextReconnectAt ??= null;
  host.__fyersPnlStream.socketTokenFingerprint ??= null;
  return host.__fyersPnlStream;
}

/** Deterministic bounded backoff used by the application-owned reconnect
 * supervisor. Ordinary disconnects reuse the installed SDK instance; only an
 * observed access-token change replaces it. */
export function fyersStreamReconnectDelayMs(attempts: number): number {
  const safeAttempts = Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0;
  return Math.min(RECONNECT_MAX_DELAY_MS, 1_000 * 2 ** Math.min(safeAttempts, 5));
}

/** The access token is never exposed in state or status responses. A digest is
 * enough to detect the morning token rotation in a long-running process. */
function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function fyersStreamNeedsTokenRotation(currentFingerprint: string | null, nextFingerprint: string): boolean {
  return currentFingerprint !== nextFingerprint;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function positiveSize(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/** Conservative fast-path target check: the best bid must meet the target and
 * have enough displayed quantity to cover the entire position. Missing size
 * never authorizes a streamed exit; the 5-second REST guard remains fallback. */
export function isStreamTargetExecutable(args: {
  bid: number | null;
  bidSize: number | null;
  targetPremium: number;
  qtyUnits: number;
  bidAgeMs: number;
}): boolean {
  return (
    args.bid != null &&
    args.bidSize != null &&
    args.qtyUnits > 0 &&
    args.bidAgeMs >= 0 &&
    args.bidAgeMs <= 2_000 &&
    args.bid >= args.targetPremium &&
    args.bidSize >= args.qtyUnits
  );
}

/** Defensive parser for both normal symbol updates and separate depth ticks. */
export function parseFyersPnlTick(message: unknown): ParsedFyersPnlTick | null {
  if (message == null || typeof message !== 'object' || Array.isArray(message)) return null;
  const row = message as Record<string, unknown>;
  const symbol = String(row.symbol ?? row.scrip ?? row.n ?? '').trim();
  if (!symbol) return null;
  const ltp = finite(row.ltp ?? row.last_price ?? row.lp);
  const bid = finite(row.bid_price1 ?? row.bid_price ?? row.bp);
  const ask = finite(row.ask_price1 ?? row.ask_price ?? row.sp);
  const bidSize = positiveSize(row.bid_size1 ?? row.bid_size ?? row.bq);
  if (ltp == null && bid == null && ask == null) return null;
  // A crossed book is malformed/stale. Keep LTP if present, but never expose
  // the bad bid as executable P&L.
  if (bid != null && ask != null && ask < bid) return { symbol, ltp, bid: null, ask: null, bidSize: null };
  return { symbol, ltp, bid, ask, bidSize };
}

async function exitOnStreamedTarget(tracked: TrackedTrade, tick: LatestTick): Promise<void> {
  const s = state();
  const { trade } = tracked;
  const qtyUnits = trade.lotSize * trade.lots;
  if (
    s.exitingTradeIds.has(trade.id) ||
    !isStreamTargetExecutable({
      bid: tick.bid,
      bidSize: tick.bidSize,
      targetPremium: trade.targetPremium,
      qtyUnits,
      bidAgeMs: tick.depthReceivedAt == null ? Number.POSITIVE_INFINITY : Date.now() - tick.depthReceivedAt,
    })
  )
    return;
  s.exitingTradeIds.add(trade.id);
  const bid = tick.bid!;
  const bidSize = tick.bidSize!;
  const reason = `streamed premium target hit (FYERS bid Rs ${bid} x ${bidSize} units >= target Rs ${trade.targetPremium} for ${qtyUnits} units)`;
  try {
    const outcome = await exitTrade(trade, reason);
    console.log(`${TAG} ${trade.symbol}: ${reason} -> ${outcome.message}`);
    // Preserve the exact fast-path evidence after order submission/fill work;
    // audit storage can never delay the money-touching exit claim.
    if (tick.ltp != null) {
      const spreadPct = tick.ask != null ? ((tick.ask - bid) / ((tick.ask + bid) / 2)) * 100 : null;
      try {
        await insertQuoteSnapshots([
          {
            tradeId: trade.id,
            date: trade.date,
            capturedAt: new Date(tick.receivedAt).toISOString(),
            source: 'fyers_stream',
            optSecurityId: trade.optSecurityId,
            // The size that made this target executable — the exact evidence a
            // later audit needs to tell a real fill from a lucky print.
            bidQty: bidSize,
            askQty: null,
            ltp: tick.ltp,
            priceSource: 'ltp',
            bid,
            ask: tick.ask,
            spreadPct: spreadPct == null ? null : Math.round(spreadPct * 100) / 100,
            slPremium: trade.slPremium,
            targetPremium: trade.targetPremium,
          },
        ]);
      } catch (err) {
        console.warn(`${TAG} target evidence insert failed: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    s.lastError = `stream target exit failed: ${(err as Error).message}`;
    console.error(`${TAG} ${s.lastError}`);
  } finally {
    // A rejected exit can be retried by the next REST guard tick. A live
    // submission remains protected by the DB's atomic active-SELL claim.
    setTimeout(() => state().exitingTradeIds.delete(trade.id), 5_000);
  }
}

function consumeMessage(message: unknown): void {
  if (Array.isArray(message)) {
    for (const item of message) consumeMessage(item);
    return;
  }
  const tick = parseFyersPnlTick(message);
  if (!tick) return;
  const s = state();
  if (!s.tracked.has(tick.symbol)) return;
  const previous = s.latest.get(tick.symbol);
  const now = Date.now();
  const hasLtpUpdate = tick.ltp != null;
  const hasDepthUpdate = tick.bid != null && tick.bidSize != null;
  s.latest.set(tick.symbol, {
    ltp: tick.ltp ?? previous?.ltp ?? null,
    bid: tick.bid ?? previous?.bid ?? null,
    ask: tick.ask ?? previous?.ask ?? null,
    bidSize: tick.bidSize ?? previous?.bidSize ?? null,
    receivedAt: now,
    ltpReceivedAt: hasLtpUpdate ? now : (previous?.ltpReceivedAt ?? null),
    depthReceivedAt: hasDepthUpdate ? now : (previous?.depthReceivedAt ?? null),
  });
  s.lastMessageAt = new Date(now).toISOString();
  s.lastMessageAtMs = now;
  const tracked = s.tracked.get(tick.symbol);
  const latest = s.latest.get(tick.symbol);
  // Never let an LTP-only tick make an older depth quote appear current.
  if (tracked && latest && hasDepthUpdate) void exitOnStreamedTarget(tracked, latest);
}

function applySubscriptions(): void {
  const s = state();
  const socket = s.socket;
  if (!socket || !s.connected) return;
  const wanted = new Set(s.tracked.keys());
  const removed = [...s.subscribed].filter((symbol) => !wanted.has(symbol));
  const added = [...wanted].filter((symbol) => !s.subscribed.has(symbol));
  try {
    if (removed.length > 0) {
      socket.unsubscribe(removed, false, CHANNEL);
      socket.unsubscribe(removed, true, CHANNEL);
      for (const symbol of removed) s.subscribed.delete(symbol);
    }
    if (added.length > 0) {
      // FYERS emits the normal tick and the depth ladder separately. Subscribe
      // to both so LTP and executable best bid/ask are available.
      socket.subscribe(added, false, CHANNEL);
      socket.subscribe(added, true, CHANNEL);
      socket.mode(socket.FullMode, CHANNEL);
      for (const symbol of added) s.subscribed.add(symbol);
    }
  } catch (err) {
    s.lastError = `subscription update failed: ${(err as Error).message}`;
    console.warn(`${TAG} ${s.lastError}`);
  }
}

function clearConnectWatchdog(s: StreamState): void {
  if (s.connectWatchdog) clearTimeout(s.connectWatchdog);
  s.connectWatchdog = null;
}

function clearReconnectTimer(s: StreamState): void {
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  s.reconnectTimer = null;
  s.nextReconnectAt = null;
}

/** Retire the old SDK singleton before constructing its replacement. Event
 * handlers also verify socket identity, so a late close/message from the old
 * transport cannot mutate or feed the new stream. */
function retireSocketForTokenRotation(s: StreamState): void {
  const oldSocket = s.socket;
  s.socket = null;
  s.socketTokenFingerprint = null;
  s.connected = false;
  s.connecting = false;
  s.subscribed.clear();
  s.latest.clear();
  clearConnectWatchdog(s);
  clearReconnectTimer(s);
  s.reconnectAttempts = 0;
  if (!oldSocket) return;
  try {
    oldSocket.close();
  } catch (err) {
    console.warn(`${TAG} old socket close during token rotation failed: ${(err as Error).message}`);
  }
}

function connectExistingSocket(reason: string): void {
  const s = state();
  if (!s.socket || s.connected || s.connecting || s.tracked.size === 0) return;
  const socket = s.socket;
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  s.reconnectTimer = null;
  s.nextReconnectAt = null;
  s.connecting = true;
  s.reconnectAttempts += 1;
  clearConnectWatchdog(s);
  s.connectWatchdog = setTimeout(() => {
    const current = state();
    if (current.socket !== socket) return;
    current.connectWatchdog = null;
    if (current.connected) return;
    current.connecting = false;
    current.lastError = `connect timeout after ${CONNECT_TIMEOUT_MS / 1_000}s (${reason})`;
    scheduleReconnect('connect timeout');
  }, CONNECT_TIMEOUT_MS);
  try {
    socket.connect();
  } catch (err) {
    s.connecting = false;
    clearConnectWatchdog(s);
    s.lastError = `connect failed (${reason}): ${(err as Error).message}`;
    console.warn(`${TAG} ${s.lastError}`);
    scheduleReconnect('connect exception');
  }
}

function scheduleReconnect(reason: string): void {
  const s = state();
  if (!s.socket || s.connected || s.connecting || s.tracked.size === 0 || s.reconnectTimer) return;
  const socket = s.socket;
  const delayMs = fyersStreamReconnectDelayMs(s.reconnectAttempts);
  s.nextReconnectAt = new Date(Date.now() + delayMs).toISOString();
  s.reconnectTimer = setTimeout(() => {
    const current = state();
    if (current.socket !== socket) return;
    current.reconnectTimer = null;
    current.nextReconnectAt = null;
    connectExistingSocket(reason);
  }, delayMs);
  console.warn(`${TAG} reconnect scheduled in ${delayMs}ms (${reason}); 5-second REST guard remains active`);
}

/**
 * A socket can go half-open: the transport still reports "connected" but no
 * messages ever arrive again. The reconnect supervisor covers connect timeouts,
 * errors, explicit closes and token rotation — none of which fire here, so
 * without this the fast path stays silently dead for the rest of the session.
 *
 * The threshold is deliberately generous. A deep out-of-the-money contract can
 * legitimately go a long time without a price change, so this triggers only on
 * total silence across EVERY subscribed symbol, and it is measured from the
 * later of the last message and the moment the socket came up (a socket that
 * just connected has simply not had time to say anything yet).
 *
 * A false positive costs one reconnect; the 5-second REST guard protects
 * throughout either way.
 */
export const STREAM_SILENCE_LIMIT_MS = 120_000;

export function fyersStreamIsSilent(args: {
  connected: boolean;
  trackedSymbols: number;
  lastActivityMs: number | null;
  nowMs: number;
}): boolean {
  if (!args.connected || args.trackedSymbols === 0) return false;
  if (args.lastActivityMs == null) return false;
  return args.nowMs - args.lastActivityMs > STREAM_SILENCE_LIMIT_MS;
}

async function ensureSocket(): Promise<void> {
  const s = state();
  if (s.tracked.size === 0) return;

  // Silence watchdog runs BEFORE the connected/connecting early-return below,
  // which is exactly the branch that would otherwise keep a dead socket alive.
  if (
    fyersStreamIsSilent({
      connected: s.connected,
      trackedSymbols: s.subscribed.size,
      lastActivityMs: Math.max(s.lastMessageAtMs ?? 0, s.connectedAtMs ?? 0) || null,
      nowMs: Date.now(),
    })
  ) {
    const silentForMs = Date.now() - Math.max(s.lastMessageAtMs ?? 0, s.connectedAtMs ?? 0);
    console.warn(
      `${TAG} no market data for ${Math.round(silentForMs / 1000)}s on a connected socket — recycling it`
    );
    s.lastError = `stream silent for ${Math.round(silentForMs / 1000)}s; socket recycled`;
    retireSocketForTokenRotation(s);
  }

  let token: string;
  try {
    token = await getFyersAccessToken();
  } catch (err) {
    s.lastError = `token refresh check failed: ${(err as Error).message}`;
    console.warn(`${TAG} ${s.lastError}; 5-second REST guard remains active`);
    return;
  }

  // The tracked set can change while the token getter is refreshing.
  if (s.tracked.size === 0) return;
  const fingerprint = tokenFingerprint(token);
  if (s.socket && fyersStreamNeedsTokenRotation(s.socketTokenFingerprint, fingerprint)) {
    console.log(`${TAG} FYERS access token changed; replacing the market-data socket`);
    retireSocketForTokenRotation(s);
  }

  if (s.connected || s.connecting) return;
  if (s.socket) {
    scheduleReconnect('sync found disconnected socket');
    return;
  }
  s.connecting = true;
  try {
    // The SDK has no token setter. Its exported class constructor replaces its
    // own singleton, so close the old transport first and keep exactly one live
    // instance while still allowing a fresh morning token to take effect.
    const socket = new fyersDataSocket(`${fyersAppId()}:${token}`, path.join(process.cwd(), 'data'), false);
    s.socket = socket;
    s.socketTokenFingerprint = fingerprint;
    s.connecting = false;
    socket.on('connect', () => {
      const current = state();
      if (current.socket !== socket) return;
      clearConnectWatchdog(current);
      clearReconnectTimer(current);
      current.reconnectAttempts = 0;
      current.connecting = false;
      current.connected = true;
      // Grace period for the silence watchdog: a socket that just came up has
      // not had time to send anything yet.
      current.connectedAtMs = Date.now();
      current.lastError = null;
      console.log(`${TAG} connected`);
      applySubscriptions();
    });
    socket.on('message', (message) => {
      if (state().socket !== socket) return;
      consumeMessage(message);
    });
    socket.on('error', (message) => {
      const current = state();
      if (current.socket !== socket) return;
      current.lastError = `socket error: ${String(message ?? 'unknown')}`;
      console.warn(`${TAG} ${current.lastError}`);
      if (!current.connected) {
        current.connecting = false;
        clearConnectWatchdog(current);
        scheduleReconnect('socket error');
      }
    });
    socket.on('close', () => {
      const current = state();
      if (current.socket !== socket) return;
      clearConnectWatchdog(current);
      current.connected = false;
      current.connecting = false;
      current.subscribed.clear();
      console.warn(`${TAG} disconnected; 5-second REST guard remains active`);
      scheduleReconnect('socket close');
    });
    // Do not combine the opaque SDK retry loop with our supervisor. The SDK is
    // a singleton; this path installs handlers once per token, then reconnects
    // that instance with observable bounded backoff.
    connectExistingSocket('initial connection');
  } catch (err) {
    s.socket = null;
    s.socketTokenFingerprint = null;
    s.connecting = false;
    s.connected = false;
    s.lastError = `start failed: ${(err as Error).message}`;
    console.warn(`${TAG} ${s.lastError}`);
  }
}

/** Reconcile subscriptions to the current filled FYERS positions. Safe to call
 * on every fast-guard tick; it performs no work when the set is unchanged. */
export function syncFyersPnlStream(openTrades: readonly AutoTrade[]): Promise<void> {
  const s = state();
  const run = async (): Promise<void> => {
    const next = new Map<string, TrackedTrade>();
    for (const trade of openTrades) {
      if (trade.broker !== 'fyers' || trade.entryFillPremium == null) continue;
      const optionSymbol = toFyersOptionSymbol(trade);
      next.set(optionSymbol, { trade, optionSymbol });
    }
    s.tracked = next;
    for (const symbol of [...s.latest.keys()]) if (!next.has(symbol)) s.latest.delete(symbol);
    await ensureSocket();
    applySubscriptions();
  };
  const chained = (s.syncPromise ?? Promise.resolve()).then(run, run);
  const finished = chained.finally(() => {
    if (s.syncPromise === finished) s.syncPromise = null;
  });
  s.syncPromise = finished;
  return finished;
}

export function getFyersPnlStreamStatus(now = Date.now()): FyersPnlStreamStatus {
  const s = state();
  const trades: LiveTradePnl[] = [];
  for (const tracked of s.tracked.values()) {
    const { trade, optionSymbol } = tracked;
    const tick = s.latest.get(optionSymbol);
    const fresh = tick != null && now - tick.receivedAt <= STALE_AFTER_MS;
    const depthFresh = tick?.depthReceivedAt != null && now - tick.depthReceivedAt <= STALE_AFTER_MS;
    const ltpFresh = tick?.ltpReceivedAt != null && now - tick.ltpReceivedAt <= STALE_AFTER_MS;
    const bid = depthFresh ? tick!.bid : null;
    const ltp = ltpFresh ? tick!.ltp : null;
    const qty = trade.lotSize * trade.lots;
    const entry = trade.entryFillPremium;
    trades.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      optionSymbol,
      ltp,
      bid,
      ask: depthFresh ? tick!.ask : null,
      bidSize: depthFresh ? tick!.bidSize : null,
      executablePnlRupees: entry != null && bid != null ? Math.round((bid - entry) * qty) : null,
      ltpPnlRupees: entry != null && ltp != null ? Math.round((ltp - entry) * qty) : null,
      targetPnlRupees: Math.round((trade.targetPremium - (entry ?? trade.entryPremium)) * qty),
      updatedAt: tick == null ? null : new Date(tick.receivedAt).toISOString(),
      fresh,
    });
  }
  const executable = trades.map((trade) => trade.executablePnlRupees);
  const ltp = trades.map((trade) => trade.ltpPnlRupees);
  return {
    connected: s.connected,
    connecting: s.connecting,
    trackedTrades: trades.length,
    subscribedSymbols: s.subscribed.size,
    lastMessageAt: s.lastMessageAt,
    lastError: s.lastError,
    reconnectAttempts: s.reconnectAttempts,
    nextReconnectAt: s.nextReconnectAt,
    executablePnlRupees:
      trades.length > 0 && executable.every((value) => value != null)
        ? executable.reduce<number>((sum, value) => sum + Number(value), 0)
        : null,
    ltpPnlRupees:
      trades.length > 0 && ltp.every((value) => value != null)
        ? ltp.reduce<number>((sum, value) => sum + Number(value), 0)
        : null,
    executablePricedTrades: executable.filter((value) => value != null).length,
    trades,
  };
}
