/**
 * DB-free CI verifier for the capped priority-refresh planner (lib/priority-refresh/*).
 * Opens NO database, so it runs in GitHub CI alongside verify-quant-shadow.ts.
 *
 * Run:  pnpm exec tsx scripts/verify-priority-refresh.ts   (exit 1 on any failure)
 */
import { runPriorityRefreshChecks } from './priority-refresh-checks';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('=== Pure verification (no DB): capped priority-refresh planner ===\n');
runPriorityRefreshChecks(check);
console.log(`\n${failures === 0 ? '✅ all priority-refresh checks passed' : `❌ ${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
