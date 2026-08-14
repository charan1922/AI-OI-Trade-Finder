import {
  LOW_PRIORITY_FAILURE_PAUSE_MS,
  LOW_PRIORITY_429_PAUSE_MS,
  QUOTE_MIN_INTERVAL_MS,
  SHADOW_REQUEST_TIMEOUT_MS,
  __resetQuoteGateForTest,
  noteQuoteFailure,
  shouldLowPriorityYield,
  throughQuoteGate,
  throughQuoteGateLowPriority,
} from '@/lib/dhan/quote-gate';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const now = Date.now();
  check(
    'shadow timeout is shorter than the previous 5s money-path stall window',
    SHADOW_REQUEST_TIMEOUT_MS === 2_500,
  );
  check(
    'low-priority cooldown is visible to the pure yield predicate',
    shouldLowPriorityYield({
      foregroundPending: 0,
      lastDispatchAt: now - QUOTE_MIN_INTERVAL_MS,
      cooldownUntil: 0,
      lowPriorityCooldownUntil: now + 1_000,
      nowMs: now,
    }),
  );

  __resetQuoteGateForTest({ lastDispatchAt: now - QUOTE_MIN_INTERVAL_MS });
  noteQuoteFailure();
  let shadowRan = false;
  const paused = await throughQuoteGateLowPriority(
    async () => {
      shadowRan = true;
      return 'should-not-run';
    },
    { optionChain: true, giveUpMs: 50 },
  );
  check('a timeout pauses measurement-only traffic before it enters the queue', paused === null && !shadowRan);

  __resetQuoteGateForTest({
    lastDispatchAt: Date.now() - QUOTE_MIN_INTERVAL_MS,
    lowPriorityCooldownUntil: Date.now() + LOW_PRIORITY_FAILURE_PAUSE_MS,
  });
  const foreground = await throughQuoteGate(async () => 'foreground-ok');
  check('foreground quote traffic remains available during the shadow pause', foreground === 'foreground-ok');

  __resetQuoteGateForTest({
    lastDispatchAt: Date.now() - QUOTE_MIN_INTERVAL_MS,
    lowPriorityCooldownUntil: Date.now() + LOW_PRIORITY_429_PAUSE_MS,
  });
  const pausedBy429 = await throughQuoteGateLowPriority(async () => 'should-not-run', {
    optionChain: true,
    giveUpMs: 50,
  });
  check('a 429 pause also rejects new shadow work without dispatching it', pausedBy429 === null);

  __resetQuoteGateForTest({ lastDispatchAt: Date.now() - QUOTE_MIN_INTERVAL_MS });
  const resumed = await throughQuoteGateLowPriority(async () => 'shadow-ok', {
    optionChain: true,
    giveUpMs: 100,
  });
  check('shadow work resumes after the broker cooldown expires', resumed === 'shadow-ok');
}

main()
  .then(() => {
    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
