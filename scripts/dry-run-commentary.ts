/**
 * Commentary prompt DRY-RUN — sends a SYNTHETIC scan through the real
 * generateCommentary() (real MiMo call) and grades the output with the same
 * structure checks as scripts/eval-commentary.ts. Nothing is stored; the
 * output goes to the console only. Use after editing the SYSTEM prompt in
 * lib/ai-commentary/generate.ts to verify the contract BEFORE a trading day.
 *
 * The scan payload is fabricated ON PURPOSE (this is a prompt test bench, not
 * market data): turn 1 = one clean setup + one conflicted setup; turn 2 = the
 * clean pick now near target with fresh buying fading, to test HOLD/EXIT
 * position management against the turn-1 read.
 *
 * Run from the project root:  npx tsx scripts/dry-run-commentary.ts
 * Exit 1 when any structure check fails. Costs 2 MiMo calls.
 */
import type { SuggestResponse, TradeSuggestion } from '../lib/trade-suggest/types';

process.loadEnvFile('.env.local');

const mk = (over: Partial<TradeSuggestion> & { symbol: string }): TradeSuggestion => ({
  rank: 1,
  sector: 'FIN SERVICE',
  direction: 'bullish',
  score: 0.62,
  option: {
    optionType: 'CE',
    strike: 1420,
    expiryDate: '2026-07-28',
    lotSize: 475,
    optSecurityId: '99999',
    optSymbol: `${over.symbol}-Jul2026-1420-CE`,
    premium: { ltp: 37.15, bid: 36.9, ask: 37.4, spreadPct: 0.9, volume: 120000, oi: 500000, perLotCost: 17646, slPremium: 22.3, targetPremium: 47.7, liquidityWarning: null },
  },
  plan: { entrySpot: 1413.3, slSpot: 1400.7, targetSpot: 1438.5, slBasis: 'last-candle' },
  rFactor: 4.4,
  rFactorConfidence: 1,
  oiLevel: 1.27,
  oiUrgency: 6.4,
  changePctOpen: 1.9,
  spreadPct: 0.02,
  imbalance: 0.62,
  orBreakout: true,
  tfBreakout: {
    direction: 'bullish',
    grade: 'confirmed',
    morningTest: 'held',
    levelsCleared: 2,
    clearedNames: ['OR high', 'prev-day high'],
    nextLevel: { name: '5d high', price: 1451 },
    detail: 'morning low held (buyers absorbing dips) · cleared 2 levels: OR high, prev-day high · next: 5d high 1451.00',
  },
  setupLevel: 'strong',
  extended: false,
  factors: {
    vwap: 1394.31,
    vwapAligned: true,
    supertrend: 'up',
    supertrendLine: 1387.58,
    supertrendAligned: true,
    atr: 4.2,
    atrPct: 0.3,
    eqTurnoverRatio: 4.1,
    combinedOiLevel: 1.18,
    nseOiPct: 7.5,
    combinedOiSlope30m: 1.8,
    onOiSpurtList: true,
    sectorPct: 2.06,
    sectorAdvanceRatio: 0.8,
    sectorAligned: true,
  },
  reasons: ['R-Factor 4.40 (bullish, confidence 100%)', 'trading beyond the opening range (breakout confirmed)'],
  ...over,
});

const base: SuggestResponse = {
  success: true,
  window: { active: true, opensAt: '09:40 IST', closesAt: '11:00 IST', nowIST: '10:18:30' },
  marketOpen: true,
  date: '2026-07-13',
  scanned: 41,
  gated: { weakRFactor: 29, lowOiLevel: 6, illiquid: 2, quietSetup: 2 },
  tilt: { up: 21, down: 19, flat: 1, basis: 'since-open', lean: 'neutral' },
  suggestions: [
    mk({ symbol: 'CDSL' }),
    mk({
      symbol: 'KPITTECH',
      rank: 2,
      sector: 'IT',
      score: 0.41,
      orBreakout: false,
      tfBreakout: { direction: 'bullish', grade: 'watch', morningTest: 'held', levelsCleared: 0, clearedNames: [], nextLevel: { name: 'OR high', price: 566.4 }, detail: 'morning low held · no level cleared yet · next: OR high 566.40' },
      plan: { entrySpot: 563.25, slSpot: 561.28, targetSpot: 567.19, slBasis: 'floor' },
      option: {
        optionType: 'CE', strike: 560, expiryDate: '2026-07-28', lotSize: 775, optSecurityId: '99998', optSymbol: 'KPITTECH-Jul2026-560-CE',
        premium: { ltp: 20.3, bid: 20.1, ask: 20.6, spreadPct: 1.2, volume: 40000, oi: 210000, perLotCost: 15733, slPremium: 12.2, targetPremium: 26.8, liquidityWarning: null },
      },
      factors: { vwap: 561.17, vwapAligned: true, supertrend: 'down', supertrendLine: 565.9, supertrendAligned: false, atr: 1.9, atrPct: 0.34, eqTurnoverRatio: 2.2, combinedOiLevel: 1.78, nseOiPct: 3.1, combinedOiSlope30m: -1.6, onOiSpurtList: false, sectorPct: -0.27, sectorAdvanceRatio: 0.4, sectorAligned: false },
      reasons: ['R-Factor 4.48', 'inside opening range — breakout not yet confirmed'],
    }),
  ],
  earlierToday: [],
};

/** Turn 2: CDSL ran to just under target, but fresh buying flipped negative. */
const later: SuggestResponse = {
  ...base,
  window: { ...base.window, nowIST: '10:48:30' },
  suggestions: [
    mk({
      symbol: 'CDSL',
      changePctOpen: 3.4,
      extended: true,
      plan: { entrySpot: 1436.2, slSpot: 1428.9, targetSpot: 1450.8, slBasis: 'last-candle' },
      factors: { vwap: 1401.4, vwapAligned: true, supertrend: 'up', supertrendLine: 1402.1, supertrendAligned: true, atr: 4.6, atrPct: 0.32, eqTurnoverRatio: 4.4, combinedOiLevel: 1.19, nseOiPct: 6.9, combinedOiSlope30m: -0.9, onOiSpurtList: true, sectorPct: 1.8, sectorAdvanceRatio: 0.7, sectorAligned: true },
    }),
  ],
};

// ─── Structure checks (mirror scripts/eval-commentary.ts) ────────────────────
function checkStructure(text: string, picks: string[]): string[] {
  const fails: string[] = [];
  const tableRows = text.split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l.trim())).length;
  if (tableRows >= 2 || /^\s*\|[\s:|-]*-{2,}[\s:|-]*\|\s*$/m.test(text)) fails.push(`markdown table (${tableRows} rows)`);
  for (const part of text.split(/^###\s*/m).slice(1)) {
    const heading = part.split('\n')[0].trim();
    if (/bottom\s*line|end\s*of\s*day/i.test(heading)) continue;
    const clean = heading.replace(/[*_`]/g, '');
    if (!picks.some((s) => new RegExp(`^\\s*${s}\\b`).test(clean))) fails.push(`heading not ticker-first: "### ${heading.slice(0, 50)}"`);
  }
  if (!/^###\s*(\*\*)?\s*bottom\s*line/im.test(text)) fails.push('no "### Bottom line" section');
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > 240) fails.push(`${words} words (contract: ~150, max 220)`);
  return fails;
}

const { generateCommentary } = await import('../lib/ai-commentary/generate');

let failed = false;
console.log('══ Turn 1 — fresh scan (clean CDSL + conflicted KPITTECH) ══\n');
const t1 = await generateCommentary(base, []);
console.log(t1.text);
const f1 = checkStructure(t1.text, ['CDSL', 'KPITTECH']);
console.log(f1.length ? `\n✗ STRUCTURE: ${f1.join(' · ')}` : '\n✓ structure ok');
failed ||= f1.length > 0;

console.log('\n══ Turn 2 — CDSL near target, fresh buying fading (position management) ══\n');
const t2 = await generateCommentary(later, [t1.text]);
console.log(t2.text);
const f2 = checkStructure(t2.text, ['CDSL', 'KPITTECH']);
console.log(f2.length ? `\n✗ STRUCTURE: ${f2.join(' · ')}` : '\n✓ structure ok');
failed ||= f2.length > 0;
const managesPosition = /###\s*(\*\*)?\s*CDSL\s*[—-]\s*(HOLD|MOVE SL|EXIT)/i.test(t2.text);
console.log(managesPosition ? '✓ turn 2 manages the open CDSL position (HOLD/MOVE SL/EXIT verdict)' : '✗ turn 2 gave no HOLD/MOVE SL/EXIT verdict for CDSL');
failed ||= !managesPosition;

// exitCode (not process.exit) — lets Node drain the SDK's sockets on Windows
// instead of asserting in libuv mid-close.
process.exitCode = failed ? 1 : 0;
