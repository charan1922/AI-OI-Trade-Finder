import { NextResponse } from 'next/server';
import { getAutoTradeSettings } from '@/lib/auto-trade/settings';
import { adminOnly } from '@/lib/auth/server';
import { todayIST } from '@/lib/ist';
import {
  CHAT_MODELS,
  closeWatch,
  DEFAULT_CHAT_MODEL,
  decideMemory,
  getAutoActions,
  getChatModel,
  getNextCheckAt,
  isBackgroundEnabled,
  isV2Selected,
  listMemories,
  listNotes,
  listWakeups,
  listWatches,
  setAutoAction,
  setBackgroundEnabled,
  setChatModel,
} from '@/lib/operator-chat/background-store';
import { startWatch } from '@/lib/operator-chat/background-tools';
import type { ActionKind } from '@/lib/operator-chat/format';
import { MAX_HEARTBEATS_PER_DAY } from '@/lib/operator-chat/heartbeat';
import { SKILL_NAMES } from '@/lib/operator-chat/skills';
import { getWatchLoopStatus } from '@/lib/operator-chat/watch-loop';
import { RACE_WINDOW_START_MIN } from '@/lib/tf-live/race';
import { cadenceOf, MAX_ACTIVE_WATCHES, wakeBudget, WAKE_CAP_PER_DAY, WATCH_EXPIRY_MIN } from '@/lib/operator-chat/watches';

/**
 * GET  /api/trade-commentary/chat/background — Commentary v2's Background panel: the switch, the
 *      watch loop's status, today's watches, notebook and wake-ups. Admin-only (chat prefix in rbac.ts).
 * POST /api/trade-commentary/chat/background
 *      { action: 'toggle', enabled } | { action: 'set_model', model } | { action: 'start_watch', kind, ... } | { action: 'cancel_watch', id }
 */
export async function GET() {
  try {
    const date = todayIST();
    const [enabled, watches, notes, wakeups, settings, chatModel, memories, v2Selected] = await Promise.all([
      isBackgroundEnabled(),
      listWatches(date),
      listNotes(date),
      listWakeups(date),
      getAutoTradeSettings(),
      getChatModel(),
      listMemories(),
      isV2Selected(),
    ]);
    const [autoActions, nextCheckAt] = await Promise.all([getAutoActions(), getNextCheckAt()]);
    const budget = wakeBudget(wakeups, Date.now());
    return NextResponse.json({
      success: true,
      date,
      enabled,
      // /config's COMMENTARY_V2: with v1 selected, v2's background work is paused whatever `enabled` says.
      v2Selected,
      loop: getWatchLoopStatus(),
      limits: { maxActiveWatches: MAX_ACTIVE_WATCHES, wakeCapPerDay: WAKE_CAP_PER_DAY },
      budget: { used: budget.used, nextAtMs: budget.nextAtMs },
      watches: watches.map((w) => ({ ...w, cadence: cadenceOf(w.kind) })),
      notes,
      wakeups,
      // The page draws its session plan from these — the code's own values, never typed-in times.
      session: {
        raceStartMin: RACE_WINDOW_START_MIN,
        squareOffMin: settings.squareOffMin,
        watchExpiryMin: WATCH_EXPIRY_MIN,
      },
      // v2's OWN chat model — not the auto-trader's (that stays settings.mimoModel on /auto-trade).
      model: { mimoModel: chatModel, defaultModel: DEFAULT_CHAT_MODEL, options: CHAT_MODELS },
      skills: SKILL_NAMES,
      // Long-term memory: pending ones wait for the operator's Save; saved ones load into every v2 turn.
      memories,
      // Per-action switches: true = the AI does it by itself; false = Confirm card.
      autoActions,
      // The AI's self-paced check-in: when it chose to look next, and how many it made today (cap in heartbeat.ts).
      heartbeat: {
        nextCheckAt,
        // Computed here (the server's clock), so the page never calls Date.now() while rendering.
        due: !nextCheckAt || new Date(nextCheckAt).getTime() <= Date.now(),
        today: wakeups.filter((w) => w.kind === 'heartbeat').length,
        max: MAX_HEARTBEATS_PER_DAY,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const date = todayIST();
    if (body.action === 'toggle') {
      await setBackgroundEnabled(body.enabled === true);
      return NextResponse.json({ success: true, enabled: body.enabled === true });
    }
    if (body.action === 'memory_save' || body.action === 'memory_discard' || body.action === 'memory_delete') {
      const to = body.action === 'memory_save' ? 'saved' : body.action === 'memory_discard' ? 'rejected' : 'deleted';
      const ok = await decideMemory(Number(body.id), to);
      return ok ? NextResponse.json({ success: true }) : NextResponse.json({ error: 'That memory already changed.' }, { status: 409 });
    }
    if (body.action === 'set_auto_action') {
      const next = await setAutoAction(body.kind as ActionKind, body.auto === true);
      return NextResponse.json({ success: true, autoActions: next });
    }
    if (body.action === 'set_model') {
      await setChatModel(String(body.model ?? ''));
      return NextResponse.json({ success: true, model: await getChatModel() });
    }
    if (body.action === 'start_watch') {
      const r = await startWatch(date, body, 'operator');
      return r.ok
        ? NextResponse.json({ success: true, watch: r.watch })
        : NextResponse.json({ error: r.error }, { status: 400 });
    }
    if (body.action === 'cancel_watch') {
      const id = Number(body.id);
      const ok = Number.isFinite(id) && (await closeWatch(id, 'cancelled'));
      return ok
        ? NextResponse.json({ success: true })
        : NextResponse.json({ error: 'That watch is no longer active.' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
