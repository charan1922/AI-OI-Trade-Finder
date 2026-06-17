# Trade Assistant — How It Works (Manager Briefing)

A plain-English guide to the AI concepts behind the **Trade Coach** chatbot, mapped to the
exact code. Read top-to-bottom; it doubles as your talking script.

---

## 1. The 30-second pitch

> "It's a chat assistant that explains our TradeFinder trades in plain English. The key thing:
> **it can't make up numbers.** It's only allowed to answer using data it fetches from our own
> database through a small set of approved functions — and it shows that data under every answer
> so anyone can verify it. We use Azure OpenAI, so the data stays inside our Azure tenant."

Three selling points: **grounded (no hallucination) · auditable (shows its data) · private (our Azure).**

---

## 2. Live demo script (2 minutes)

1. Open the sidebar → **Trade Assistant**.
2. Click **"Explain a trade"**. Say: *"I asked a plain-English question."*
3. While it answers, point at the answer: *"It wrote a verdict, evidence, and a plain summary."*
4. Point at the **Supporting Data** card: *"These are the real numbers it pulled from our DB —
   bias, OI buildup, P&L. The prose above must match this; it can't invent figures."*
5. Expand **Data sources**: *"This logs exactly which functions it called — full audit trail."*
6. Type a follow-up like *"what does oi_level mean?"* → *"It also teaches the concepts to beginners."*

---

## 3. The AI concepts (the part to understand)

### A. The LLM (the "brain")
A **Large Language Model** is a system trained to predict and generate text. We don't run our own —
we call **Azure OpenAI** (OpenAI's models hosted inside Microsoft Azure). We send it a question, it
sends back words.
- *Why Azure:* data stays in our Azure subscription (compliance/privacy), with enterprise SLAs.
- **Code:** `azure-client.ts` — builds the connection from 3 secrets (key, instance, deployment).

### B. The system prompt (its "job description")
Before the user's question, we send the model a fixed instruction block: who it is, its rules
("never invent numbers"), and how to format answers (verdict → evidence → meaning), plus "explain
terms for beginners."
- *Analogy:* an employee handbook the model re-reads on every question.
- **Code:** `system-prompt.ts`.

### C. Function calling / "tools" — **the core idea**
This is the concept to emphasize. We give the model a menu of **functions it's allowed to call**
(not the database itself). When asked about a trade, the model doesn't guess — it replies *"call
`get_trade_context(PNBHOUSING, 2026-05-29)`."* Our code runs that function, fetches the real numbers,
and hands them back. The model then writes its answer **from those numbers**.
- *Analogy:* a financial advisor who isn't allowed to quote figures from memory — they must look
  every number up in the official system first. We gave them three read-only "lookups":
  - `list_trades` — find/list trades.
  - `get_trade_context` — pull one trade's full data.
  - `rank_trades` — rank trades by a metric (OI buildup, OI level, P&L) and return the top N.
- **Code:** `tools.ts` (the menu + what each does), `trade-data.ts` (the actual DB lookups).

### D. Grounding (why it won't hallucinate)
"Hallucination" = an AI confidently stating something false. We prevent it structurally: the model
**never sees the raw database** and is told every figure must come from a tool result. So the worst
case is "I don't have that data," not a made-up number. The **Supporting Data** card displays the
exact tool output, so the prose is checkable against it.
- *Business line:* "Trust comes from architecture, not hope — it's wired so it can't fabricate."
- **Code:** the rule lives in `system-prompt.ts`; the data path in `trade-data.ts`; the proof panel
  in `_components/supporting-data.tsx`.

### E. The agent loop (OpenAI **Responses API**)
The back-and-forth is automated: **ask → (model requests a tool) → we run it → give result back →
model answers.** Sometimes it takes a couple of rounds. We cap the rounds so it can't loop forever.
This "decide-act-observe" cycle is what people mean by an **AI agent**.
- **Code:** `assistant.ts` — the loop. `app/api/ai-assistant/chat/route.ts` — the endpoint the page calls.

### F. One real-world nuance (good to mention — shows depth)
Our model is a **reasoning model** (it "thinks" in hidden steps before answering). The API requires
us to pass those thinking-steps back alongside each tool call — we handle that in the loop. *Takeaway
for the manager:* "we adapted to the model's requirements; it's production-correct, not a toy."

### G. Transparency
Every answer shows: (1) the **Supporting Data** card (the numbers) and (2) a **Data sources** log
(which functions ran, with arguments). Nothing is a black box.
- **Code:** `_components/supporting-data.tsx`, `_components/tool-trace.tsx`.

---

## 4. How a question flows (draw this on the whiteboard)

```
  User: "Explain the PNBHOUSING trade"
        │
        ▼
  Web page  ──POST──►  /api/ai-assistant/chat
                              │
                              ▼
                   Azure OpenAI (the LLM)  ◄── system prompt + tool menu
                              │
              "I need data" → calls get_trade_context(PNBHOUSING, 29 May)
                              │
                              ▼
                   our code runs the tool ──► reads OUR database
                   (loadAllTFTrades + getDailyContext)  → real numbers
                              │
              numbers handed back to the model
                              │
                              ▼
                   model writes the answer FROM those numbers
                              │
                              ▼
  Web page shows: answer  +  Supporting Data card  +  Data sources log
```

The one sentence: **"The model decides *what data it needs*, our code *fetches it from our DB*, and
the model *explains it* — it never invents figures."**

---

## 5. Code tour (the order to show files)

| # | File | One line to say |
|---|------|-----------------|
| 1 | `system-prompt.ts` | "Its rules — including 'never invent numbers'." |
| 2 | `tools.ts` | "The three functions it's allowed to call (the menu)." |
| 3 | `trade-data.ts` | "Those functions read OUR validated data — the only source of numbers." |
| 4 | `assistant.ts` | "The loop: ask → call tool → feed data back → answer." |
| 5 | `azure-client.ts` | "How we connect to Azure OpenAI (3 secrets)." |
| 6 | `app/api/ai-assistant/chat/route.ts` | "The web endpoint the chat page calls." |
| 7 | `app/trade-assistant/` | "The chat UI + the Supporting Data / Data sources panels." |

Everything server-side lives in one folder — `lib/ai-assistant/` — by design.

---

## 6. Questions your manager will likely ask

**"Can it give wrong/made-up answers?"**
It can't invent *numbers* — those only come from our DB via the tools, and we show them. It could
phrase an interpretation poorly, but the figures are always real and visible for checking.

**"Does our data leave the company / train OpenAI?"**
We use **Azure OpenAI** — runs in our Azure tenant; Azure does not use our prompts to train models.
Only the specific trade fields a question needs are sent.

**"What does it cost?"**
Pay-per-use by amount of text (tokens). Each answer is small (a question + a few numbers + a short
reply) → fractions of a cent. No idle/server cost when nobody's chatting.

**"Can it place trades / move money?"**
No. Its only abilities are the three **read-only** lookups. It cannot trade, write, or delete anything.

**"How hard to extend (more data, live prices)?"**
Add a new function to `tools.ts` + its data fetch in `trade-data.ts`. The model picks it up
automatically. Planned next: a searchable trade picker and a live market-day snapshot tool.

**"What if Azure/the model is down?"**
The endpoint fails gracefully with a clear message; the rest of the app is unaffected. It's an
add-on, not a dependency of core features.

---

## 7. One-line glossary

- **LLM** — an AI that generates text from a prompt.
- **Azure OpenAI** — OpenAI models hosted privately in our Azure account.
- **Prompt / system prompt** — the instructions we send the model.
- **Token** — a chunk of text (~¾ of a word); billing + size unit.
- **Function calling / tools** — letting the model request approved functions instead of guessing.
- **Grounding** — forcing answers to come from real fetched data (anti-hallucination).
- **Hallucination** — an AI stating something false confidently (what grounding prevents).
- **Agent / agent loop** — model decides an action → we run it → it observes the result → repeats.
- **Responses API** — OpenAI's interface that supports this tool-calling loop.
- **Reasoning model** — a model that works through hidden steps before answering.
