# Function Calling — Explained with Our Code

A focused walkthrough you can present. We trace ONE real request end-to-end:

> **"Explain the PNBHOUSING trade on 29 May 2026"**

---

## What "function calling" is (say this first)

> A language model only produces **text**. By itself it can't read our database — so if you just
> asked it about a trade, it would *guess*. **Function calling** fixes that: we give the model a
> **menu of functions it's allowed to call**. Instead of guessing, the model reads the question and
> replies *"please run `get_trade_context` with symbol=PNBHOUSING, date=2026-05-29."* **Our code**
> runs that function against our database and hands the real numbers back. The model then writes its
> answer **from those numbers**.

**The model decides *which* function and *with what arguments*. Our code does the actual work.**
The model never touches the database — it only *requests*.

The clever part: the model turned a plain English sentence — *"the PNBHOUSING trade on 29 May 2026"*
— into **structured arguments** `{ symbol: "PNBHOUSING", date: "2026-05-29" }`. That translation is
what function calling buys us.

---

## The 7-step flow (follow the code)

### Step 1 — You ask. The page sends the question to our server.
**File:** `app/trade-assistant/_hooks/use-chat.ts`
```ts
await fetch('/api/ai-assistant/chat', {
  method: 'POST',
  body: JSON.stringify({ message: 'Explain the PNBHOUSING trade on 29 May 2026.', history }),
});
```

### Step 2 — Our API endpoint hands it to the orchestrator.
**File:** `app/api/ai-assistant/chat/route.ts`
```ts
const result = await runAssistant(message, history);   // returns { reply, toolTrace }
```

### Step 3 — We OFFER the model its menu of functions.
This is the heart of function calling: the **tool definitions**. Each one is just a name + a
description + the shape of its arguments (a JSON schema). This is what the model "sees."
**File:** `tools.ts`
```ts
{
  type: 'function',
  name: 'get_trade_context',
  description: 'Get the full data-backed context for ONE trade... ALWAYS call this before explaining a specific trade.',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Stock symbol, e.g. "PNBHOUSING".' },
      date:   { type: 'string', description: 'Trade date, "YYYY-MM-DD" or "29 May 2026".' },
    },
    required: ['symbol', 'date'],
  },
}
```
> Note: the **description** is how the model knows *when* to use it. Good descriptions = good tool use.

### Step 4 — Call the model. It REQUESTS a function (it doesn't answer yet).
**File:** `assistant.ts`
```ts
const res = await client.responses.create({
  model,
  instructions: SYSTEM_PROMPT,   // its rules ("never invent numbers")
  input,                         // the conversation so far
  tools: TOOL_DEFS,              // the menu from Step 3
  tool_choice: 'auto',           // model decides whether to call a tool
});
```
The model reads *"Explain the PNBHOUSING trade on 29 May 2026"* and, instead of text, returns a
**function call** — note it parsed the sentence into structured arguments:
```json
{
  "type": "function_call",
  "name": "get_trade_context",
  "arguments": "{ \"symbol\": \"PNBHOUSING\", \"date\": \"2026-05-29\" }",
  "call_id": "fc_abc123"
}
```
We detect that:
```ts
const calls = res.output.filter((o) => o.type === 'function_call');
if (calls.length === 0) return { reply: res.output_text, toolTrace };  // (no tool needed → just answer)
```

> **The one test that drives the loop:** `res.output` is a *list* of things the model produced.
> If any item is a `function_call` → run the tools and loop. If none → it's the final answer, return it.

---

## What `responses.create()` returns (the `res` object)

The whole loop hinges on reading `res`. Here's its anatomy — useful if your manager asks
"how do you know what it wants?"

| Field | What it is |
| --- | --- |
| `res.output` | **the list of items the model produced** — this is what we inspect |
| `res.output_text` | SDK shortcut: all text items glued into one string (the final answer) |
| `res.status` | how it ended: `completed` · `incomplete` · `failed` · `in_progress` |
| `res.usage` | token counts (`input_tokens`, `output_tokens`) — i.e. the cost |
| `res.error` | filled in only when `status === 'failed'` |

**`res.output` item types** (each item has a `type`):

| `type` | Meaning | We... |
| --- | --- | --- |
| `function_call` | "run this tool" — carries `name`, `arguments` (a JSON **string**), `call_id` | detect & execute |
| `message` | the assistant's text answer | read via `res.output_text` |
| `reasoning` | hidden "thinking" steps (reasoning models only) | echo back, don't display |

So a **tool request** turn vs. an **answer** turn look like:

```jsonc
// wants a tool  → calls.length > 0 → run it, loop again
[ { "type": "reasoning", ... },
  { "type": "function_call", "name": "get_trade_context", "arguments": "{...}", "call_id": "fc_abc123" } ]

// final answer → calls.length === 0 → return res.output_text
[ { "type": "message", "role": "assistant",
    "content": [ { "type": "output_text", "text": "## Verdict ..." } ] } ]
```

**`res.status` values:** `completed` (normal) · `incomplete` (hit a limit — see `res.incomplete_details`)
· `failed` (see `res.error`) · `in_progress` (streaming only; we `await` the full result, so we don't see it).

**`tool_choice` — our control over tool use:**

| Value | Meaning | Where |
| --- | --- | --- |
| `'auto'` | model decides: call a tool *or* answer | every normal round |
| `'none'` | no tools allowed — must answer in words | the safety net (last call) |
| `'required'` | must call at least one tool | (available, unused) |
| `{type:'function', name:'…'}` | force one specific tool | (available, unused) |

### Step 5 — WE run the function against OUR database.
**File:** `assistant.ts` → `tools.ts` → `trade-data.ts`
```ts
// assistant.ts
const { result, trace } = await executeTool(call.name, JSON.parse(call.arguments));
```
```ts
// trade-data.ts — the ONLY place numbers come from (our validated pipeline)
const { trades } = await loadAllTFTrades();                  // the trade log
const ctx = await getDailyContext({ symbol, date, ... });    // OI / direction / P&L from the DB
```
It returns the real numbers:
```json
{
  "found": true,
  "trade":      { "symbol": "PNBHOUSING", "optionType": "PE", "strike": 1000,
                  "contractExpiry": "2026-06-30", "pnl": 14527, "optionReturnPct": 100 },
  "direction":  { "dataBias": "bearish", "agreesWithTrade": true, "priceChangePctTradeDay": -4.4 },
  "optionOI":   { "tradedContract": "2026-06-30", "tradeDayBuildupPct": 39.7,
                  "levelVsCycleAverage": null, "monthlyExpiryInWindow": true }
}
```

### Step 6 — We hand the result back and ask the model again.
**File:** `assistant.ts`
```ts
input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
// loop: call client.responses.create(...) again, now WITH the data in hand
```
This time the model has the numbers, so it returns **text** (no function call) → the loop ends:
```ts
if (calls.length === 0) return { reply: res.output_text, toolTrace };
```

### Step 7 — The page shows the answer + the data it used.
The reply is rendered, and the tool's result (`trace.data`) becomes the **Supporting Data** card —
so the prose can be checked against the exact numbers.
**Files:** `app/trade-assistant/_components/message-bubble.tsx`, `supporting-data.tsx`, `tool-trace.tsx`

---

## The loop, in one picture

```
  "Explain the PNBHOUSING trade on 29 May 2026"
        │
        ▼
  ask model  (+ tool menu, + rules)
        │
        ▼
  model: "call get_trade_context(symbol=PNBHOUSING, date=2026-05-29)"   ← function CALL (not an answer)
        │
        ▼
  OUR code runs it → reads OUR DB → { bias: bearish, OI buildup: +39.7%, P&L: ₹14,527, ... }
        │
        ▼
  hand the data back → ask model again
        │
        ▼
  model now writes the ANSWER from that data  ──►  shown with a Supporting Data card
```

---

## Three points to land with your manager

1. **It can't make up numbers.** Figures come *only* from `get_trade_context` reading our DB. The
   model just requests and explains. (Architecture, not luck.)
2. **The model translates English → a precise function call.** "the PNBHOUSING trade on 29 May" →
   `{symbol:"PNBHOUSING", date:"2026-05-29"}`. That's the skill function calling gives us.
3. **It's a controlled menu.** Only three read-only lookups exist (`tools.ts`: `get_trade_context`,
   `rank_trades`, `list_trades`). The model can't do anything we didn't put on the menu — no writes,
   no trades, no arbitrary DB access.

> Closing line: *"Function calling is how we let a text model use our real systems safely — it asks,
> our code acts, and every answer is backed by data we can show."*
