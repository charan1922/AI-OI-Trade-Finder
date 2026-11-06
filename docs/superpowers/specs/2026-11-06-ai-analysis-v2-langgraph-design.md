# AI Analysis v2 — standalone LangGraph agent (supersedes the 2026-10-29 Commentary v2 design)

Date: 2026-11-06 · Status: decisions taken by the operator in chat (all four "recommended")

## Why

Commentary v2 (v1.71.0–v1.71.2) was built INTO v1: it changed 38 shared files — v1's chat route, page,
store and prompt, the sidebar, the root layout, and the auto-trader's model loop. The operator's rule is
"v1 and v2 independent, no relation". This rebuild undoes all coupling and rebuilds v2 as its own agent,
following the operator's reference agent (`D:\Projects\ai-backend-nodejs`, IBM i debugger + sap-triage
LangGraph): streamed steps/reasoning/answer over SSE, SKILL.md skills loaded on demand, rules-only
instructions with checks enforced in code, its own chat table, Stop.

## Decisions (operator, 2026-11-06)

1. **v1 back to exactly pre-v2** (`eb64d6e`): page, chat thread, chat route, operator-chat module, title
   "Trade Commentary", fixed suggestion pills, sidebar entry. Zero v2 traces in v1.
2. **LangGraph graph + our MiMo client**: `@langchain/langgraph` + `@langchain/core` (versions ≥ 2 weeks
   old). Model calls stay on the `openai` SDK because MiMo thinking mode requires `reasoning_content` to be
   replayed on every later request (400 otherwise).
3. **No link to the auto-trader's chat channel**: the trader never reads v2 messages. v2 acts only through
   its own gated actions (which call `lib/auto-trade` directly, not v1's action module).
4. **Two sidebar entries, no toggle**: "Trade Commentary" (v1) and "AI Analysis v2". The `COMMENTARY_V2`
   Settings toggle and the v1|v2 links are removed. v2's background runs only by v2's own switch.

## What reverts

v1 files restored to `eb64d6e`: `app/trade-commentary/**`, `app/api/trade-commentary/chat/route.ts`
(+ the v2 sub-routes under it removed), `lib/operator-chat/{store,format,reply,app-data}.ts` (+ every v2 file
in that folder moved out), `lib/ai-assistant/system-prompt.ts`, `lib/auto-trade/decision/providers.ts`
(the trader's loop — back to pre-v2), `components/rich-text.tsx`, `app/layout.tsx`, `app/config/page.tsx`,
`lib/config/feature-toggles.ts`, `app/prompts/page.tsx`, `lib/db-explorer/tables.ts`,
`lib/telegram/commentary.ts`, `app/globals.css`, `components/app-sidebar.tsx` (then ONE new entry).

Kept (not v1, operator-requested globally): sidebar collapsed by default and the page-header slot
(`components/layout-shell.tsx`, `components/page-header-portal.tsx`); the trader's `openedAtIST` field
(a real trader bug fix — it told the operator "opened 09:40" for a 10:10 fill).

The three nullable columns v2 added to `operator_chat` (`wakeJson`, `metaJson`, `imagesJson`) stay in the
prod DB unused; the schema mirror goes back to pre-v2.

## v2 — where everything lives

- Page `app/ai-analysis-v2/` (admin-only page), styles in its own CSS file.
- API `app/api/ai-analysis-v2/*` (admin-only prefix): `chat` (GET thread, POST = SSE run), `chat/stop`,
  `action` (Confirm tap), `background`, `image`, `feed` (trader reads + cycles straight from their stores).
- Server `lib/ai-analysis-v2/*`: own thread table `ai_v2_messages`; the existing v2-only tables
  (`chat_background`, `chat_watches`, `chat_notebook`, `chat_wakeups`, `chat_memory`) move here unchanged
  (prod holds 2 saved lessons).

## The agent graph (LangGraph `StateGraph`)

```text
START → prepare → model ─(tool calls)→ tools → model …
                   └─(final text)→ review ─(needs fix, once)→ model
                                          └─(ok)→ act → END
```

- **prepare** — static instructions first (cacheable prefix), live context last (clock, background status,
  auto switches, memory, watches/notebook, latest trader read).
- **model** — MiMo via `openai`, streamed. Thinking on the first round only (45 s cap, `maxRetries: 0`);
  every later request replays `reasoning_content`. Self-heals: thinking off, then Flash. Round cap 12 →
  a final call with tools removed.
- **tools** — read-only data tools (v2's own copy of the data reader + the Trade Assistant's market tools),
  `load_skill` (SKILL.md), `update_plan`, `ask_operator`, `propose_memory`, `propose_action`, watch/notebook
  tools, and (check-ins) `notify_operator` / `schedule_next_check`.
- **review** — checks enforced in code (each asked once): the final message must be the answer, not
  bookkeeping ("Noted."); a check-in with an open position must have read the position before finishing.
- **act** — proposed actions run per the operator's per-action Auto/Ask switches through v2's own gated
  action module (every auto-trade gate re-checks; mode can never go live from chat). In chat the answer row is
  reserved before the run, so `act` runs the actions in the graph. A headless turn (watch wake-up or check-in)
  posts its message after the run, so `wake.ts` applies the proposals once the message is in the thread: each
  result then sits under the reason for it.

Streaming: nodes write events with LangGraph's custom stream (`config.writer`); the chat route forwards them
as SSE: `run`, `step`, `step_done`, `reasoning`, `delta`, `plan`, `question`, `action`, `done`, `error`.
Stop aborts the run's `AbortSignal` (the in-flight model call stops at once).

Persistence (as the reference): the question and an empty answer row are saved first; the answer row is
filled at the end with its details (steps, reasoning, plan, tools, actions, tokens); a failed or stopped run
is saved as partial with its reason.

Background (unchanged behaviour, now standalone): watches every 60 s, self-paced check-ins (5–30 min; every
5 min with an open position; quiet by default), wake-ups — all run the same graph headless, only while v2's
own Background switch is ON, never while the trader's pass or capture runs.

## Not in scope

No change to the auto-trader's decisions, gates or prompts. No new tests (operator 2026-10-29); the gate is
lint, typecheck, typecheck:scripts, every CI verify script, build, plus real runs against MiMo.
