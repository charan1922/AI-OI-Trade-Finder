/**
 * The single server-side choke point for Dhan Quote-API traffic.
 *
 * Dhan allows ~1 Quote request/sec per account, and a burst does not merely get
 * rejected — it trips a penalty box that keeps 429-ing even compliant traffic.
 * Every Quote call therefore runs one-at-a-time, spaced ≥ QUOTE_MIN_INTERVAL_MS
 * apart, and a 429 trips an escalating cooldown that pauses ALL quote traffic so
 * the penalty box can clear instead of being poked again. Option-chain requests
 * additionally observe their endpoint's own stricter sub-limit — see
 * OPTIONCHAIN_MIN_INTERVAL_MS; nothing else is slowed by it.
 *
 * State lives on globalThis (not a module `let`): Turbopack HMR re-evaluates
 * modules on every hot reload — and separate route bundles can hold their own
 * copy — which would reset or duplicate the queue. globalThis is the one thing
 * shared across all of them in a single server process. One queue, one account,
 * one rate limit.
 *
 * Deliberately dependency-free (no env, no auth, no db) so the serialisation
 * guarantees can be tested directly in CI. lib/env parses at import and throws
 * without credentials, so anything importing market-feed.ts cannot run there.
 */

export const QUOTE_MIN_INTERVAL_MS = 1500; // ~0.67 req/sec — a safety margin under 1/sec, not the boundary
const QUOTE_BACKOFF_BASE_MS = 4000; // first 429 cool-off; doubles on each consecutive 429
const QUOTE_BACKOFF_MAX_MS = 30_000; // cap the escalation

/**
 * The /v2/optionchain family has its own, stricter Dhan limit — 1 request per
 * 3 seconds — ON TOP of the shared ~1/sec budget every Quote-API call draws from.
 *
 * It is therefore a property of the ENDPOINT, not of a caller's priority: every
 * option-chain call site opts in with `{ optionChain: true }` — foreground and
 * low-priority alike — so all of them both RESPECT and STAMP the same clock. An
 * earlier cut enforced this only on the low-priority path, which left the live
 * foreground option-chain callers (index greeks, expiry list) neither reading nor
 * stamping it: a shadow chain could still dispatch 1.5s after one of them and
 * trip the very 429 whose cooldown then pauses ALL quote traffic, money path
 * included.
 *
 * Enforced here rather than by each caller's own timer because a caller can only
 * stamp "when I asked to go", not "when the gate actually let me go" — and this
 * gate's own queueing/backoff waits can push the real dispatch out far enough
 * that two actual option-chain calls land under 3s apart even though the caller
 * intended more spacing between them.
 *
 * Callers that pass no flag — marketfeed/quote and marketfeed/ohlc, i.e. the
 * live-quote money path — are completely unaffected: the term drops out of the
 * dispatch-target Math.max and their spacing stays exactly QUOTE_MIN_INTERVAL_MS.
 */
export const OPTIONCHAIN_MIN_INTERVAL_MS = 3200;

/** Per-call gate options. */
export interface QuoteGateOptions {
  /** True for a /v2/optionchain-family request, which carries the stricter
   *  OPTIONCHAIN_MIN_INTERVAL_MS sub-limit in addition to the shared spacing. */
  optionChain?: boolean;
}

/** How long low-priority work waits for a quiet gate before giving up. */
export const LOW_PRIORITY_GIVE_UP_MS = 15_000;

/**
 * Hard ceiling on a measurement-only request once dispatched. It shares the
 * serial queue with live quotes, so an unbounded shadow request would wedge the
 * queue and make a money-path quote wait behind it forever.
 */
export const SHADOW_REQUEST_TIMEOUT_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface QuoteGateState {
  /** Tail of the serial chain; each new task appends. Never rejects. */
  tail: Promise<unknown>;
  /** When the last task was dispatched (start-to-start spacing anchor). */
  lastDispatchAt: number;
  /** No task dispatches before this time — set/extended by a 429. */
  cooldownUntil: number;
  /** When the last /v2/optionchain call actually went out (real dispatch time,
   *  not a caller's pre-wait estimate). Drives OPTIONCHAIN_MIN_INTERVAL_MS. */
  lastOptionChainDispatchAt: number;
  /** Consecutive 429s; drives the exponential backoff, reset on any success. */
  consecutive429: number;
  /** Interactive/live quote callers waiting or executing. Shadow option-chain
   * work yields while this is non-zero so it cannot build a backlog ahead of
   * money-path quote reads. */
  foregroundPending: number;
}

const gateHost = globalThis as unknown as { __dhanQuoteGate?: QuoteGateState };
gateHost.__dhanQuoteGate ??= {
  tail: Promise.resolve(),
  lastDispatchAt: 0,
  cooldownUntil: 0,
  lastOptionChainDispatchAt: 0,
  consecutive429: 0,
  foregroundPending: 0,
};
const gate = gateHost.__dhanQuoteGate;
gate.foregroundPending ??= 0;
gate.lastOptionChainDispatchAt ??= 0;

/**
 * Earliest time the next dispatch may go out. Shared by both gates so the
 * foreground and low-priority paths can never drift apart on the rules.
 */
function dispatchTargetAt(optionChain: boolean): number {
  return Math.max(
    gate.lastDispatchAt + QUOTE_MIN_INTERVAL_MS,
    gate.cooldownUntil,
    // Zero for a non-option-chain call: the term cannot influence the maximum,
    // so nothing outside the option-chain family is slowed by this sub-limit.
    optionChain ? gate.lastOptionChainDispatchAt + OPTIONCHAIN_MIN_INTERVAL_MS : 0
  );
}

/** Record a real dispatch. Only an option-chain call moves the option-chain clock. */
function stampDispatch(optionChain: boolean): void {
  gate.lastDispatchAt = Date.now();
  if (optionChain) gate.lastOptionChainDispatchAt = gate.lastDispatchAt;
}

/**
 * True while low-priority work must keep waiting: a foreground caller is in the
 * queue, the minimum spacing has not elapsed, or a 429 cooldown is running.
 *
 * The cooldown term matters. Without it a shadow request joins the queue during
 * a cooldown and RESERVES the first dispatch after it — putting measurement-only
 * work ahead of the money path at the exact moment the API is angriest.
 */
export function shouldLowPriorityYield(args: {
  foregroundPending: number;
  lastDispatchAt: number;
  cooldownUntil: number;
  nowMs: number;
  /** Set only for a /v2/optionchain-family request — the extra 3s interval is
   *  scoped to that endpoint, so other low-priority work is never held by it. */
  optionChain?: boolean;
  lastOptionChainDispatchAt?: number;
}): boolean {
  return (
    args.foregroundPending > 0 ||
    args.nowMs - args.lastDispatchAt < QUOTE_MIN_INTERVAL_MS ||
    args.nowMs < args.cooldownUntil ||
    (args.optionChain === true &&
      args.nowMs - (args.lastOptionChainDispatchAt ?? 0) < OPTIONCHAIN_MIN_INTERVAL_MS)
  );
}

/**
 * Run a Quote-API task one-at-a-time, spaced ≥ QUOTE_MIN_INTERVAL_MS from the
 * previous dispatch AND not before any active 429 cooldown. Serial execution +
 * spacing + shared cooldown together keep the whole process within Dhan's
 * per-account limit no matter how many tabs / routes call in.
 *
 * Pass `{ optionChain: true }` for a /v2/optionchain-family request so it also
 * observes and stamps that endpoint's stricter interval.
 */
export function throughQuoteGate<T>(task: () => Promise<T>, opts: QuoteGateOptions = {}): Promise<T> {
  const optionChain = opts.optionChain === true;
  gate.foregroundPending++;
  const run = gate.tail.then(async (): Promise<T> => {
    const wait = dispatchTargetAt(optionChain) - Date.now();
    if (wait > 0) await sleep(wait);
    stampDispatch(optionChain);
    return task();
  });
  gate.tail = run.then(
    () => undefined,
    () => undefined
  );
  return run.finally(() => {
    gate.foregroundPending = Math.max(0, gate.foregroundPending - 1);
  });
}

/**
 * Best-effort low-priority gate for measurement-only option-chain snapshots.
 * Waits for the foreground queue to drain, for a quiet interval, and for any
 * cooldown to expire. Returns null rather than queueing if that takes too long.
 *
 * A quote arriving after dispatch can still wait behind this ONE request, which
 * is why the task it wraps MUST be independently bounded — the gate cannot
 * cancel work it has already started.
 */
export async function throughQuoteGateLowPriority<T>(
  task: () => Promise<T>,
  opts: QuoteGateOptions & {
    /** Overridable only so tests can assert the real give-up result quickly
     *  instead of merely observing that it is still waiting. */
    giveUpMs?: number;
  } = {}
): Promise<T | null> {
  const optionChain = opts.optionChain === true;
  const giveUpAt = Date.now() + (opts.giveUpMs ?? LOW_PRIORITY_GIVE_UP_MS);
  while (
    shouldLowPriorityYield({
      foregroundPending: gate.foregroundPending,
      lastDispatchAt: gate.lastDispatchAt,
      cooldownUntil: gate.cooldownUntil,
      optionChain,
      lastOptionChainDispatchAt: gate.lastOptionChainDispatchAt,
      nowMs: Date.now(),
    })
  ) {
    if (Date.now() >= giveUpAt) return null;
    await sleep(250);
  }
  const run = gate.tail.then(async (): Promise<T> => {
    const wait = dispatchTargetAt(optionChain) - Date.now();
    if (wait > 0) await sleep(wait);
    stampDispatch(optionChain);
    return task();
  });
  // The tail advances only when `run` genuinely settles.
  //
  // It previously raced `run` against a fixed sleep started at QUEUE time rather
  // than at dispatch. Since `run` also waits out `cooldownUntil` — up to 30s
  // after a 429 — the race released the tail after ~6.5s while the task was
  // still parked. A foreground quote then chained onto an already-resolved tail,
  // both waited on the same cooldown independently, and both could dispatch
  // together, re-triggering the very 429 the cooldown existed to prevent.
  // Serialisation is the whole point of this queue, so nothing may bypass it;
  // the task is bounded at its own layer by fetchJsonWithTimeout.
  gate.tail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** A 429 was seen — escalate the cooldown so every subsequent dispatch waits it out. */
export function noteQuote429(): void {
  gate.consecutive429 = Math.min(gate.consecutive429 + 1, 8);
  const backoff = Math.min(QUOTE_BACKOFF_BASE_MS * 2 ** (gate.consecutive429 - 1), QUOTE_BACKOFF_MAX_MS);
  gate.cooldownUntil = Date.now() + backoff;
}

/** Any successful quote clears the escalation. */
export function noteQuoteOk(): void {
  gate.consecutive429 = 0;
}

/** Remaining cooldown in ms, for log lines. */
export function quoteCooldownRemainingMs(): number {
  return Math.max(0, gate.cooldownUntil - Date.now());
}

/** Test seam. Never called by application code. */
export function __resetQuoteGateForTest(overrides: Partial<QuoteGateState> = {}): void {
  gate.tail = Promise.resolve();
  gate.lastDispatchAt = 0;
  gate.cooldownUntil = 0;
  gate.lastOptionChainDispatchAt = 0;
  gate.consecutive429 = 0;
  gate.foregroundPending = 0;
  Object.assign(gate, overrides);
}
