/**
 * Point-in-time calibration audit for the display-only App R-Factor.
 *
 * Every row pairs the latest locally recorded market snapshot at or before a
 * successful TradeFinder board capture with TF's value from that same board.
 * The reported leave-one-session-out errors are therefore free of same-day
 * fitting and future-board leakage.
 *
 * Run: pnpm exec tsx scripts/calibrate-app-rfactor.ts
 */
try {
  process.loadEnvFile('.env.local');
} catch {
  // Environment may already be present.
}

import { buildLiveRFactorInput } from '../app/api/live/_lib/rfactor-inputs';
import { computeRFactor } from '../lib/r-factor';
import type { FactorKey } from '../lib/r-factor';
import { getTfBoardsForDate } from '../lib/tf-live/race';
import { deriveSessionContext } from '../lib/signals/session-context';
import { listRecordedDates, loadDay } from './replay-lib';

interface Sample {
  date: string;
  tf: number;
  app: number;
  raw: number;
  features: number[];
}

interface Line {
  intercept: number;
  slope: number;
}

const LIVE_FACTOR_KEYS: FactorKey[] = [
  'smartMoney',
  'futuresOi',
  'oiLevel',
  'oiDirection',
  'turnover',
  'rangeSpread',
  'bidAskSpread',
  'breakout',
];
const STABLE_FACTOR_KEYS: FactorKey[] = ['oiDirection', 'turnover', 'rangeSpread', 'breakout'];

const clamp = (value: number, lo = 0, hi = 10): number => Math.max(lo, Math.min(hi, value));
const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

function fitLine(rows: Sample[], x: (row: Sample) => number): Line {
  const xBar = mean(rows.map(x));
  const yBar = mean(rows.map((row) => row.tf));
  let covariance = 0;
  let variance = 0;
  for (const row of rows) {
    const dx = x(row) - xBar;
    covariance += dx * (row.tf - yBar);
    variance += dx * dx;
  }
  const slope = variance > 0 ? covariance / variance : 0;
  return { intercept: yBar - slope * xBar, slope };
}

/** Small dependency-free ridge solve; enough for this eight-feature audit. */
function fitRidge(rows: Sample[], lambda = 1): number[] {
  const width = rows[0]?.features.length ?? 0;
  const size = width + 1;
  const matrix = Array.from({ length: size }, () => Array(size + 1).fill(0) as number[]);
  for (const row of rows) {
    const x = [1, ...row.features];
    for (let i = 0; i < size; i++) {
      matrix[i][size] += x[i] * row.tf;
      for (let j = 0; j < size; j++) matrix[i][j] += x[i] * x[j];
    }
  }
  for (let i = 1; i < size; i++) matrix[i][i] += lambda;
  for (let pivot = 0; pivot < size; pivot++) {
    let best = pivot;
    for (let row = pivot + 1; row < size; row++) {
      if (Math.abs(matrix[row][pivot]) > Math.abs(matrix[best][pivot])) best = row;
    }
    [matrix[pivot], matrix[best]] = [matrix[best], matrix[pivot]];
    const divisor = matrix[pivot][pivot];
    if (Math.abs(divisor) < 1e-12) continue;
    for (let col = pivot; col <= size; col++) matrix[pivot][col] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === pivot) continue;
      const multiplier = matrix[row][pivot];
      for (let col = pivot; col <= size; col++) matrix[row][col] -= multiplier * matrix[pivot][col];
    }
  }
  return matrix.map((row) => row[size]);
}

function predictRidge(row: Sample, coefficients: number[]): number {
  return clamp(coefficients[0] + row.features.reduce((sum, value, index) => sum + value * coefficients[index + 1], 0));
}

function project(row: Sample, keys: FactorKey[]): Sample {
  return {
    ...row,
    features: keys.map((key) => row.features[LIVE_FACTOR_KEYS.indexOf(key)]),
  };
}

function pearson(actual: number[], predicted: number[]): number {
  const aBar = mean(actual);
  const pBar = mean(predicted);
  let covariance = 0;
  let aVariance = 0;
  let pVariance = 0;
  for (let i = 0; i < actual.length; i++) {
    const da = actual[i] - aBar;
    const dp = predicted[i] - pBar;
    covariance += da * dp;
    aVariance += da * da;
    pVariance += dp * dp;
  }
  return aVariance > 0 && pVariance > 0 ? covariance / Math.sqrt(aVariance * pVariance) : 0;
}

function report(label: string, actual: number[], predicted: number[]): void {
  const errors = actual.map((value, index) => Math.abs(value - predicted[index]));
  const squared = actual.map((value, index) => (value - predicted[index]) ** 2);
  console.log(
    `${label.padEnd(26)} MAE ${mean(errors).toFixed(3)} | RMSE ${Math.sqrt(mean(squared)).toFixed(3)} | r ${pearson(actual, predicted).toFixed(3)}`
  );
}

const samples: Sample[] = [];
const usableDates: string[] = [];
for (const date of listRecordedDates()) {
  const day = loadDay(date);
  if (!day) continue;
  const boards = await getTfBoardsForDate(date);
  if (boards.length === 0) continue;
  usableDates.push(date);

  for (const board of boards) {
    if (board.minuteIST < 9 * 60 + 35 || board.minuteIST > 11 * 60) continue;
    const boardEpoch = Math.floor(
      Date.parse(
        `${date}T${String(Math.floor(board.minuteIST / 60)).padStart(2, '0')}:${String(board.minuteIST % 60).padStart(2, '0')}:59+05:30`
      ) / 1000
    );
    const candleCutoff = boardEpoch - (boardEpoch % 300);
    for (const [symbol, tf] of board.rFactor) {
      const series = day.oiSeries.get(symbol);
      if (!series) continue;
      const snap = [...series].reverse().find((point) => point.bucketTs <= boardEpoch);
      if (!snap || snap.ltp <= 0) continue;
      const bars = (day.eqBars.get(symbol) ?? []).filter((bar) => bar.bucketTs < candleCutoff && bar.high > 0);
      const session = deriveSessionContext(bars);
      const input = buildLiveRFactorInput(
        {
          symbol,
          ltp: snap.ltp,
          changePctOpen: snap.changePctOpen,
          bid: null,
          ask: null,
          spreadPct: snap.spreadPct,
          futOi: snap.futOi > 0 ? snap.futOi : null,
          turnover: snap.futTurnover > 0 ? snap.futTurnover : null,
          dayHigh: session.dayHigh,
          dayLow: session.dayLow,
        },
        day.baselines.get(symbol),
        session,
        new Date(boardEpoch * 1000)
      );
      if (!input) continue;
      const app = computeRFactor(input);
      const byKey = new Map(app.factors.map((factor) => [factor.key, factor]));
      samples.push({
        date,
        tf,
        app: app.rFactor,
        raw: app.rawScore,
        features: LIVE_FACTOR_KEYS.map((key) => {
          const factor = byKey.get(key);
          return factor?.available ? factor.score : 0;
        }),
      });
    }
  }
}

console.log(`Point-in-time samples: ${samples.length} across ${usableDates.length} sessions (${usableDates.join(', ')})`);
const actual = samples.map((row) => row.tf);
report('Current App 1-10', actual, samples.map((row) => row.app));

const inSample = fitLine(samples, (row) => row.raw);
report(
  `In-sample linear`,
  actual,
  samples.map((row) => clamp(inSample.intercept + inSample.slope * row.raw))
);
console.log(`  fitted TF = ${inSample.intercept.toFixed(4)} + ${inSample.slope.toFixed(4)} * raw`);

const heldOutActual: number[] = [];
const heldOutPredicted: number[] = [];
for (const date of usableDates) {
  const train = samples.filter((row) => row.date !== date);
  const test = samples.filter((row) => row.date === date);
  const model = fitLine(train, (row) => row.raw);
  const predicted = test.map((row) => clamp(model.intercept + model.slope * row.raw));
  report(`Held out ${date}`, test.map((row) => row.tf), predicted);
  heldOutActual.push(...test.map((row) => row.tf));
  heldOutPredicted.push(...predicted);
}
report('LOSO linear combined', heldOutActual, heldOutPredicted);

const ridgeActual: number[] = [];
const ridgePredicted: number[] = [];
for (const date of usableDates) {
  const train = samples.filter((row) => row.date !== date);
  const test = samples.filter((row) => row.date === date);
  const coefficients = fitRidge(train, 10);
  const predicted = test.map((row) => predictRidge(row, coefficients));
  report(`Ridge held ${date}`, test.map((row) => row.tf), predicted);
  ridgeActual.push(...test.map((row) => row.tf));
  ridgePredicted.push(...predicted);
}
report('LOSO ridge combined', ridgeActual, ridgePredicted);
const ridge = fitRidge(samples, 10);
console.log(`  ridge intercept ${ridge[0].toFixed(4)}`);
for (let index = 0; index < LIVE_FACTOR_KEYS.length; index++) {
  console.log(`  ${LIVE_FACTOR_KEYS[index].padEnd(14)} ${ridge[index + 1].toFixed(4)}`);
}


const stableActual: number[] = [];
const stablePredicted: number[] = [];
for (const date of usableDates) {
  const train = samples.filter((row) => row.date !== date).map((row) => project(row, STABLE_FACTOR_KEYS));
  const test = samples.filter((row) => row.date === date).map((row) => project(row, STABLE_FACTOR_KEYS));
  const coefficients = fitRidge(train, 10);
  const predicted = test.map((row) => predictRidge(row, coefficients));
  stableActual.push(...test.map((row) => row.tf));
  stablePredicted.push(...predicted);
}
report('LOSO stable factors', stableActual, stablePredicted);
const stable = fitRidge(samples.map((row) => project(row, STABLE_FACTOR_KEYS)), 10);
console.log(`  stable intercept ${stable[0].toFixed(4)}`);
for (let index = 0; index < STABLE_FACTOR_KEYS.length; index++) {
  console.log(`  ${STABLE_FACTOR_KEYS[index].padEnd(14)} ${stable[index + 1].toFixed(4)}`);
}

const tfMean = mean(actual);
report('Constant TF mean', actual, samples.map(() => tfMean));
