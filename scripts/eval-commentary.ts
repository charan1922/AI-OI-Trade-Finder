/**
 * Commentary eval harness — scores every stored MiMo narration in
 * `trade_commentary` against the contract its SYSTEM prompt promises
 * (lib/ai-commentary/generate.ts) and the real data it was given
 * (`picksJson` + the day's earlier reads). Pure read-only; no LLM calls.
 *
 * WHY: prompt changes (e.g. the tfBreakout rules added 2026-07-11) had no
 * regression check — a narration that fabricates a level, breaks the
 * `### TICKER` structure the /trade-commentary page splits on, or outputs a
 * forbidden markdown table would only be caught by eyeball.
 *
 * Checks per row:
 *  FAIL (breaks the page or the grounding contract):
 *   • markdown table in the text (prompt: "NEVER output a markdown table")
 *   • stock heading that doesn't START with the ticker (`### TICKER — …`) —
 *     the page's splitByStock keys on this; decorated headings render wrong
 *   • a heading ticker that is a REAL F&O symbol but wasn't in this row's
 *     picks or any earlier read today (hallucinated stock)
 *   • empty text
 *  WARN (suspect, needs a human look):
 *   • price-scale numbers (≥100 or ₹-prefixed) in a stock's section that
 *     match nothing in that row's picksJson, the scan header, or any earlier
 *     read today (potential fabrication; tolerance covers display rounding)
 *   • a pick with no section; no "Bottom line"-style close; top-pick ticker
 *     that isn't the first stock section; picksCount ≠ picksJson length
 *  INFO: word count far beyond the prompt's ~220-word budget.
 *
 * Small numbers (<100: scores, slopes, urgency, %s, counts) are NOT graded —
 * the scan JSON they came from isn't persisted, so grading them would be
 * guesswork. Exit 1 when any FAIL exists (CI-able); WARN/INFO never fail.
 *
 * Run from the project root:
 *   npx tsx scripts/eval-commentary.ts [--date=YYYY-MM-DD] [--verbose]
 */
import Database from 'better-sqlite3';
import { checkContract } from '../lib/ai-commentary/contract-checks';

const db = new Database('./data/project-r.db', { readonly: true });
const dateArg = process.argv.find((a) => a.startsWith('--date='))?.slice(7) ?? null;
const VERBOSE = process.argv.includes('--verbose');

interface Row {
  id: number;
  date: string;
  asOf: string;
  windowActive: number;
  picksCount: number;
  model: string;
  text: string;
  picksJson: string;
}
interface StoredPick {
  symbol: string;
  strike: number | null;
  entrySpot: number | null;
  slSpot: number | null;
  targetSpot: number | null;
  premium: number | null;
  perLotCost: number | null;
  lot: number | null;
  score: number;
  changePctOpen: number | null;
  chips: { label: string; value: string }[];
}

const rows = (
  dateArg
    ? db.prepare('SELECT * FROM trade_commentary WHERE date=? ORDER BY id').all(dateArg)
    : db.prepare('SELECT * FROM trade_commentary ORDER BY id').all()
) as Row[];
/** Real F&O symbols — a heading ticker outside picks only counts as a
 *  hallucination when it IS one of these (an invented stock, not a stray word). */
const fnoSymbols = new Set(
  (db.prepare('SELECT symbol FROM fno_stocks').all() as { symbol: string }[]).map((r) => r.symbol),
);

// ─── Helpers ─────────────────────────────────────────────────────────────────
const parsePicks = (json: string): StoredPick[] => {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as StoredPick[]) : [];
  } catch {
    return [];
  }
};

/** All numeric values a pick legitimately puts in front of the model/user. */
function pickNumbers(p: StoredPick): number[] {
  const out: number[] = [];
  const push = (v: unknown) => {
    const n = Number(v);
    if (Number.isFinite(n)) out.push(Math.abs(n));
  };
  for (const v of [p.strike, p.entrySpot, p.slSpot, p.targetSpot, p.premium, p.perLotCost, p.lot, p.score, p.changePctOpen]) push(v);
  for (const c of p.chips ?? []) for (const m of c.value.matchAll(/\d[\d,]*\.?\d*/g)) push(m[0].replace(/,/g, ''));
  return out;
}

/** Price-scale candidate numbers in a text span (≥100 or ₹-prefixed; times,
 *  dates and small numbers excluded — see header comment). */
function extractCandidates(span: string): number[] {
  const cleaned = span
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ') // ISO dates
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' '); // clock times
  const out: number[] = [];
  for (const m of cleaned.matchAll(/(₹\s*)?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/[₹,\s]/g, ''));
    if (!Number.isFinite(n)) continue;
    if (m[1] || n >= 100) out.push(n);
  }
  return out;
}

/** Every number appearing anywhere in a text — the "prior reads" allowance. */
function allNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Display-rounding tolerance: 11,664 in text matches 11664.35 in data. */
const matches = (n: number, allowed: number[]): boolean =>
  allowed.some((a) => Math.abs(n - a) <= Math.max(0.0101, Math.abs(a) * 0.0006));

// ─── Evaluate ────────────────────────────────────────────────────────────────
interface RowReport {
  row: Row;
  fails: string[];
  warns: string[];
  infos: string[];
}
const reports: RowReport[] = [];
const priorTextByDate = new Map<string, string[]>(); // rows are ordered by id
const priorSymbolsByDate = new Map<string, Set<string>>();
const priorOpenByDate = new Map<string, Set<string>>(); // TRADE NOW names so far, per day

for (const row of rows) {
  const fails: string[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const picks = parsePicks(row.picksJson);
  const pickSyms = new Set(picks.map((p) => p.symbol));
  const priorTexts = priorTextByDate.get(row.date) ?? [];
  const priorSyms = priorSymbolsByDate.get(row.date) ?? new Set<string>();

  // Structure contract — shared with the replay bench (contract-checks.ts).
  // Open positions = names a PRIOR read today called TRADE NOW (phantom check).
  const openPositions = priorOpenByDate.get(row.date) ?? new Set<string>();
  const contract = checkContract(row.text, pickSyms, new Set([...pickSyms, ...priorSyms]), fnoSymbols, openPositions);
  for (const s of contract.sections) {
    if (s.verdict === 'TRADE NOW' && s.ticker) openPositions.add(s.ticker);
    else if (s.verdict === 'EXIT NOW' && s.ticker) openPositions.delete(s.ticker); // exit is final
  }
  priorOpenByDate.set(row.date, openPositions);
  fails.push(...contract.fails);
  warns.push(...contract.warns);
  const stockSections = contract.sections.filter((s) => s.ticker != null);

  // Every pick should get its own section (when there are picks at all).
  for (const p of picks) {
    if (!stockSections.some((s) => s.ticker === p.symbol)) warns.push(`pick ${p.symbol} has no ### section`);
  }
  // Top-pick consistency: if the text names a top pick, it must be a real pick
  // and be the FIRST stock section (prompt: best-first, top pick first).
  const topM = row.text.match(/top\s*pick[^A-Z]*([A-Z][A-Z0-9&-]{2,})/i);
  if (topM && fnoSymbols.has(topM[1])) {
    if (!pickSyms.has(topM[1])) warns.push(`top pick ${topM[1]} is not among this scan's picks`);
    else if (stockSections[0]?.ticker !== topM[1]) warns.push(`top pick ${topM[1]} is not the first stock section (${stockSections[0]?.ticker ?? 'none'})`);
  }

  // Number grounding per stock section (price-scale only) — stays here because
  // it needs the stored picksJson + prior texts, which only this eval has.
  const priorNums = priorTexts.flatMap(allNumbers);
  for (const s of stockSections) {
    const p = picks.find((x) => x.symbol === s.ticker);
    const allowed = [...(p ? pickNumbers(p) : []), ...picks.flatMap(pickNumbers), ...priorNums];
    const suspects = [...new Set(extractCandidates(`${s.heading}\n${s.body}`))].filter((n) => !matches(n, allowed));
    if (suspects.length > 0) {
      warns.push(`${s.ticker}: ungrounded price-scale number(s): ${suspects.slice(0, 6).join(', ')}${suspects.length > 6 ? '…' : ''}`);
    }
  }

  // Stored-data consistency (word count is covered by the shared contract check).
  if (picks.length !== row.picksCount) warns.push(`picksCount=${row.picksCount} but picksJson has ${picks.length}`);

  reports.push({ row, fails, warns, infos });
  priorTextByDate.set(row.date, [...priorTexts, row.text]);
  priorSymbolsByDate.set(row.date, new Set([...priorSyms, ...pickSyms]));
}

// ─── Report ──────────────────────────────────────────────────────────────────
let failRows = 0;
let warnRows = 0;
for (const r of reports) {
  const status = r.fails.length ? '✗ FAIL' : r.warns.length ? '⚠ warn' : '✓ ok';
  if (r.fails.length) failRows++;
  else if (r.warns.length) warnRows++;
  console.log(`\n#${r.row.id} ${r.row.date} ${r.row.asOf.slice(11, 16)} picks=${r.row.picksCount} ${status}`);
  for (const f of r.fails) console.log(`   ✗ ${f}`);
  for (const w of r.warns) console.log(`   ⚠ ${w}`);
  for (const i of r.infos) console.log(`   · ${i}`);
  if (VERBOSE) console.log(`   text: ${r.row.text.slice(0, 200).replace(/\n/g, ' ')}…`);
}
console.log(`\n═══ ${reports.length} narration(s)${dateArg ? ` on ${dateArg}` : ''}: ${failRows} FAIL · ${warnRows} warn-only · ${reports.length - failRows - warnRows} clean ═══`);
if (failRows > 0) {
  console.log(
    'FAILs violate the output contract: tables hurt mobile readability (prompt forbids them; the page only renders them defensively), ' +
      'non-ticker-first headings break the page\'s per-stock split, hallucinated tickers break grounding. ' +
      'Fix the SYSTEM prompt (lib/ai-commentary/generate.ts) and re-check.',
  );
}
db.close();
process.exit(failRows > 0 ? 1 : 0);
