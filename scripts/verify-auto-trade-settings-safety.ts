/**
 * Regression for PR #20: an invalid AI model environment value must never make
 * risk settings or the deterministic position guard unavailable.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalCwd = process.cwd();
const originalMimoModel = process.env.MIMO_MODEL;
const originalMimoApiKey = process.env.MIMO_API_KEY;
const originalMimoBaseUrl = process.env.MIMO_BASE_URL;
const tmp = mkdtempSync(join(tmpdir(), 'auto-settings-safety-'));
mkdirSync(join(tmp, 'data'), { recursive: true });
process.chdir(tmp);
process.env.MIMO_MODEL = 'mimo-v2.5-pr0';
process.env.MIMO_API_KEY = 'settings-safety-fixture';
process.env.MIMO_BASE_URL = 'https://settings-safety.invalid/v1';

let failures = 0;
function check(name: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

async function main(): Promise<void> {
  const { prisma } = await import('../lib/db');
  const { todayIST } = await import('../lib/dhan/market-feed');
  const { activeAiConfigurationIssue, getAutoTradeSettings, setAutoTradeSetting } = await import(
    '../lib/auto-trade/settings'
  );
  const { insertTrade } = await import('../lib/auto-trade/store');
  const { runPositionGuard } = await import('../lib/auto-trade/risk/position-guard');
  const { runAndStoreCommentary } = await import('../lib/ai-commentary/run');

  // Select MiMo without creating a mimoModel row: the environment is therefore
  // the active source, exactly matching the production failure in the review.
  await setAutoTradeSetting('aiProvider', 'mimo');
  const storedModelRows = await prisma.$queryRawUnsafe<{ n: number | bigint }[]>(
    `SELECT COUNT(*) AS n FROM auto_trade_settings WHERE key = 'mimoModel'`
  );
  const settings = await getAutoTradeSettings();
  check('fixture has no stored MiMo model', Number(storedModelRows[0]?.n ?? -1) === 0);
  check('invalid env still returns the quality-first model fallback', settings.mimoModel === 'mimo-v2.5-pro');
  check('square-off risk setting remains available', Number.isFinite(settings.squareOffMin));
  check(
    'active MiMo provider reports the deployment typo',
    activeAiConfigurationIssue(settings)?.includes('mimo-v2.5-pr0') === true,
    activeAiConfigurationIssue(settings) ?? 'missing error'
  );

  const date = todayIST();
  const tradeId = await insertTrade({
    date,
    symbol: 'INFY',
    direction: 'bullish',
    optionType: 'CE',
    strike: 1600,
    expiryDate: '2026-08-25',
    lotSize: 400,
    lots: 1,
    optSecurityId: '12345',
    mode: 'paper',
    broker: 'paper',
    status: 'open',
    entrySpot: 1600,
    slSpot: 1580,
    targetSpot: 1640,
    entryPremium: 50,
    slPremium: 37.5,
    targetPremium: 52.75,
    aiReasonEntry: 'settings-safety fixture; deliberately has no confirmed fill',
  });
  let guardCompleted = false;
  try {
    const result = await runPositionGuard(date);
    guardCompleted = Array.isArray(result.actions);
  } catch (error) {
    console.error(error);
  }
  check('deterministic guard executes with the invalid AI env value', tradeId != null && guardCompleted);

  const commentary = await runAndStoreCommentary({ scanned: 1 } as never);
  check(
    'standalone commentary makes no AI call while the model is misconfigured',
    commentary.generated === false && commentary.reason?.includes('mimo-v2.5-pr0') === true,
    commentary.reason ?? 'missing reason'
  );

  const recovered = await setAutoTradeSetting('mimoModel', 'mimo-v2.5');
  check(
    'a valid stored model recovers without redeploying',
    recovered.mimoModel === 'mimo-v2.5' && activeAiConfigurationIssue(recovered) == null
  );
  await prisma.$disconnect();
}

console.log('=== Auto-trade settings/guard safety (isolated temp SQLite) ===\n');
main()
  .then(() => {
    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((error) => {
    console.error('FAILED:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    if (originalMimoModel == null) delete process.env.MIMO_MODEL;
    else process.env.MIMO_MODEL = originalMimoModel;
    if (originalMimoApiKey == null) delete process.env.MIMO_API_KEY;
    else process.env.MIMO_API_KEY = originalMimoApiKey;
    if (originalMimoBaseUrl == null) delete process.env.MIMO_BASE_URL;
    else process.env.MIMO_BASE_URL = originalMimoBaseUrl;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Windows can hold SQLite briefly after disconnect.
    }
  });
