/**
 * Shared shapes for the auto-trade module (lib/auto-trade/) — the AI-driven
 * execution layer over the deterministic /trade-suggest scanner.
 *
 * Design principle: THE AI PROPOSES, CODE DISPOSES. The model only ever calls
 * tools; every mutating tool re-runs the hard gates (risk/gates.ts) in code, so
 * no prompt failure can place a 3rd trade, enter outside the window, or skip a
 * stop. See engine.ts for the per-cycle flow.
 */

export type TradeMode = 'off' | 'paper' | 'approval' | 'live';
export type BrokerId = 'fyers' | 'dhan';
export type AiProvider = 'azure' | 'mimo';
export type OrderSide = 'BUY' | 'SELL';

/** Runtime settings — stored in auto_trade_settings, editable from /auto-trade. */
export interface AutoTradeSettings {
  /** off = module dormant · paper = simulated fills at real quotes ·
   *  approval = AI proposes, human approves each order · live = autonomous
   *  real orders (ALSO requires env AUTO_TRADE_LIVE_ENABLED=true — two keys). */
  mode: TradeMode;
  /** The one active broker account ("both wired, one live at a time"). */
  broker: BrokerId;
  /** Which model runs the decision loop (both are wired; A/B from the UI). */
  aiProvider: AiProvider;
  /** Instant halt for NEW orders. Open positions keep being guarded to exit. */
  killSwitch: boolean;
  /** Hard cap on entries per day (user rule: max 2 real trades). */
  maxTradesPerDay: number;
  /** Hard cap on simultaneously open lots (user rule: max 2 lots). */
  maxOpenLots: number;
  /** Hard cap on premium capital deployed across open+pending positions (₹).
   *  User rule: 50–60k account — whichever of lots/₹ binds first wins. */
  maxCapitalRupees: number;
  /** Realized loss on the day at which the module halts new entries (₹). */
  dailyLossHaltRupees: number;
  /** Reject an entry when the option's bid-ask spread exceeds this % of mid —
   *  the ceiling on instant market-order slippage (half-spread paid at fill). */
  maxSpreadPct: number;
  /** Minutes a pending approval stays actionable before it expires. */
  approvalTtlMin: number;
  /** Send auto-trade alerts + commentary to Telegram. Toggle from /telegram command. */
  telegramAlerts: boolean;
  /** Entry window bounds + forced square-off, IST minutes from midnight.
   *  Runtime-tunable within CLAMPED rails (settings.ts registry) — enforcement
   *  stays in code (risk gates + position guard), same two-layer pattern as
   *  the other risk caps. Defaults = the long-standing 09:45 / 11:00 / 15:12. */
  entryStartMin: number;
  entryEndMin: number;
  squareOffMin: number;
}

/** Position lifecycle. pending approval → placing → open → closed. `placing`
 * reserves risk while broker acceptance/fill is being reconciled. */
export type TradeStatus = 'placing' | 'pending_approval' | 'rejected' | 'expired' | 'open' | 'closed' | 'failed';

/** One auto-trade position (a row in auto_trades). Premium fields are ₹/share
 *  of premium; rupee P&L multiplies by lotSize × lots. */
export interface AutoTrade {
  id: number;
  date: string; // YYYY-MM-DD (IST)
  symbol: string;
  direction: 'bullish' | 'bearish';
  optionType: 'CE' | 'PE';
  strike: number;
  expiryDate: string;
  lotSize: number;
  lots: number;
  optSecurityId: string;
  mode: TradeMode;
  broker: string; // 'paper' | BrokerId
  status: TradeStatus;
  /** Spot plan carried from the scanner pick (AI-facing management levels). */
  entrySpot: number;
  slSpot: number | null;
  targetSpot: number | null;
  /** Premium plan: entry quote at proposal + the deterministic backstops
   *  (slPremium = tighter of −40% and −₹cap/lot; targetPremium = +₹5k/lot). */
  entryPremium: number;
  slPremium: number;
  targetPremium: number;
  /** Actual fills (null until the broker confirms — never fabricated). */
  entryFillPremium: number | null;
  exitFillPremium: number | null;
  exitReason: string | null;
  /** Would-have figures for FAILED entries, backfilled from real recorded
   *  candles (replaying the guard's SL/target/square-off). Display-only:
   *  never counted in realized P&L, exposure, or the daily-loss halt. */
  shadowEntryPremium: number | null;
  shadowExitPremium: number | null;
  shadowExitReason: string | null;
  shadowPnlRupees: number | null;
  aiReasonEntry: string;
  aiReasonExit: string | null;
  /** (exitFill − entryFill) × lotSize × lots, set at close when both known. */
  realizedPnlRupees: number | null;
  proposedAt: string;
  openedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
}

export type OrderStatus = 'sent' | 'filled' | 'rejected' | 'cancelled' | 'unknown';

/** One order sent to a broker (a row in auto_orders). idemKey is unique — a
 *  retry after a network error can never double-fire. */
export interface AutoOrder {
  id: number;
  tradeId: number;
  idemKey: string;
  broker: string;
  mode: TradeMode;
  side: OrderSide;
  qtyUnits: number;
  correlationId: string | null;
  brokerOrderId: string | null;
  status: OrderStatus;
  avgFillPrice: number | null;
  error: string | null;
  reconcileAttempts: number;
  lastReconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One AI/system pass recorded in auto_decisions (append-only audit). */
export interface AutoDecision {
  id: number;
  date: string;
  at: string;
  pass: 'ai' | 'guard' | 'approval' | 'system';
  provider: string | null;
  model: string | null;
  summary: string;
  toolTrace: string; // JSON of ToolTraceEntry[]
  promptTokens: number | null;
  completionTokens: number | null;
}

/** Verdict of the pre-trade gates. reasons lists every failed gate. */
export interface GateVerdict {
  allow: boolean;
  reasons: string[];
}

/** Aggregate account/cap state — what the gates and the AI both look at. */
export interface AccountState {
  mode: TradeMode;
  broker: string;
  aiProvider: AiProvider;
  killSwitch: boolean;
  liveEnvEnabled: boolean;
  marketOpen: boolean;
  entryWindowActive: boolean;
  entryWindowOpensAt: string;
  entryWindowClosesAt: string;
  squareOffAt: string;
  nowIST: string;
  entriesToday: number;
  maxTradesPerDay: number;
  openLots: number;
  maxOpenLots: number;
  deployedRupees: number;
  maxCapitalRupees: number;
  dailyRealizedPnlRupees: number;
  dailyLossHaltRupees: number;
  pendingApprovals: number;
  brokerFundsAvailable: number | null;
  /** Real broker funds are fetched only inside the placement/approval gate so
   * routine AI context never waits on a broker account endpoint. */
  brokerFundsCheckedAtPlacement: boolean;
}

/** Trace of one tool execution — mirrors lib/ai-assistant's ToolTraceEntry. */
export interface ToolTraceEntry {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  /** Wall-clock duration of the tool execution (absent on rows from before
   *  cycle-timeline instrumentation existed). */
  ms?: number;
}
