# Commentary v2 Implementation Plan

> **For agentic workers:** executed inline in the authoring session (operator: "self review and plan, then develop"). Steps use checkbox syntax for tracking.

**Goal:** Ship `/trade-commentary-v2` — background watches that wake the chat AI to speak first, a day notebook, and a Claude-style thread built from all 26 AI Elements patterns.

**Architecture:** A 60 s in-process watch loop (own lease, autonomous server only) evaluates typed watches with a pure evaluator over SQLite reads, queues fired ones, and drains the queue into one capped AI turn through the existing `runToolLoop` when the trader is idle. The chat route gains watch/notebook tools only when the `chat_background` switch is On. The v2 page composes 27 hand-written AI Elements components over existing APIs plus one new admin-only background API.

**Tech Stack:** Next.js 16.4 App Router, React 19, Prisma raw SQLite, `radix-ui`, `lucide-react`, Tailwind 4, openai SDK via `runToolLoop`.

## Global Constraints

- No new third-party packages (CLAUDE.md; operator rule).
- v1 `/trade-commentary` unchanged except a `v1 | v2` switch.
- Background default Off; Off ⇒ chat tools/framing identical to today.
- Wake-up never while `isAutoTradePassRunning()` or `getFyersPollerStatus().captureRunning`.
- Cap: 20 AI wake-ups / IST day, ≥ 5 min apart; ≤ 10 active watches; expire 15:30 IST.
- Woken turn: no order tools. Missing/stale data ⇒ watch does not fire.
- Operator 2026-10-29: no new test script. Gate = lint, typecheck, typecheck:scripts, existing verify scripts, build.
- Never `prisma db push --accept-data-loss`; new tables are runtime-created and mirrored in `schema.prisma`.
- Don't run prettier on existing files; hand-match surrounding style.

## File map

| File | Responsibility |
|---|---|
| `lib/operator-chat/background-store.ts` (new) | tables `chat_background`, `chat_watches`, `chat_notebook`, `chat_wakeups` + CRUD |
| `lib/operator-chat/watches.ts` (new, pure) | kinds, param validation, `evaluateWatch`, labels, cap math |
| `lib/operator-chat/watch-inputs.ts` (new) | loads spot/trades/TF/sideways inputs for a set of watches |
| `lib/operator-chat/background-tools.ts` (new) | `start_watch`/`cancel_watch`/`write_note`/`list_watches` defs + executor, framing block |
| `lib/operator-chat/wake.ts` (new) | runs one woken turn, stores it, alerts, fallback |
| `lib/operator-chat/watch-loop.ts` (new) | 60 s loop, lease, evaluation, queue, drain, status |
| `lib/operator-chat/reply.ts` (mod) | optional extra tools + framing; returns meta |
| `lib/operator-chat/store.ts`, `format.ts` (mod) | `wakeJson`, `metaJson` columns/fields |
| `app/api/trade-commentary/chat/route.ts` (mod) | background tools/framing when On; store meta |
| `app/api/trade-commentary/chat/background/route.ts` (new) | GET state, POST toggle/start/cancel |
| `lib/fyers/poller.ts` | NOT modified — `watch-loop.ts` mirrors its `isAutonomousServer` gate and reads `getFyersPollerStatus()` |
| `instrumentation.ts` (mod) | start the watch loop |
| `prisma/schema.prisma` (mod) | mirror new tables/columns |
| `components/ai-elements/*.tsx` (new, 26) | the patterns |
| `app/trade-commentary-v2/**` (new) | page, hooks, panels |
| `components/app-sidebar.tsx` (mod) | "Commentary v2" entry |
| `app/trade-commentary/page.tsx` (mod) | `v1 | v2` switch only |
| `CLAUDE.md` (mod) | short section on v2 / background rules |

## Tasks

- [x] **1. Storage** — `background-store.ts` (guarded CREATE/ALTER like `store.ts`), `wakeJson`/`metaJson` columns in `operator_chat`, schema mirror.
  Produces: `isBackgroundEnabled()`, `setBackgroundEnabled(b)`, `listWatches(date)`, `insertWatch(w)`, `updateWatch(id, patch)`, `addNote(date,text)`, `listNotes(date, n)`, `recordWakeup(w)`, `listWakeups(date)`.
- [x] **2. Pure watch model** — `watches.ts`: `WATCH_KINDS`, `parseWatchParams(kind, raw) → {ok, params, label} | {ok:false, error}`, `evaluateWatch(w, inputs, nowMin)`, `canWakeNow(wakeups, nowMs)`.
- [x] **3. Inputs + tools + wake + loop** — `watch-inputs.ts`, `background-tools.ts`, `wake.ts`, `watch-loop.ts`; start in `instrumentation.ts`.
- [x] **4. Chat route + reply** — `replyToOperator` takes `extraTools`/`executeExtra`, returns `meta`; route adds background framing/tools when On and stores `metaJson`.
- [x] **5. Background API** — GET/POST under `/api/trade-commentary/chat/background` (admin prefix already covers it).
- [x] **6. AI Elements** — 26 components in `components/ai-elements/`.
- [x] **7. v2 page** — hooks + layout composing every component; sidebar entry; v1 switch.
- [x] **8. Gate** — lint, typecheck, typecheck:scripts, `verify-operator-chat.ts` + other workflow verify scripts, build; dev-server look at the page; CLAUDE.md note.
