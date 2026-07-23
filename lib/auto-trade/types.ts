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
export type ProfitTargetMode = 'per_trade' | 'per_lot';
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
  /** Cash profit target for each new position. `per_trade` stays fixed when
   * lots change; `per_lot` multiplies the amount by the number of lots. */
  profitTargetMode: ProfitTargetMode;
  profitTargetRupees: number;
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
  /** Premium plan: entry quote at proposal + deterministic cash backstops.
   * targetPremium snapshots the effective policy before placement. */
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
  /** Quant SHADOW metrics — recorded on real trades purely to MEASURE entry/exit
   *  quality (late-chase, giveback, weak-sector). None of these gates or alters a
   *  live entry/exit; they exist so thresholds can be calibrated on recorded days
   *  before anything here becomes a gate. The entry* fields are captured at FILL
   *  confirmation (not at proposal), so approval-mode trades reflect the moment
   *  the position actually opened. */
  entryObservedSpot: number | null; // candle-store spot at fill (NOT a live tick — see age/fresh)
  entrySpotAgeMs: number | null; // age of that candle close at capture
  entrySpotBucketTs: number | null; // 5-min bucket start of the observed spot (audit trail)
  entrySpotFresh: boolean | null; // false → the R/chg metrics below are left null (STRICT entry-metric age gate)
  entryChangePctOpen: number | null; // % from the day's open at fill
  entryProgressR: number | null; // PLAN progress: (observedSpot − plannedEntry)/plannedRisk, signed
  entryRemainingRewardR: number | null; // (plannedTarget − observedSpot)/plannedRisk, signed
  /** Re-anchor-at-placement shadow (doc §7/§14): forward reward:risk to the
   *  stored target at the fresh entry, and the stop/target a rebuild at the fill
   *  moment would produce. Measurement only — never changes the order. */
  entryForwardRR: number | null;
  entryFreshSlSpot: number | null;
  entryFreshTargetSpot: number | null;
  /** Pick's sector rank by OI-spurt rate among scanned sectors (proposal-time). */
  entrySectorRank: number | null;
  entrySectorCount: number | null;
  /** PLANNED risk |plannedEntry − plannedStop| — the plan-progress denominator
   *  (entryProgressR / forwardRR context). Immutable at entry. */
  entryInitialRiskPoints: number | null;
  /** POST-ENTRY risk |observedSpot − plannedStop| — the MFE/MAE denominator, so
   *  excursion is measured from where the position ACTUALLY opened, not the
   *  scanner plan (AT-review 2026-07-20). Null when the fill spot was stale. */
  entryObservedRiskPoints: number | null;
  /** Max favorable / adverse excursion in R over the hold (candle high/low),
   *  measured from entryObservedSpot against entryObservedRiskPoints. */
  shadowMfeR: number | null;
  shadowMaeR: number | null;
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

/** One exact-contract market snapshot captured while a position is open.
 * `bid` is the executable price for selling our long option; retaining it
 * turns future cash-target reviews into executable-price audits rather than
 * LTP-only estimates. Logging is measurement-only and never blocks an exit. */
export interface AutoQuoteSnapshot {
  id: number;
  tradeId: number;
  date: string;
  capturedAt: string;
  source: 'guard' | 'ai_get_quote' | 'fyers_stream';
  optSecurityId: string;
  ltp: number;
  priceSource: 'ltp' | 'mid';
  bid: number | null;
  ask: number | null;
  /** Displayed size at the touch. Null on rows written before it was recorded.
   *  A target study needs this: the same bid price is or is not an executable
   *  exit depending entirely on whether it holds the whole position. */
  bidQty: number | null;
  askQty: number | null;
  spreadPct: number | null;
  slPremium: number;
  targetPremium: number;
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
  profitTargetMode: ProfitTargetMode;
  profitTargetRupees: number;
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
