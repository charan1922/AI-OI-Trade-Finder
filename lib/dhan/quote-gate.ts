/**
 * The single server-side choke point for Dhan Quote-API traffic.
 *
 * Dhan allows ~1 Quote request/sec per account, and a burst does not merely get
 * rejected — it trips a penalty box that keeps 429-ing even compliant traffic.
 * Every Quote call therefore runs one-at-a-time, spaced ≥ QUOTE_MIN_INTERVAL_MS
 * apart, and a 429 trips an escalating cooldown that pauses ALL quote traffic so
 * the penalty box can clear instead of being poked again. Option-chain requests
 * additionally observe their endpoint's own stricter sub-limit — see
 * OPTIONCHAIN_MIN_INTERVAL_MS.
 *
 * TWO LANES, ONE EXECUTION SLOT (dispatchPump below): a plain marketfeed call
 * (`plainQueue`) and an option-chain call (`chainQueue`) are admitted into
 * separate FIFOs, but only one request is ever actually in flight — the pump
 * always prefers an eligible plain-lane head over an eligible chain-lane head.
 * This matters because the option-chain sub-limit can leave a chain call
 * genuinely INELIGIBLE to dispatch for up to 3.2s; without lane separation, a
 * money-path quote that queued up behind that (still-waiting) chain call would
 * be forced to wait out someone else's stricter interval even though the quote
 * itself carries no such restriction (reproduced in scripts/verify-rfactor-v2.ts:
 * a plain quote queued right behind a not-yet-eligible chain call was held for
 * ~4.5s before lane separation existed — PR#29 review).
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
 * They are ALSO never queued behind a chain call that hasn't reached this
 * interval yet — see the pump-lane note in the module doc above.
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

/** Pause measurement-only traffic after broker instability. Foreground quote
 * and position-management calls remain eligible during this pause. */
export const LOW_PRIORITY_FAILURE_PAUSE_MS = 30_000;
export const LOW_PRIORITY_429_PAUSE_MS = 60_000;

/**
 * Hard ceiling on a measurement-only request once dispatched. It shares the
 * execution slot with live quotes, so an unbounded shadow request would wedge
 * the pump and make a money-path quote wait behind it forever.
 */
export const SHADOW_REQUEST_TIMEOUT_MS = 2_500;

/**
 * How often the pump re-checks eligibility while neither lane's head is ready
 * to dispatch yet. Small relative to QUOTE_MIN_INTERVAL_MS/OPTIONCHAIN_MIN_INTERVAL_MS
 * (seconds-scale), so this adds only negligible slop while letting a plain quote
 * that arrives mid-wait for a chain call be noticed and dispatched promptly
 * instead of waiting out the chain call's full remaining interval.
 */
const PUMP_POLL_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One admitted-but-not-yet-dispatched request. Wraps task execution so the
 *  pump can await it without ever throwing (errors route to the caller's own
 *  promise via reject, not by rejecting the pump loop). */
type QueueItem = () => Promise<void>;

interface QuoteGateState {
  /** FIFO of admitted plain (non-option-chain) requests — always preferred by
   *  the pump over the chain lane once its head is eligible. */
  plainQueue: QueueItem[];
  /** FIFO of admitted option-chain requests. */
  chainQueue: QueueItem[];
  /** Measurement-only option-chain requests. Isolated so a shadow failure can
   * pause research traffic without pausing foreground chain reads. */
  lowPriorityChainQueue: QueueItem[];
  /** True while dispatchPump()'s loop is actively running, so concurrent
   *  enqueues don't start a second overlapping pump. */
  pumping: boolean;
  /** When the last task was dispatched (start-to-start spacing anchor). */
  lastDispatchAt: number;
  /** No task dispatches before this time — set/extended by a 429. */
  cooldownUntil: number;
  /** When the last /v2/optionchain call actually went out (real dispatch time,
   *  not a caller's pre-wait estimate). Drives OPTIONCHAIN_MIN_INTERVAL_MS. */
  lastOptionChainDispatchAt: number;
  /** Consecutive 429s; drives the exponential backoff, reset on any success. */
  consecutive429: number;
  /** Measurement-only work is paused after broker failures. */
  lowPriorityCooldownUntil: number;
  /** Interactive/live quote callers waiting or executing. Shadow option-chain
   * work yields while this is non-zero so it cannot build a backlog ahead of
   * money-path quote reads. */
  foregroundPending: number;
}

const gateHost = globalThis as unknown as { __dhanQuoteGate?: QuoteGateState };
gateHost.__dhanQuoteGate ??= {
  plainQueue: [],
  chainQueue: [],
  lowPriorityChainQueue: [],
  pumping: false,
  lastDispatchAt: 0,
  cooldownUntil: 0,
  lastOptionChainDispatchAt: 0,
  consecutive429: 0,
  lowPriorityCooldownUntil: 0,
  foregroundPending: 0,
};
const gate = gateHost.__dhanQuoteGate;
gate.foregroundPending ??= 0;
gate.lastOptionChainDispatchAt ??= 0;
gate.plainQueue ??= [];
gate.chainQueue ??= [];
gate.lowPriorityChainQueue ??= [];
gate.pumping ??= false;
gate.lowPriorityCooldownUntil ??= 0;

/**
 * Earliest time a dispatch of this kind may go out, computed fresh from current
 * gate state (never a caller's stale estimate).
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
 * The one execution loop: repeatedly picks the next eligible item — plain lane
 * first — and runs it to completion before considering another. This is the
 * sole place a real dispatch happens, so "only one Dhan call in flight" and
 * "plain quotes never wait out a chain call's sub-limit" both fall out of one
 * small loop instead of needing separate machinery.
 *
 * Deliberately does NOT shift the chain lane's head and sleep for its whole
 * remaining wait in one uninterruptible step — that would re-create exactly the
 * bug this replaces (a later, immediately-eligible plain quote stuck behind an
 * earlier chain call that isn't ready yet). Polling in small increments means a
 * newly-arrived plain request is picked up within PUMP_POLL_MS instead of after
 * the chain call's full interval elapses.
 */
async function dispatchPump(): Promise<void> {
  if (gate.pumping) return;
  gate.pumping = true;
  try {
    for (;;) {
      const now = Date.now();
      if (gate.plainQueue.length > 0 && dispatchTargetAt(false) <= now) {
        const next = gate.plainQueue.shift()!;
        stampDispatch(false);
        await next();
        continue;
      }
      if (gate.chainQueue.length > 0 && dispatchTargetAt(true) <= now) {
        const next = gate.chainQueue.shift()!;
        stampDispatch(true);
        await next();
        continue;
      }
      if (
        gate.lowPriorityChainQueue.length > 0 &&
        gate.lowPriorityCooldownUntil <= now &&
        dispatchTargetAt(true) <= now
      ) {
        const next = gate.lowPriorityChainQueue.shift()!;
        stampDispatch(true);
        await next();
        continue;
      }
      if (gate.plainQueue.length === 0 && gate.chainQueue.length === 0 && gate.lowPriorityChainQueue.length === 0)
        return;
      await sleep(PUMP_POLL_MS);
    }
  } finally {
    gate.pumping = false;
  }
}

/** Wrap a task so the pump can run it without ever throwing — the outer promise
 *  the caller holds carries the real result/error via resolve/reject. */
function admit<T>(task: () => Promise<T>): { promise: Promise<T>; run: QueueItem } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const run: QueueItem = async () => {
    try {
      resolve(await task());
    } catch (error) {
      reject(error);
    }
  };
  return { promise, run };
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
  lowPriorityCooldownUntil?: number;
}): boolean {
  return (
    args.foregroundPending > 0 ||
    args.nowMs - args.lastDispatchAt < QUOTE_MIN_INTERVAL_MS ||
    args.nowMs < args.cooldownUntil ||
    args.nowMs < (args.lowPriorityCooldownUntil ?? 0) ||
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
 * observes and stamps that endpoint's stricter interval — and joins the chain
 * lane, so it can never delay a plain call queued behind it (see dispatchPump).
 */
export function throughQuoteGate<T>(task: () => Promise<T>, opts: QuoteGateOptions = {}): Promise<T> {
  const optionChain = opts.optionChain === true;
  gate.foregroundPending++;
  const { promise, run } = admit(task);
  (optionChain ? gate.chainQueue : gate.plainQueue).push(run);
  void dispatchPump();
  return promise.finally(() => {
    gate.foregroundPending = Math.max(0, gate.foregroundPending - 1);
  });
}

/**
 * Best-effort low-priority gate for measurement-only option-chain snapshots.
 * Waits for the foreground queue to drain, for a quiet interval, and for any
 * cooldown to expire. Returns null rather than queueing if that takes too long.
 *
 * A quote arriving after admission can still wait behind ONE already-committed
 * request from the same lane, which is why the task it wraps MUST be
 * independently bounded — the pump cannot cancel work it has already started.
 */
export async function throughQuoteGateLowPriority<T>(
  task: () => Promise<T>,
  opts: { optionChain: true; giveUpMs?: number } = { optionChain: true },
): Promise<T | null> {
  const optionChain = opts.optionChain === true;
  const giveUpAt = Date.now() + (opts.giveUpMs ?? LOW_PRIORITY_GIVE_UP_MS);
  while (
    shouldLowPriorityYield({
      foregroundPending: gate.foregroundPending,
      lastDispatchAt: gate.lastDispatchAt,
      cooldownUntil: gate.cooldownUntil,
      lowPriorityCooldownUntil: gate.lowPriorityCooldownUntil,
      optionChain,
      lastOptionChainDispatchAt: gate.lastOptionChainDispatchAt,
      nowMs: Date.now(),
    })
  ) {
    if (Date.now() >= giveUpAt) return null;
    await sleep(250);
  }
  // Admission (not dispatch) commits here. A foreground plain call that arrives
  // after this point still cannot be delayed by it: dispatchPump always prefers
  // an eligible plainQueue head over a chainQueue head, even one admitted first.
  const { promise, run } = admit(task);
  gate.lowPriorityChainQueue.push(run);
  void dispatchPump();
  return promise;
}

/** A 429 was seen — escalate the cooldown so every subsequent dispatch waits it out. */
export function noteQuote429(): void {
  gate.consecutive429 = Math.min(gate.consecutive429 + 1, 8);
  const backoff = Math.min(QUOTE_BACKOFF_BASE_MS * 2 ** (gate.consecutive429 - 1), QUOTE_BACKOFF_MAX_MS);
  gate.cooldownUntil = Date.now() + backoff;
  gate.lowPriorityCooldownUntil = Math.max(
    gate.lowPriorityCooldownUntil,
    Date.now() + LOW_PRIORITY_429_PAUSE_MS,
  );
}

/** A timeout/transport failure should stop optional research traffic from
 * competing with the next foreground quote attempt. */
export function noteQuoteFailure(): void {
  gate.lowPriorityCooldownUntil = Math.max(
    gate.lowPriorityCooldownUntil,
    Date.now() + LOW_PRIORITY_FAILURE_PAUSE_MS,
  );
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
  gate.plainQueue = [];
  gate.chainQueue = [];
  gate.lowPriorityChainQueue = [];
  gate.pumping = false;
  gate.lastDispatchAt = 0;
  gate.cooldownUntil = 0;
  gate.lastOptionChainDispatchAt = 0;
  gate.consecutive429 = 0;
  gate.lowPriorityCooldownUntil = 0;
  gate.foregroundPending = 0;
  Object.assign(gate, overrides);
}
