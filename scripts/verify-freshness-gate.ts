/**
 * DB-free CI verifier for the candle-freshness rule + the auto-trade stale-candle
 * entry gate. Opens NO database, so it runs in GitHub CI alongside the other
 * verify-*.ts pure checks.
 *
 * Run:  pnpm exec tsx scripts/verify-freshness-gate.ts   (exit 1 on any failure)
 */
import { runFreshnessGateChecks } from './freshness-gate-checks';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('=== Pure verification (no DB): candle freshness + stale-candle entry gate ===\n');
runFreshnessGateChecks(check);
console.log(`\n${failures === 0 ? '✅ all freshness/gate checks passed' : `❌ ${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
