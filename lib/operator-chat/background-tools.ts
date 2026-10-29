/**
 * The chat AI's background tools (Commentary v2) — start / cancel / list watches and write to the
 * day notebook — plus the framing block that tells it how they work. Only added to the chat when the
 * Background switch is ON (background-store.ts); with it off the chat's tool list is today's.
 *
 * None of these can trade. A watch only wakes the AI to TALK; orders stay with the auto-trader.
 */

import type { ToolTraceEntry } from '@/lib/auto-trade/types';
import type { NeutralToolDef } from '@/lib/auto-trade/tools/defs';
import { addNote, closeWatch, insertWatch, listNotes, listWatches, NOTE_MAX_CHARS, type ChatWatch } from './background-store';
import { loadWatchInputs } from './watch-inputs';
import { cadenceOf, MAX_ACTIVE_WATCHES, validateWatch, WATCH_KINDS, WAKE_CAP_PER_DAY } from './watches';

export const BACKGROUND_TOOL_DEFS: NeutralToolDef[] = [
  {
    name: 'start_watch',
    description: [
      'Start a background watch. Code checks it every 60s; when it fires YOU are woken to message the operator here.',
      'Use it when the operator says "tell me when…", or when you see a level worth watching on an open position.',
      'kinds (anything else is a code change — say so):',
      '- price_cross {symbol, level, direction: above|below} — the 5-min close crosses the level (level within ±10% of price).',
      '- position_r {symbol, r} — the open position reaches r R (e.g. 1, 2, or -0.5).',
      '- near_stop {symbol, withinPct?} — spot within withinPct% (default 0.3) of the position stop.',
      "- tf_top {symbol, event: joins|leaves} — the stock joins/leaves TF's top list.",
      '- market_sideways {to: stuck|not_stuck} — the market-wide sideways check flips.',
      '- board_stale {} — the TF board goes stale (capture stopped).',
      '- time {at: "HH:MM"} — a reminder at that IST time.',
      'Optional label: a short name. Prices update every 5 min — never promise faster.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...WATCH_KINDS] },
        symbol: { type: 'string' },
        level: { type: 'number' },
        direction: { type: 'string', enum: ['above', 'below'] },
        r: { type: 'number' },
        withinPct: { type: 'number' },
        event: { type: 'string', enum: ['joins', 'leaves'] },
        to: { type: 'string', enum: ['stuck', 'not_stuck'] },
        at: { type: 'string' },
        label: { type: 'string' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'cancel_watch',
    description: 'Cancel a background watch by id (from list_watches or the start_watch result).',
    parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'list_watches',
    description: "Today's background watches with status (watching / fired / cancelled / expired) and the last check.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'write_note',
    description: `Write one short line (≤ ${NOTE_MAX_CHARS} chars) to today's notebook — your own memory between turns. Write what you will want to know next time: a level that held, what you are waiting for, what the operator asked you to keep in mind. Facts you read, never guesses.`,
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

export const BACKGROUND_TOOL_NAMES: ReadonlySet<string> = new Set(BACKGROUND_TOOL_DEFS.map((t) => t.name));

const watchView = (w: ChatWatch) => ({
  id: w.id,
  label: w.label,
  kind: w.kind,
  status: w.status,
  startedBy: w.createdBy,
  cadence: cadenceOf(w.kind),
  lastCheck: w.lastCheckNote,
  firedDetail: w.firedDetail,
});

/** Shared by the AI tool and the operator's API: validate against live inputs, enforce the cap, insert. */
export async function startWatch(
  date: string,
  raw: Record<string, unknown>,
  createdBy: 'operator' | 'ai'
): Promise<{ ok: true; watch: ChatWatch } | { ok: false; error: string }> {
  const active = (await listWatches(date)).filter((w) => w.status === 'watching');
  if (active.length >= MAX_ACTIVE_WATCHES) {
    return { ok: false, error: `Already ${MAX_ACTIVE_WATCHES} active watches — cancel one first.` };
  }
  const kind = WATCH_KINDS.find((k) => k === raw.kind);
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
  const inputs = await loadWatchInputs(date, { symbols: symbol ? [symbol] : [], kinds: kind ? [kind] : [] });
  const v = validateWatch(raw.kind, raw, inputs);
  if (!v.ok) return v;
  // Idempotent: the same watch already running is returned, never duplicated (a self-healing retry of a
  // turn, or the operator asking twice, must not create two watches that fire twice).
  const same = active.find((w) => w.kind === v.kind && JSON.stringify(w.params) === JSON.stringify(v.params));
  if (same) return { ok: true, watch: same };
  const watch = await insertWatch({ date, kind: v.kind, params: v.params, label: v.label, createdBy });
  return { ok: true, watch };
}

/** Executes one background tool call for the chat / woken turn. */
export async function executeBackgroundTool(
  date: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ result: unknown; trace: ToolTraceEntry }> {
  const done = (result: unknown, ok: boolean, summary: string) => ({ result, trace: { name, args, ok, summary } });
  try {
    if (name === 'start_watch') {
      const r = await startWatch(date, args, 'ai');
      if (!r.ok) return done({ started: false, error: r.error }, false, r.error);
      return done(
        { started: true, watch: watchView(r.watch), note: 'Tell the operator what you are watching and how often it is checked.' },
        true,
        `watching: ${r.watch.label}`
      );
    }
    if (name === 'cancel_watch') {
      const id = Number(args.id);
      const ok = Number.isFinite(id) && (await closeWatch(id, 'cancelled'));
      return done({ cancelled: ok }, ok, ok ? `cancelled watch #${id}` : `watch #${args.id} not active`);
    }
    if (name === 'list_watches') {
      const all = await listWatches(date);
      return done({ watches: all.map(watchView) }, true, `${all.filter((w) => w.status === 'watching').length} active`);
    }
    if (name === 'write_note') {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return done({ saved: false, error: 'empty note' }, false, 'empty note');
      // Idempotent like start_watch: a retried turn re-writing its last note is not a second note.
      const last = (await listNotes(date, 1))[0];
      if (last && last.text === text.slice(0, NOTE_MAX_CHARS)) return done({ saved: true, id: last.id }, true, 'noted (already)');
      const n = await addNote(date, text);
      return done({ saved: true, id: n.id }, true, `noted: ${n.text.slice(0, 80)}`);
    }
    return done({ error: `unknown tool ${name}` }, false, 'unknown tool');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return done({ error: msg }, false, msg.slice(0, 120));
  }
}

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

/** Framing added to the chat / woken turn when Background is ON. */
export async function backgroundFraming(date: string): Promise<string> {
  const [watches, notes] = await Promise.all([listWatches(date), listNotes(date, 12)]);
  const active = watches.filter((w) => w.status === 'watching');
  return [
    '## Background (Commentary v2 — ON)',
    'You are no longer only reactive: code runs your background watches every 60s and WAKES you when one',
    'fires, so you can message the operator first, in this thread. Tools: start_watch, cancel_watch,',
    'list_watches, write_note. Prices update every 5 min — say "checked every minute, prices move every 5',
    `min", never "tick by tick". At most ${MAX_ACTIVE_WATCHES} active watches and ${WAKE_CAP_PER_DAY} wake-ups a day; all expire 15:30 IST.`,
    "- When the operator says \"tell me when / watch / ping me if\" → start_watch, then say what you're watching.",
    '- Start a watch yourself only for something the operator would want to hear about (an open position',
    '  near its stop or reaching 1R, a level they asked about). Say that you started it.',
    '- write_note only when you learned something worth keeping for later today (a level that held, what you',
    '  are waiting for) — in the same round as your reads. It is your private memo, NEVER the answer.',
    '- A watch can only wake you to TALK — you still cannot trade; orders stay with the auto-trader.',
    '',
    `Active watches (${active.length}):`,
    ...(active.length ? active.map((w) => `- #${w.id} ${w.label} — ${w.lastCheckNote ?? 'not checked yet'}`) : ['- none']),
    '',
    "Your notebook today (oldest first — your own earlier notes, facts at that time):",
    ...(notes.length ? notes.map((n) => `- ${hhmm(n.at)} ${n.text}`) : ['- (empty)']),
  ].join('\n');
}
