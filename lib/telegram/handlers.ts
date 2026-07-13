/**
 * Telegram bot command handlers — processes incoming messages from the webhook
 * and dispatches auto-trade queries / controls.
 *
 * All handlers are async and return a text string that the caller sends back
 * to the user. No side effects beyond what's explicitly described.
 */

import { getAutoTradeSettings, setAutoTradeSetting } from '@/lib/auto-trade/settings';
import { getOpenTrades, getTradesByDate, dailyRealizedPnl, getExposure, countEntriesToday, getDecisions } from '@/lib/auto-trade/store';
import { nowIST, todayIST } from '@/lib/ist';
import type { AutoTradeSettings } from '@/lib/auto-trade/types';

/* ------------------------------------------------------------------ */
/*  Command registry                                                   */
/* ------------------------------------------------------------------ */

type Handler = (args: string, chatId: number) => Promise<string>;

const commands = new Map<string, { handler: Handler; description: string }>();

function register(cmd: string, description: string, handler: Handler) {
  commands.set(cmd.toLowerCase(), { handler, description });
}

/* ------------------------------------------------------------------ */
/*  Command implementations                                            */
/* ------------------------------------------------------------------ */

register('/start', 'Show available commands', async () => {
  return helpText();
});

register('/help', 'Show available commands', async () => {
  return helpText();
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

  return lines.join('\n');
});

register('/positions', 'Open positions', async () => {
  const openTrades = await getOpenTrades();
  if (openTrades.length === 0) return '📭 No open positions.';

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
  return lines.join('\n');
});

register('/trades', 'Today\'s trade history', async () => {
  const date = todayIST();
  const trades = await getTradesByDate(date);
  if (trades.length === 0) return '📭 No trades today.';

  const lines = [`📋 *Today's Trades* (${date})\n`];
  for (const t of trades) {
    const emoji = statusEmoji(t.status);
    const entry = t.entryFillPremium ?? t.entryPremium;
    const exitStr = t.exitFillPremium != null ? ` → ₹${t.exitFillPremium}` : '';
    const pnlStr = t.realizedPnlRupees != null ? ` | P&L ₹${t.realizedPnlRupees}` : '';
    lines.push(`${emoji} *${t.symbol}* ${t.optionType} ${t.strike} — ₹${entry}${exitStr}${pnlStr} [${t.status}]`);
  }
  return lines.join('\n');
});

register('/decisions', 'Recent AI decisions', async () => {
  const date = todayIST();
  const decisions = await getDecisions(date, 5);
  if (decisions.length === 0) return '📭 No AI decisions today.';

  const lines = ['🤖 *Recent AI Decisions*\n'];
  for (const d of decisions) {
    lines.push(`[${d.pass}] ${d.at.slice(11, 19)} — ${d.summary.slice(0, 200)}`);
  }
  return lines.join('\n');
});

register('/kill', 'Activate kill switch (halt new orders)', async (args, chatId) => {
  const settings = await getAutoTradeSettings();
  if (settings.killSwitch) {
    return '⚠️ Kill switch is already *ON*. No new orders will be placed.\nUse /unkill to deactivate.';
  }
  await setAutoTradeSetting('killSwitch', '1');
  return '🚨 *Kill switch ACTIVATED*\nNo new orders will be placed. Open positions still guarded.\nUse /unkill to deactivate.';
});

register('/unkill', 'Deactivate kill switch', async () => {
  const settings = await getAutoTradeSettings();
  if (!settings.killSwitch) {
    return '✅ Kill switch is already *OFF*. Orders can be placed normally.';
  }
  await setAutoTradeSetting('killSwitch', '0');
  return '✅ *Kill switch DEACTIVATED*\nNew orders can now be placed.';
});

register('/mode', 'Check or change trading mode', async (args) => {
  const trimmed = args.trim();
  const validModes = ['off', 'paper', 'approval', 'live'] as const;

  if (!trimmed) {
    const settings = await getAutoTradeSettings();
    return `Current mode: *${modeLabel(settings)}*\n\nChange with: /mode off|paper|approval|live`;
  }

  if (!validModes.includes(trimmed as typeof validModes[number])) {
    return `❌ Invalid mode "${trimmed}". Valid: ${validModes.join(', ')}`;
  }

  const settings = await setAutoTradeSetting('mode', trimmed);
  return `✅ Mode changed to *${modeLabel(settings)}*`;
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
  return lines.join('\n');
});

/* ------------------------------------------------------------------ */
/*  Dispatch                                                           */
/* ------------------------------------------------------------------ */

/**
 * Process an incoming Telegram text message.
 * If it starts with '/', dispatch to the matching handler.
 * Otherwise, ignore (or add free-text handling later).
 * Returns the response text to send back to the user.
 */
export async function handleTelegramMessage(
  text: string,
  chatId: number,
): Promise<string | null> {
  if (!text.startsWith('/')) return null;

  // Split "/cmd args" — strip bot username suffix like /status@MyBot
  const spaceIdx = text.indexOf(' ');
  const cmdPart = spaceIdx > 0 ? text.slice(0, spaceIdx) : text;
  const args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : '';
  const cmd = cmdPart.split('@')[0].toLowerCase(); // strip @botname

  const entry = commands.get(cmd);
  if (!entry) {
    return `❓ Unknown command: ${cmd}\n\nType /help for available commands.`;
  }

  try {
    return await entry.handler(args, chatId);
  } catch (err) {
    console.error(`[TelegramHandlers] ${cmd} error:`, err);
    return `❌ Error executing ${cmd}: ${(err as Error).message}`;
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
  lines.push(`\nAlerts are sent automatically for trade events.`);
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