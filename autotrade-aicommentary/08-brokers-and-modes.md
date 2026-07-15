# Lesson 08 — Brokers and Modes

## The four modes

Auto-trade has a mode setting on the **/auto-trade** page. It starts at `off`
and must be deliberately changed:

| Mode | What happens | Real money? |
| --- | --- | --- |
| **off** | Nothing trades. The scanner and commentary still run. | No |
| **paper** | Full simulation: the AI decides, gates verify, "fills" happen at the real live market premium at that moment. | No |
| **approval** | The AI proposes REAL orders, but each one waits on the /auto-trade page for a human to tap **Approve**. The approval re-runs all gates against a fresh quote before sending. Proposals expire after 15 minutes. | Yes — with a human key on every order |
| **live** | Fully autonomous real orders. Requires the two-key rule (mode setting + server environment variable). | Yes |

**Paper mode is not a toy** — it exercises the entire pipeline (data → scanner
→ AI → gates → fills → guard → records) with only the final broker call
simulated. Its fills use real quotes; if no quote exists, the fill fails
rather than inventing a price. That's why weeks of paper results are
meaningful evidence.

## The brokers

Two brokers are wired in, through a common adapter interface
(`lib/auto-trade/brokers/`):

- **Fyers** — orders via the official `fyers-api-v3` SDK.
- **Dhan** — orders via direct REST calls to their v2 API.
- **Paper** — the simulator adapter, same interface, fills from live quotes.

One broker is active at a time (a setting). Two rules keep multi-broker life
sane:

1. **Exits always route to the venue the trade opened on.** A trade opened on
   Fyers is closed on Fyers, even if the active-broker setting changed midday.
2. **Every order carries an idempotency key** — a unique fingerprint generated
   when the order is created. If the app retries after a timeout, the broker
   adapter recognizes the fingerprint and will not double-place.

## The path of a real order

```text
AI calls place_entry_order
  → gates re-verified in code (Lesson 07)
  → order row written to the database FIRST (with its idempotency key)
  → broker adapter sends it
  → broker's answer (accepted / rejected / fill price) recorded on that row
  → position guard takes over monitoring
```

Writing the record *before* sending means a crash can never leave an order
the app doesn't know about — on restart, unreconciled orders are checked
against the broker.

## An honest warning label

The real Fyers/Dhan **order** APIs are fully wired but have not yet been
exercised against a live account (everything so far has been paper). The
standing instruction — it's also on the /reminders page — is: **the first
approval/live order must be watched manually end-to-end**, with the broker
terminal open, confirming the app's recorded fill matches the broker's.

## Token & login plumbing (why nobody logs in every morning)

Both brokers need fresh daily access tokens. The poller mints them
automatically between 08:40 and 09:15 IST using stored credentials + TOTP
(Lesson 03) and stores them on disk. The **/fyers** and **/dhan** pages show
token status chips, and a health widget surfaces the result of the morning
warm-up. If both were down, trading simply fails closed — no tokens, no
orders.

## Under the hood — the code behind this lesson

| Concept | Method / file | What it does |
| --- | --- | --- |
| One shape for all brokers | `lib/auto-trade/brokers/adapter.ts` | The common interface every venue implements: place order, check status, get funds |
| The venues | `fyers-adapter.ts`, `dhan-adapter.ts`, `paper-adapter.ts` (same folder) | Fyers via the official SDK, Dhan via direct REST, paper via live quotes — swappable because they share the interface |
| The order fingerprint | `correlationIdForOrder(idemKey)` in `lib/auto-trade/execution.ts` | Hashes the order's unique idempotency key (SHA-256, first 19 chars, prefixed `R`) into the tag sent to the broker — the same order always produces the same tag, so a retry is recognizable, never a duplicate |
| Crash recovery | `reconcileUnresolvedOrders()` (same file) | On restart, asks the broker about any order with no recorded final answer |
| The mode & settings | `lib/auto-trade/settings.ts` | Every setting is parsed with a clamp (e.g., square-off can only be set between 14:00 and 15:20) — even the settings screen can't configure something unsafe |

The only maths in this layer is the fingerprint: `hash(idemKey)` is
deterministic, so "same intent → same tag" — that single property is what
makes network retries safe.

---

**Next:** [Lesson 09 — Record-Keeping and Review](09-record-keeping-and-review.md)
— how everything is written down and graded.
