# Commentary v2 — background watches + a Claude-style thread

Date: 2026-10-29 · Status: approved in chat (operator), self-reviewed against the code

## Why

On 2026-10-29 the operator asked the /trade-commentary chat AI whether it wanted a continuous
connection to the market. It answered that it would — it only ever sees a snapshot when asked, never
what happened between messages — and that it "can't have it". That is a wiring gap, not a limit:
the server already watches continuously (Fyers poller every 5 min, guard loop every 5 s on open
positions). What is missing is a way for something the code sees to wake the chat AI so it can speak
first, and a memory of the day so each turn builds on the last.

The model is Claude Code's: **code watches, the model wakes up when a watch fires** (Monitor /
background tasks), the model can start its own watches, and the page shows its work (reasoning,
tools, tasks, queue) the way Claude does.

## Scope

- A new page `/trade-commentary-v2` ("Commentary v2" in the sidebar, Assistant group).
- Background watches (typed conditions checked by code), created by the operator or by the AI.
- Wake-ups: a fired watch gives the chat AI one turn; it posts first in the thread and on Telegram.
- A per-day notebook the AI writes and reads.
- An On/Off switch for all of the above, **default Off**.
- A Claude-style thread built from all 26 AI Elements patterns (mapping below), each showing real data.

## Hard constraints (carried from CLAUDE.md / operator rules)

1. **v1 stays as it is.** `/trade-commentary` is not modified except for one small `v1 | v2` switch
   at the top. With Background Off, the chat route's tools, framing and stored rows are today's.
2. **One AI analysis per cycle.** A wake-up never runs while the auto-trade pass
   (`isAutoTradePassRunning()`) or the poller's autonomous capture (`getFyersPollerStatus().captureRunning`)
   is running — it waits. It never re-analyses the scan on a schedule; it runs only when a watch fires.
3. **The chat never trades.** A woken turn has the chat reply's tools (read-only market tools,
   `read_app_data`, `propose_action` Confirm cards) plus the watch/notebook tools. No order tools.
4. **Missing evidence never counts as yes.** No fresh data → the watch does not fire; it records
   "can't check" with the reason.
5. **No new third-party packages.** The 26 components are written in-repo under
   `components/ai-elements/` on what is installed (`radix-ui`, `lucide-react`, Tailwind, `components/ui`).
   The official copies pull `ai`, `streamdown`, `shiki`, `motion`, `use-stick-to-bottom`.
6. **No LangGraph / AI SDK.** The existing provider-agnostic `runToolLoop` (azure | mimo) runs every turn.

## The switch

Table `chat_background` (single row: `id = 1, enabled INTEGER, updatedAt TEXT`), default Off.
Kept out of the auto-trade settings registry on purpose: that registry is the money module's.
Toggled from v2 (admin-only API). Off → watches are not evaluated, no wake-ups, and the chat route
gets no watch/notebook tools (v1 behaves exactly as today). Existing watches stay listed, paused.

## Watches

Table `chat_watches`: `id, date, kind, paramsJson, label, createdBy ('operator'|'ai'), status,
createdAt, firedAt, firedDetail, lastCheckedAt, lastCheckNote`.

`status`: `watching` → `fired` | `cancelled` | `expired`. A watch fires once. All watches expire at
15:30 IST on their date. At most **10** `watching` per day.

Closed set of kinds, each checked exactly by code. A request that fits none is refused and the AI
must say so:

| kind | params | source |
|---|---|---|
| `price_cross` | symbol, level, `above`/`below` | `latestSpotRead()` — latest 5-min close in `fyers_candles`, fresh only |
| `position_r` | symbol, r | open `auto_trades` row; R = direction-aware (spot − entrySpot) / \|entrySpot − slSpot\| |
| `near_stop` | symbol, withinPct (default 0.3) | open `auto_trades` row; spot vs current `slSpot` |
| `tf_top` | symbol, `joins`/`leaves` | `getTfSnapshot()`, rank ≤ `TF_RACE_MAX_RANK`, age ≤ `TF_BOARD_MAX_AGE_MIN` |
| `market_sideways` | `stuck`/`not_stuck` | `loadMarketSideways()`; `stuck: null` → can't check |
| `board_stale` | — | TF board age > `TF_BOARD_MAX_AGE_MIN` |
| `time` | HH:MM IST | clock |

Validation at creation: `price_cross` needs a fresh close and a level within ±10% of it;
`position_r`/`near_stop` need an open trade on that symbol; `tf_top` needs a fresh board.

**Cadence (honest):** one in-process loop (`lib/operator-chat/watch-loop.ts`) ticks every **60 s**
during market hours on the autonomous server (same `AUTONOMOUS_SERVER` gate as the trader; a lease
`chat-watch-loop` keeps it to one process). Prices come from 5-min candles, so a price/position watch
can only change every 5 min — the page says "checked every 60s · prices update every 5 min".
The loop touches no trading code and makes no broker calls (SQLite reads only, plus
`loadMarketSideways` only when a sideways watch exists — it caches per 5-min bucket).

Evaluation is one pure function `evaluateWatch(watch, inputs, nowMin) → { fired: boolean | null; note }`
in `lib/operator-chat/watches.ts`.

## Wake-ups

Table `chat_wakeups`: `id, date, at, watchIdsJson, outcome ('ai'|'fallback'|'capped'), messageId,
detail`.

1. Fired watches are marked `fired` and queued (in-process).
2. The queue drains only when the pass/capture are idle (constraint 2).
3. **Cap in code:** 20 AI wake-ups per IST day, ≥ 5 min apart. Everything that fired since the last
   wake-up is merged into one. Past the cap, code posts a plain note and still sends Telegram.
4. The woken turn runs the chat reply path with framing: what fired (with each watch's note), today's
   notebook, open watches, and the latest trader read. Stored as an assistant row in
   `operator_chat` with `wakeJson` (watches that woke it) and `metaJson` (model-call spans, tokens,
   duration).
5. Telegram via `sendAlert()`.
6. AI error → plain fallback message with the error, outcome `fallback`, Telegram still sent.

## Notebook

Table `chat_notebook`: `id, date, at, text` (≤ 300 chars). Written by the AI with `write_note`; the
last 12 notes of the day go into every turn's framing (Background On only).

## New AI tools (Background On only)

`start_watch {kind, symbol?, level?, direction?, r?, withinPct?, event?, to?, at?, label}`,
`cancel_watch {id}`, `write_note {text}`, `list_watches {}`.

## Message meta

Every assistant reply (Background On or Off — the meta is an audit record, never replayed) also
stores `metaJson`: `{ ms, spans: [{name, ms}], promptTokens, completionTokens }`. v1 ignores it.

## v2 page — all 26 AI Elements patterns, each on real data

| Pattern | Used for |
|---|---|
| Conversation | the day thread (trader reads + chat + wake-ups), sticks to bottom |
| Message | every row; user / AI / trader-read / wake-up variants |
| Prompt Input | the composer |
| Attachments | attach context chips (an open position, a watch, a TF pick) to a message — sent as text |
| Suggestion | quick prompts |
| Shimmer | "thinking…" while a reply is in flight |
| Reasoning | "Thought for Xs" — model-call time from `metaJson` (MiMo/Azure return no reasoning text) |
| Chain of Thought | the steps of a turn: woke because → model calls / tools in order → replied |
| Tool | each tool call (label, ok, summary) from the audit record |
| Sources | the data sources a reply read |
| Inline Citation | numbered source chips with hover detail at the end of a reply |
| Confirmation | Confirm cards (existing action endpoint) |
| Context | per-reply token usage + today's wake-ups used / 20 |
| Model Selector | the chat/decision AI (azure / mimo) — changes `aiProvider` via `/api/auto-trade/settings` after a confirm |
| Agent (Subagent) | the two background agents: Auto-trader (mode, entries, open lots) and Watcher (loop status) |
| Task | each watch with its status and last check |
| Queue | wake-ups today (time, outcome, what woke it) |
| Plan | today's session plan (race 09:35, entries 09:45–11:00, square-off 15:12, close 15:30) with done/now/next |
| Checkpoint | thread dividers at session milestones the thread crosses |
| Question | pending approvals — Approve / Reject (existing `/api/auto-trade/action`) |
| Trace (commit) | the trader's per-cycle timeline (`cycle_timelines`) |
| Test Results | the selector's checks per TF name now (`/api/tf/race` → scan verdicts) |
| Stack Trace | failures: failed cycle steps, wake-up fallbacks |
| Code Block | a watch's exact definition (kind + params JSON) |
| Terminal | live tail of the watcher's server log lines (`/api/logs`) |
| File Tree | today's workspace: watches / notebook / wake-ups, click to jump |

Data (all existing or new admin-only APIs): `/api/trade-commentary` (reads + timelines),
`/api/trade-commentary/chat` (thread), `/api/trade-commentary/chat/background` (new: switch, watches,
notebook, wake-ups, loop status), `/api/auto-trade` (settings, trades, pending), `/api/tf/race`,
`/api/logs`. The chat APIs are admin-only (`/api/trade-commentary/chat` prefix), so v2's thread and
panel are admin-only like v1's chat; viewers see the trader reads.

## Addendum (same day, operator feedback)

- **Agentic:** v2 sends `surface: 'v2'`; the chat gains `use_skill` (review_position, why_no_trade, explain_rejection,
  market_regime, set_up_watches, end_of_day_review, read_screenshot — each a playbook over existing tools) and
  `update_plan` (the AI's own step plan, shown as Plan in its reply). 16 tool steps for v2 chat; the trader is unchanged.
- **Screenshots:** attach or paste up to 4 images; MiMo-only; files under `data/chat-images/`.
- **MiMo only** in the v2 model picker (v2.6 Pro / Flash, the shared `mimoModel` setting).
- **No static pills** in v1 or v2; v2 suggestions come from live state only.
- **No made-up UI:** session times come from the server; markers only on days with a trader read; missing times omitted.
- App sidebar collapsed by default; the v2 title lives in the app header (`PageHeaderPortal`).
- `/config` toggle `COMMENTARY_V2` picks which page the sidebar opens (default v1).
- v2 chat + wake-ups use their own MiMo model, default `mimo-v2.6-flash`; the trader's model is separate.
- **Telegram removed from wake-ups** for now — the thread is the only channel (supersedes the Telegram lines above).
- Phones: one pane at a time (Chat | Background switch); lg+ shows both.

## Verification

Operator instruction 2026-10-29: no new test script for this. Gate = `pnpm lint`, `pnpm typecheck`,
`pnpm typecheck:scripts`, the existing CI verify scripts (notably `verify-operator-chat.ts`, which
pins the chat contract), `pnpm build`, and a manual check of `/trade-commentary-v2` in dev.

## Rollout

Ship with Background Off. The operator turns it on from v2. Judge it by `chat_wakeups` over a few
sessions.
