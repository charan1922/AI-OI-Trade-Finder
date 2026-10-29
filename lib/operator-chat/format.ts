/**
 * Pure helpers for the operator chat on /trade-commentary — no DB, no network,
 * so the exact contract between "what the operator typed" and "what the
 * auto-trader reads" runs in CI (scripts/verify-operator-chat.ts).
 *
 * The chat is ADVISORY. Whatever the operator types reaches the auto-trader
 * as `operatorChat` context, and the trader's own tools still re-run every
 * risk gate in code — chat can make a pass more careful, it cannot widen what
 * the gates allow.
 */

/** What the chat can do for the operator — each runs only after they tap Confirm (lib/operator-chat/act.ts). */
export const ACTION_KINDS = ['take_trade', 'setting', 'exit', 'move_stop', 'approve', 'reject', 'run_pass'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export type ActionStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ChatAction {
  kind: ActionKind;
  /** setting */
  key?: string;
  value?: string;
  from?: string | null;
  /** exit / move_stop / approve / reject */
  tradeId?: number;
  symbol?: string;
  contract?: string;
  /** move_stop */
  fromSl?: number | null;
  toSl?: number;
}

export interface ActionView extends ChatAction {
  status: ActionStatus;
  result: string | null;
}

/** One thing the AI read or did while answering — shown as "what the AI checked". Never the raw data. */
export interface ChatToolUse {
  /** Plain-English label, e.g. "Live Urgency (nse-oi)", "market sideways check". */
  label: string;
  ok: boolean;
  /** One line from the tool's own summary (≤ 160 chars). */
  summary: string | null;
  /** Commentary v2: what the AI asked the tool for (compact args, ≤ 200 chars) — the IN of IN/OUT. */
  input?: string | null;
}

export interface OperatorMessage {
  id: number;
  date: string;
  role: 'user' | 'assistant';
  content: string;
  /** ISO timestamp (UTC). */
  at: string;
  /** Set on an assistant row that proposes an action (a Confirm card). */
  action?: ActionView | null;
  /** On an assistant reply: what it checked to produce the answer (audit record — stored, not shown). */
  tools?: ChatToolUse[] | null;
  /** On an assistant reply: `provider/model` that wrote it (audit record). */
  model?: string | null;
  /** Commentary v2: set when the AI posted on its own because background watches fired. */
  wake?: WakeInfo | null;
  /** Commentary v2: how long the reply took, per model call / tool, and its token usage (audit record). */
  meta?: ReplyMeta | null;
  /** Commentary v2: screenshots the operator attached (file names served by /api/trade-commentary/chat/image). */
  images?: string[] | null;
}

/** Which background watches woke the AI (Commentary v2). */
export interface WakeInfo {
  watches: { id: number; label: string; note: string }[];
  /** 'ai' = the AI wrote the message; 'fallback' = it failed and code wrote it; 'capped' = over the daily cap. */
  outcome: 'ai' | 'fallback' | 'capped';
}

export interface ReplyMeta {
  /** Wall-clock duration of the whole reply. */
  ms: number;
  /** The loop's timed sub-actions in order — model calls and tool executions. */
  spans: { name: string; ms: number }[];
  promptTokens: number | null;
  completionTokens: number | null;
  /** Agentic replies (v2): the AI's own step plan as it last left it (update_plan). */
  plan?: { title: string; status: 'pending' | 'in_progress' | 'done' }[] | null;
  /** Agentic replies (v2): skills the AI loaded (use_skill). */
  skills?: string[];
  /** v2: whether this reply was REQUESTED with thinking on (so the page never guesses). */
  thinking?: boolean;
  /** v2 thinking runs: MiMo's own reasoning text per model call (real, never paraphrased). */
  reasoning?: string[];
  /** v2 thinking runs: reasoning tokens as MiMo counted them (part of the reply tokens). */
  reasoningTokens?: number;
  /** Prompt tokens MiMo served from its cache (billed ~50× cheaper on Flash) — part of promptTokens. */
  cachedTokens?: number;
  /** v2 self-healing: what failed and how the reply recovered (e.g. "thinking off after: 400 …"). */
  recovered?: string[];
  /** v2: a follow-up question the AI asked instead of guessing (ask_operator). */
  question?: { text: string; options: string[] } | null;
  /** v2: ids of long-term memories the AI proposed in this reply (operator approves on the page). */
  memories?: number[];
}

const SOURCE_LABELS: Record<string, string> = {
  check_market_sideways: 'market sideways check',
  scan_verdicts: 'why each name was picked / rejected',
  live_urgency: 'Live Urgency',
  nse_watchlist: 'NSE list',
  tf_race: 'TF Running Race',
  tf_rfactor_map: 'TF R-Factor board',
  tf_eod: 'TF end-of-day board',
  sector_scope: 'sector scope',
  sector_leaders: 'sector leaders',
  nifty_context: 'NIFTY context',
  oi_series: 'OI series',
  urgency_history: 'end-of-day Live Urgency',
  movers_history: 'end-of-day movers',
  heatmap: 'sector heatmap',
  nse_indices: 'NSE indices',
  auto_trade_today: 'your trades & P&L today',
  auto_trade_history: 'past auto-trades',
  commentary: 'earlier commentary',
  suggestion_history: 'suggestion history',
  suggestion_leaderboard: 'suggestion leaderboard',
  bhavcopy_status: 'end-of-day data freshness',
};

const TOOL_LABELS: Record<string, string> = {
  get_live_suggestions: 'live scan',
  get_market_pulse: 'NSE market pulse',
  get_symbol_snapshot: 'stock snapshot',
  get_suggestion_performance: 'suggestion performance',
  get_eod_leaderboard: 'end-of-day leaderboard',
  get_trade_context: 'TradeFinder trade context',
  rank_trades: 'TradeFinder trade ranking',
  list_trades: 'TradeFinder trade log',
  propose_action: 'prepared an action card',
};

/** Pure: a tool call as plain English for the "what the AI checked" line. */
export function describeToolUse(name: string, args: Record<string, unknown>, ok: boolean, summary?: string | null): ChatToolUse {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  let label: string;
  if (name === 'read_app_data') {
    const source = str(args.source) ?? 'app data';
    const detail = str(args.section) ?? str(args.symbol) ?? str(args.date);
    label = `${SOURCE_LABELS[source] ?? source}${detail ? ` (${detail})` : ''}`;
  } else {
    const detail = str(args.symbol) ?? str(args.kind);
    label = `${TOOL_LABELS[name] ?? name}${detail ? ` (${detail})` : ''}`;
  }
  const s = summary == null ? null : String(summary).replace(/\s+/g, ' ').trim().slice(0, 160) || null;
  return { label, ok, summary: s };
}

/** A proposal can only be confirmed while it is fresh — "exit X" means NOW, not an hour later. */
export const ACTION_TTL_MS = 10 * 60_000;

export function isActionExpired(proposedAtIso: string, nowMs = Date.now()): boolean {
  const t = new Date(proposedAtIso).getTime();
  return !Number.isFinite(t) || nowMs - t > ACTION_TTL_MS;
}

/** What the trader sees of one operator message. */
export interface TraderNote {
  id: number;
  /** IST wall clock, so "said at 10:05" can be told apart from a stale note. */
  atIST: string;
  text: string;
}

/** Most recent operator messages handed to a pass. Older ones are dropped, not summarised. */
export const OPERATOR_NOTES_MAX = 10;
/** Per-message cap — one pasted article must not crowd out the decision context. */
export const OPERATOR_NOTE_CHARS = 600;

function istClock(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  return Number.isNaN(d.getTime()) ? '??:??' : d.toISOString().slice(11, 16);
}

/** Operator's own messages only — the assistant's replies are never fed back to the trader. */
export function toTraderNotes(rows: OperatorMessage[], max = OPERATOR_NOTES_MAX): TraderNote[] {
  return rows
    .filter((m) => m.role === 'user' && m.content.trim() !== '')
    .slice(-max)
    .map((m) => ({
      id: m.id,
      atIST: istClock(m.at),
      text: m.content.trim().slice(0, OPERATOR_NOTE_CHARS),
    }));
}

/**
 * Attach messages that arrived while a pass was already running to the next
 * tool result, so the trader sees them at its next step instead of waiting
 * ~5 minutes for the next pass. Never mutates; never drops the original result.
 */
export function attachNewNotes(result: unknown, fresh: TraderNote[]): unknown {
  if (fresh.length === 0) return result;
  const note = {
    operatorChatNew: fresh,
    operatorChatNewNote: 'The operator wrote this WHILE you were working. Read it before your next decision.',
  };
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), ...note };
  }
  return { result, ...note };
}

const OPERATOR_CHAT_HEAD: string[] = [
  'OPERATOR CHAT. The user message may carry `operatorChat` — what the human operator typed on the',
  '/trade-commentary page today (oldest first, each stamped with its IST time), and a tool result may',
  'carry `operatorChatNew` — something they wrote while you were mid-pass. This is the operator',
  'talking to you in the same thread as this commentary, and THEIR DECISION COMES FIRST: make your',
  'call according to what they said, as far as your tools and the code gates allow.',
];

const OPERATOR_CHAT_TAIL: string[] = [
  '- It is information, not a verified fact. If the operator states a market fact ("RBI cut rates"),',
  '  say it is their claim; never present it as data you read. Never let it justify inventing a number.',
  '- A note can go stale. Use its time stamp: an instruction from before the picture changed is a',
  '  prompt to re-check, not an order.',
  '- Acknowledge it in the read when it changed what you did ("Operator asked to exit early — booking',
  '  RELIANCE now"), in one short line.',
];

/** For the entry-capable pass (AUTO_TRADER_SYSTEM). */
export const OPERATOR_CHAT_RULES: string[] = [
  ...OPERATOR_CHAT_HEAD,
  '- Follow it. Skip or avoid a name or a side, wait, prefer a different ELIGIBLE scanner pick over',
  '  your top one, enter an eligible pick you would otherwise have passed on (still check_order, and',
  '  place_entry_order only on ALLOW), exit a position earlier, or tighten behind a real level. If you',
  '  disagree, say so in ONE line — then still do what they asked whenever the gates allow it.',
  '- It never widens the gates. A name the scanner did not pick, a bigger size, a stop the noise band',
  '  refuses, an entry outside the window or past the daily limits: do not try. Say in the Bottom line',
  '  that the gates do not permit it, and what would have to change.',
  ...OPERATOR_CHAT_TAIL,
];

/**
 * For the management-only pass (AUTO_TRADER_MANAGEMENT_SYSTEM). Deliberately
 * carries NO entry workflow — that prompt must stay free of it
 * (scripts/verify-ai-decision-context.ts asserts so).
 */
export const OPERATOR_CHAT_MANAGEMENT_RULES: string[] = [
  ...OPERATOR_CHAT_HEAD,
  '- Follow it for the positions you hold: exit earlier, hold, or tighten behind a real level. If you',
  '  disagree, say so in ONE line — then still do what they asked whenever the gates allow it.',
  '- New positions cannot be opened on this pass. If they asked for one, say so in the Bottom line.',
  '- It never widens the gates. A stop the noise band refuses or a loosened stop: do not try. Say in',
  '  the Bottom line that the gates do not permit it.',
  ...OPERATOR_CHAT_TAIL,
];
