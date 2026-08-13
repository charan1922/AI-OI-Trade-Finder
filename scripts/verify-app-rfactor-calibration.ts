import { approximateTfRFactor, TF_APPROX_CALIBRATION } from '../lib/r-factor';
import type { FactorKey, FactorScore } from '../lib/r-factor';

let failed = 0;
function check(name: string, pass: boolean, detail = ''): void {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!pass) failed++;
}

const factor = (key: FactorKey, score: number, available = true): FactorScore => ({
  key,
  score,
  available,
  label: key,
  vote: 'neutral',
  detail: 'test',
});

const baseline = approximateTfRFactor([]);
check('empty evidence returns calibrated baseline', baseline === 0.35, `got ${baseline}`);

const maxStable = approximateTfRFactor([
  factor('oiDirection', 1),
  factor('turnover', 1),
  factor('rangeSpread', 1),
  factor('breakout', 1),
]);
check('four positive factors raise the estimate', maxStable === 3.03, `got ${maxStable}`);

const unavailable = approximateTfRFactor([factor('turnover', 1, false)]);
check('unavailable factors do not contribute', unavailable === baseline, `got ${unavailable}`);

const duplicate = approximateTfRFactor([factor('turnover', 0.25), factor('turnover', 1)]);
check('latest duplicate factor wins deterministically', duplicate === 1.15, `got ${duplicate}`);
check('calibration metadata remains exported', TF_APPROX_CALIBRATION.coefficients.rangeSpread === 0.9748);

if (failed > 0) process.exit(1);
console.log('App R-Factor calibration checks passed.');
