/**
 * DB-free verifier for the quant-SHADOW pure math. Runs the SAME assertions the
 * box bench runs (scripts/quant-shadow-checks.ts) but opens NO database, so it
 * runs in GitHub CI where the auto-trade bench (needs a populated SQLite DB)
 * cannot — closing the "CI can't confirm the shadow checks" gap
 * (AT-review 2026-07-20 finding 6).
 *
 * Run:  pnpm exec tsx scripts/verify-quant-shadow.ts   (exit 1 on any failure)
 */
import { runQuantShadowChecks } from './quant-shadow-checks';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('=== Quant SHADOW pure-math verification (no DB) ===\n');
runQuantShadowChecks(check);
console.log(`\n${failures === 0 ? '✅ all quant-shadow checks passed' : `❌ ${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
