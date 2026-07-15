# Lesson 05 — The AI

The AI has exactly two jobs, and it does them once per 5-minute cycle:

1. **Decide** — look at the scanner's picks and any open position, and choose:
   enter, hold, tighten a stop, exit, or do nothing.
2. **Explain** — write the **trade commentary**: a short, plain-English note on
   what the market is doing and why it acted (or didn't).

## One brain per cycle — never two

Each cycle gets exactly **one** AI analysis. When the auto-trade decision pass
runs, the note it writes IS the commentary for that cycle. The standalone
commentary writer only steps in as a fallback (auto-trade off, kill switch on,
nothing to decide, or the AI call failed). This is a deliberate rule: two AIs
analyzing the same scan can disagree, and a disagreeing pair is worse than
either alone.

## How the decision pass works

The AI is given a structured briefing: today's settings and limits, the open
position (if any), the scanner's current picks with all their reasons and
plans, and fresh quotes. It then works with **tools** — small functions it may
call, such as "get a fresh quote", "place the entry order", "move the stop",
"exit now".

Here is the critical part: **every tool that touches money re-runs the safety
gates in code** (Lesson 07). The AI saying "place the order" starts a
verification, not an order. If any gate fails, the tool refuses and tells the
AI why. A confused or overconfident AI cannot spend a rupee the rules don't
allow.

The AI also cannot choose its own instrument: **only scanner picks are
tradeable**, always 1 lot, with the scanner's plan attached. Its real decision
surface is narrow on purpose: *which pick (if any), and when to get out.*

## What the commentary looks like

The commentary style is deliberately decisive and jargon-free — one or two
confident calls with explicit exits, not a wall of numbers. A real example
of the format (from 15 Jul):

> **11:00 — market leaning up, 30 of 49 names higher, but the one clean bearish
> setup still passes every gate at the buzzer.**
>
> **PATANJALI — TRADE NOW** …entry, stop, target, and the reason in plain words.

Notes are stored in the `trade_commentary` table and shown on the
**/trade-commentary** page; they're also broadcast to Telegram (Lesson 09).

## Which AI models are used

Two providers are wired in, selectable in settings:

- **Azure OpenAI** — proven tool-calling behavior.
- **MiMo** — a reasoning model (thinks step-by-step before answering); needs a
  generous token budget.

The exact instructions (the "system prompt") given to the AI are **versioned**:
every time the prompt text changes, a new version is recorded in the
`prompt_versions` table, and every commentary row records which version wrote
it. You can read the full prompts on the **/prompts** page. The code is always
the source of truth for prompts — the database is history, never an override.

## What if the AI is down?

Trading safety never depends on the AI being up:

- The **position guard** (deterministic code) runs BEFORE the AI every cycle —
  stops, targets, and the 15:12 square-off fire with or without an AI.
- No AI = no new entries that cycle (entries need a proposal). Fail-closed:
  when in doubt, do nothing.

## The AI's limits, summarized

| Question | Answer |
| --- | --- |
| Can it pick a stock the scanner didn't? | No |
| Can it trade 2 lots because it's confident? | No — always 1 lot |
| Can it widen a stop to "give the trade room"? | No — stops only tighten |
| Can it enter at 11:05 because the setup is great? | No — window ends 11:00 |
| Can it skip all picks and do nothing? | Yes — and often should |

## Under the hood — the code behind this lesson

| Concept | Method (file) | What it does |
| --- | --- | --- |
| One decision cycle | `runAutoTradePass()` in `lib/auto-trade/engine.ts` | Orchestrates the pass: position guard first, then the AI conversation; also prevents two passes overlapping |
| The AI's briefing | `buildInitialDecisionContext()` in `lib/auto-trade/tools/execute.ts` | Assembles settings, limits, open positions, scanner picks, and fresh quotes into the structured context the AI reads (helpers: `buildAccountState()`, `buildScanContext()`, `buildOpenPositionsContext()`) |
| Running a tool call | `executeAutoTradeTool()` (same file) | The dispatcher: when the AI calls a tool, this runs it — and every money-touching tool re-runs the gates in code before acting |
| The tool list | `lib/auto-trade/tools/defs.ts` | The fixed menu of what the AI may call — nothing else exists for it |
| Talking to the AI | `lib/auto-trade/decision/providers.ts` | Two loops: Azure OpenAI (Responses API) and MiMo (chat-completions). Same tools, same rules |
| The AI's instructions | `lib/auto-trade/decision/system-prompt.ts` | The auto-trader prompt; it reuses the commentary's writing rules verbatim so there's ONE source of truth for style |
| Fallback commentary | `runAndStoreCommentary()` → `generateCommentary()` in `lib/ai-commentary/run.ts` / `generate.ts` | The standalone narrator (prompt: `COMMENTARY_SYSTEM`) used only when the auto-trade pass didn't produce a note |
| Prompt history | `lib/prompts/store.ts` | Auto-records a new version whenever the prompt text changes; read-only history behind the /prompts page |

There's no hidden maths in this layer — deliberately. The AI's inputs are the
scanner's numbers (Lesson 04) and its actions are bounded by the gates'
arithmetic (Lesson 07). The AI contributes judgment, not calculations.

One implementation detail worth knowing: MiMo is a *reasoning* model — it
"thinks" in tokens before answering, so the code gives it a generous token
budget and reads its final answer field. Every pass records its token usage
in `auto_decisions`, so the cost of every decision is visible.

---

**Next:** [Lesson 06 — How a Trade Happens](06-how-a-trade-happens.md) — a real
trade, minute by minute.
