/**
 * DB-free CI verifier for the pure logic these PRs add: the quant-SHADOW math
 * (scripts/quant-shadow-checks.ts) AND the config-drift override detector
 * (scripts/config-drift-checks.ts). Opens NO database, so it runs in GitHub CI
 * where the full auto-trade bench (needs a populated SQLite DB) cannot — closing
 * the "CI can't confirm these checks" gap (AT-review + PR#2 review 2026-07-20).
 *
 * Run:  pnpm exec tsx scripts/verify-quant-shadow.ts   (exit 1 on any failure)
 */
import { runQuantShadowChecks } from './quant-shadow-checks';
import { runConfigDriftChecks } from './config-drift-checks';
import { runGradeChecks } from './grade-checks';
import { runProfitProtectChecks } from './profit-protect-checks';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  console.log('=== Pure verification (no DB): quant-shadow math + config-drift + honest grader + profit-protect ===\n');
  runQuantShadowChecks(check);
  await runConfigDriftChecks(check);
  runGradeChecks(check);
  runProfitProtectChecks(check);
  console.log(`\n${failures === 0 ? '✅ all pure checks passed' : `❌ ${failures} check(s) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();
