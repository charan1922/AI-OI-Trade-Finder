/**
 * Telegram bot command handlers — processes incoming messages from the webhook
 * and dispatches auto-trade queries / controls.
 *
 * All handlers are async and return { text, reply_markup? } that the caller
 * sends back to the user. No side effects beyond what's explicitly described.
 *
 * Destructive commands (kill, unkill, mode change, approve, reject) are
 * restricted to the operator chat (TELEGRAM_CHAT_ID).
 */

import { approveTrade, rejectTrade } from '@/lib/auto-trade/approval';
import { getAutoTradeSettings, setAutoTradeSetting } from '@/lib/auto-trade/settings';
import { getOpenTrades, getTradesByDate, dailyRealizedPnl, getExposure, countEntriesToday, getDecisions } from '@/lib/auto-trade/store';
import { env } from '@/lib/env';
import { nowIST, todayIST } from '@/lib/ist';
import type { AutoTradeSettings } from '@/lib/auto-trade/types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface HandlerResult {
  text: string;
  reply_markup?: Record<string, unknown>;
}

type Handler = (args: string, chatId: number) => Promise<HandlerResult>;

/* ------------------------------------------------------------------ */
/*  Operator guard                                                     */
/* ------------------------------------------------------------------ */

/** True if chatId matches the configured operator (TELEGRAM_CHAT_ID). */
function isOperator(chatId: number): boolean {
  const opChatId = env.TELEGRAM_CHAT_ID;
  if (!opChatId) return true; // no restriction if not configured
  return chatId === Number(opChatId);
}

/* ------------------------------------------------------------------ */
/*  Command registry                                                   */
/* ------------------------------------------------------------------ */

const commands = new Map<string, { handler: Handler; description: string }>();

function register(cmd: string, description: string, handler: Handler) {
  commands.set(cmd.toLowerCase(), { handler, description });
}

/* ------------------------------------------------------------------ */
/*  Inline keyboard builders                                           */
/* ------------------------------------------------------------------ */

/** Quick-action buttons shown after most commands. */
function quickActionsKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: '📊 Status', callback_data: '/status' },
        { text: '📈 Positions', callback_data: '/positions' },
        { text: '💰 P&L', callback_data: '/pnl' },
      ],
      [
        { text: '📋 Trades', callback_data: '/trades' },
        { text: '🤖 Decisions', callback_data: '/decisions' },
      ],
      [
        { text: '🚨 Kill', callback_data: '/kill' },
        { text: '✅ Unkill', callback_data: '/unkill' },
      ],
    ],
  };
}

/** Full command list keyboard for /start and /help. */
function helpKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: '📊 Status', callback_data: '/status' },
        { text: '📈 Positions', callback_data: '/positions' },
        { text: '💰 P&L', callback_data: '/pnl' },
      ],
      [
        { text: '📋 Trades', callback_data: '/trades' },
        { text: '🤖 Decisions', callback_data: '/decisions' },
      ],
      [
        { text: '🚨 Kill', callback_data: '/kill' },
        { text: '✅ Unkill', callback_data: '/unkill' },
      ],
      [
        { text: '📝 Paper', callback_data: '/mode paper' },
        { text: '👀 Approval', callback_data: '/mode approval' },
        { text: '🔥 Live', callback_data: '/mode live' },
      ],
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  Command implementations                                            */
/* ------------------------------------------------------------------ */

register('/start', 'Show available commands', async () => {
  return { text: helpText(), reply_markup: helpKeyboard() };
});

register('/help', 'Show available commands', async () => {
  return { text: helpText(), reply_markup: helpKeyboard() };
});

register('/status', 'Auto-trade engine status', async () => {
  const settings = await getAutoTradeSettings();
  const date = todayIST();
  const openTrades = await getOpenTrades();
  const exposure = await getExposure(date);
  const entries = await countEntriesToday(date);
  const pnl = await dailyRealizedPnl(date);
  const now = nowIST();

  const lines = [
    `📊 *Auto-Trade Status* (${now})`,
    ``,
    `Mode: *${modeLabel(settings)}*`,
    `Broker: ${settings.broker}  |  AI: ${settings.aiProvider}`,
    `Kill switch: ${settings.killSwitch ? '🚨 ON' : '✅ OFF'}`,
    ``,
    `Entries today: ${entries}/${settings.maxTradesPerDay}`,
    `Open lots: ${exposure.openLots}/${settings.maxOpenLots}`,
    `Deployed: ₹${exposure.deployedRupees.toLocaleString('en-IN')}/₹${settings.maxCapitalRupees.toLocaleString('en-IN')}`,
    `Daily P&L: ${pnl >= 0 ? '+' : ''}₹${pnl.toLocaleString('en-IN')}  (halt @ -₹${settings.dailyLossHaltRupees.toLocaleString('en-IN')})`,
    ``,
    `Open positions: ${openTrades.length}`,
  ];

  for (const t of openTrades) {
    lines.push(`  • ${t.symbol} ${t.optionType} ${t.strike} — ${t.lots} lot(s) @ ₹${t.entryFillPremium ?? t.entryPremium}`);
  }

  return { text: lines.join('\n'), reply_markup: quickActionsKeyboard() };
});

register('/positions', 'Open positions', async () => {
  const openTrades = await getOpenTrades();
  if (openTrades.length === 0) return { text: '📭 No open positions.', reply_markup: quickActionsKeyboard() };

  const lines = ['📈 *Open Positions*\n'];
  for (const t of openTrades) {
    const entry = t.entryFillPremium ?? t.entryPremium;
    const pnlStr = t.realizedPnlRupees != null ? ` (P&L ₹${t.realizedPnlRupees})` : '';
    lines.push(
      `*${t.symbol}* ${t.optionType} ${t.strike}\n` +
      `  Entry: ₹${entry} | SL: ₹${t.slPremium} | Target: ₹${t.targetPremium}\n` +
      `  Lots: ${t.lots} × ${t.lotSize} | Mode: ${t.mode}${pnlStr}\n` +
      `  Reason: ${t.aiReasonEntry.slice(0, 120)}`,
    );
  }
  return { text: lines.join('\n'), reply_markup: quickActionsKeyboard() };
});

register('/trades', 'Today\'s trade history', async () => {
  const date = todayIST();
  const trades = await getTradesByDate(date);
  if (trades.length === 0) return { text: '📭 No trades today.', reply_markup: quickActionsKeyboard() };

  const lines = [`📋 *Today's Trades* (${date})\n`];
  for (const t of trades) {
    const emoji = statusEmoji(t.status);
    const entry = t.entryFillPremium ?? t.entryPremium;
    const exitStr = t.exitFillPremium != null ? ` → ₹${t.exitFillPremium}` : '';
    const pnlStr = t.realizedPnlRupees != null ? ` | P&L ₹${t.realizedPnlRupees}` : '';
    lines.push(`${emoji} *${t.symbol}* ${t.optionType} ${t.strike} — ₹${entry}${exitStr}${pnlStr} [${t.status}]`);
  }
  return { text: lines.join('\n'), reply_markup: quickActionsKeyboard() };
});

register('/decisions', 'Recent AI decisions', async () => {
  const date = todayIST();
  const decisions = await getDecisions(date, 5);
  if (decisions.length === 0) return { text: '📭 No AI decisions today.', reply_markup: quickActionsKeyboard() };

  const lines = ['🤖 *Recent AI Decisions*\n'];
  for (const d of decisions) {
    lines.push(`[${d.pass}] ${d.at.slice(11, 19)} — ${d.summary.slice(0, 200)}`);
  }
  return { text: lines.join('\n'), reply_markup: quickActionsKeyboard() };
});

register('/approve', 'Approve a pending trade', async (args, chatId) => {
  if (!isOperator(chatId)) {
    return { text: '❌ Operator-only command.' };
  }
  const tradeId = Number(args.trim());
  if (!Number.isFinite(tradeId)) {
    return { text: 'Usage: /approve <tradeId>', reply_markup: quickActionsKeyboard() };
  }
  const outcome = await approveTrade(tradeId);
  return { text: outcome.ok ? `✅ ${outcome.message}` : `❌ ${outcome.message}`, reply_markup: quickActionsKeyboard() };
});

register('/reject', 'Reject a pending trade', async (args, chatId) => {
  if (!isOperator(chatId)) {
    return { text: '❌ Operator-only command.' };
  }
  const tradeId = Number(args.trim());
  if (!Number.isFinite(tradeId)) {
    return { text: 'Usage: /reject <tradeId>', reply_markup: quickActionsKeyboard() };
  }
  const outcome = await rejectTrade(tradeId);
  return { text: outcome.ok ? `✅ ${outcome.message}` : `❌ ${outcome.message}`, reply_markup: quickActionsKeyboard() };
});

register('/kill', 'Activate kill switch (halt new orders)', async (_args, chatId) => {
  if (!isOperator(chatId)) {
    return { text: '❌ Operator-only command.' };
  }
  const settings = await getAutoTradeSettings();
  if (settings.killSwitch) {
    return { text: '⚠️ Kill switch is already *ON*. No new orders will be placed.\nUse /unkill to deactivate.', reply_markup: quickActionsKeyboard() };
  }
  await setAutoTradeSetting('killSwitch', '1');
  return { text: '🚨 *Kill switch ACTIVATED*\nNo new orders will be placed. Open positions still guarded.\nUse /unkill to deactivate.', reply_markup: quickActionsKeyboard() };
});

register('/unkill', 'Deactivate kill switch', async (_args, chatId) => {
  if (!isOperator(chatId)) {
    return { text: '❌ Operator-only command.' };
  }
  const settings = await getAutoTradeSettings();
  if (!settings.killSwitch) {
    return { text: '✅ Kill switch is already *OFF*. Orders can be placed normally.', reply_markup: quickActionsKeyboard() };
  }
  await setAutoTradeSetting('killSwitch', '0');
  return { text: '✅ *Kill switch DEACTIVATED*\nNew orders can now be placed.', reply_markup: quickActionsKeyboard() };
});

register('/telegram', 'Toggle Telegram alerts on/off', async (args, chatId) => {
  if (!isOperator(chatId)) {
    return { text: '❌ Operator-only command.' };
  }
  const settings = await getAutoTradeSettings();
  const trimmed = args.trim().toLowerCase();

  if (!trimmed || trimmed === 'status') {
    const status = settings.telegramAlerts ? '✅ ON' : '🔕 OFF';
    return { text: `Telegram alerts: ${status}\n\nToggle with: /telegram on|off`, reply_markup: quickActionsKeyboard() };
  }

  if (trimmed === 'on') {
    await setAutoTradeSetting('telegramAlerts', '1');
    return { text: '✅ Telegram alerts turned ON', reply_markup: quickActionsKeyboard() };
  }

  if (trimmed === 'off') {
    await setAutoTradeSetting('telegramAlerts', '0');
    return { text: '🔕 Telegram alerts turned OFF', reply_markup: quickActionsKeyboard() };
  }

  return { text: 'Usage: /telegram on|off|status', reply_markup: quickActionsKeyboard() };
});

register('/mode', 'Check or change trading mode', async (args, chatId) => {
  const trimmed = args.trim();
  const validModes = ['off', 'paper', 'approval', 'live'] as const;

  if (!trimmed) {
    const settings = await getAutoTradeSettings();
    return { text: `Current mode: *${modeLabel(settings)}*\n\nChange with: /mode off|paper|approval|live`, reply_markup: quickActionsKeyboard() };
  }

  if (!isOperator(chatId)) {
    return { text: '❌ Operator-only command (mode change).' };
  }

  if (!validModes.includes(trimmed as typeof validModes[number])) {
    return { text: `❌ Invalid mode "${trimmed}". Valid: ${validModes.join(', ')}`, reply_markup: quickActionsKeyboard() };
  }

  const settings = await setAutoTradeSetting('mode', trimmed);
  return { text: `✅ Mode changed to *${modeLabel(settings)}*`, reply_markup: quickActionsKeyboard() };
});

register('/pnl', 'Daily P&L summary', async () => {
  const date = todayIST();
  const pnl = await dailyRealizedPnl(date);
  const exposure = await getExposure(date);
  const trades = await getTradesByDate(date);
  const closed = trades.filter((t) => t.status === 'closed');
  const wins = closed.filter((t) => (t.realizedPnlRupees ?? 0) > 0).length;
  const losses = closed.filter((t) => (t.realizedPnlRupees ?? 0) < 0).length;

  const lines = [
    `💰 *Daily P&L* (${date})`,
    ``,
    `Realized: ${pnl >= 0 ? '+' : ''}₹${pnl.toLocaleString('en-IN')}`,
    `Deployed: ₹${exposure.deployedRupees.toLocaleString('en-IN')}`,
    `Open lots: ${exposure.openLots}`,
    `Win/Loss: ${wins}W / ${losses}L`,
    `Total trades: ${trades.length}`,
  ];
  return { text: lines.join('\n'), reply_markup: quickActionsKeyboard() };
});

/* ------------------------------------------------------------------ */
/*  Dispatch                                                           */
/* ------------------------------------------------------------------ */

/**
 * Process an incoming Telegram text message or callback_data.
 * If it starts with '/', dispatch to the matching handler.
 * Otherwise, ignore (or add free-text handling later).
 * Returns { text, reply_markup? } for the caller to send.
 */
export async function handleTelegramMessage(
  text: string,
  chatId: number,
): Promise<HandlerResult | null> {
  if (!text.startsWith('/')) return null;

  // Non-operators can only read — they see commentary/alerts but cannot run commands
  if (!isOperator(chatId)) {
    return { text: '🔒 This is a read-only bot. Only the operator can run commands.\nYou will receive trade commentary and alerts automatically.' };
  }

  // Split "/cmd args" — strip bot username suffix like /status@MyBot
  const spaceIdx = text.indexOf(' ');
  const cmdPart = spaceIdx > 0 ? text.slice(0, spaceIdx) : text;
  const args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : '';
  const cmd = cmdPart.split('@')[0].toLowerCase(); // strip @botname

  const entry = commands.get(cmd);
  if (!entry) {
    return { text: `❓ Unknown command: ${cmd}\n\nType /help for available commands.` };
  }

  try {
    return await entry.handler(args, chatId);
  } catch (err) {
    console.error(`[TelegramHandlers] ${cmd} error:`, err);
    return { text: `❌ Error executing ${cmd}: ${(err as Error).message}` };
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function helpText(): string {
  const lines = [
    `🤖 *Project-R Auto-Trade Bot*\n`,
    `Available commands:\n`,
  ];
  for (const [cmd, { description }] of commands) {
    lines.push(`${cmd} — ${description}`);
  }
  lines.push(`\n🔒 Kill, Unkill, Mode change, Approve, Reject — operator only.`);
  lines.push(`\nAlerts are sent automatically for trade events.`);
  lines.push(`\nTap a button below for quick actions 👇`);
  return lines.join('\n');
}

function modeLabel(s: AutoTradeSettings): string {
  const labels: Record<string, string> = {
    off: 'OFF 🔴',
    paper: 'PAPER 📝',
    approval: 'APPROVAL 👀',
    live: 'LIVE 🔥',
  };
  return labels[s.mode] ?? s.mode;
}

function statusEmoji(status: string): string {
  const map: Record<string, string> = {
    pending_approval: '👀',
    open: '🟢',
    closed: '🔵',
    rejected: '❌',
    expired: '⏰',
    failed: '💥',
  };
  return map[status] ?? '❓';
}