/**
 * The commentary OUTPUT CONTRACT as code — pure checks + verdict parser shared
 * by the offline eval (scripts/eval-commentary.ts), the replay battle-bench
 * (scripts/replay-commentary.ts) and its temp UI. Mirrors the SYSTEM prompt in
 * generate.ts: no markdown tables, `### TICKER — VERDICT` ticker-first
 * headings, a Bottom-line close, decisive verdict vocabulary.
 *
 * Keep in sync with the SYSTEM prompt — this file is what "the contract" means
 * mechanically. No DB, no imports beyond types: safe everywhere.
 */

export type Verdict = 'TRADE NOW' | 'HOLD' | 'MOVE SL' | 'EXIT NOW' | 'WATCH' | 'OTHER';

export interface ParsedSection {
  heading: string;
  /** First ALL-CAPS token in the heading that matches a known symbol, if any. */
  ticker: string | null;
  /** True when the heading starts with the ticker (the page-split contract). */
  tickerFirst: boolean;
  verdict: Verdict;
  /** Level parsed from "MOVE SL to <level>" when present. */
  slLevel: number | null;
  body: string;
}

export const NON_STOCK_HEADINGS =
  /bottom\s*line|end\s*of\s*day|reality|market|summary|no\s*trade|stand\s*aside/i;

/** Count true markdown-table rows (`| a | b |` / `|---|`). Inline pipes are fine. */
export function countTableRows(text: string): number {
  return text.split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l.trim())).length;
}
export function hasTableSeparator(text: string): boolean {
  return /^\s*\|[\s:|-]*-{2,}[\s:|-]*\|\s*$/m.test(text);
}
export function hasBottomLine(text: string): boolean {
  return /^###\s*(\*\*)?\s*(bottom\s*line|end\s*of\s*day)/im.test(text);
}
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function classifyVerdict(heading: string): { verdict: Verdict; slLevel: number | null } {
  const h = heading.toUpperCase();
  if (/EXIT\s*NOW|EXIT\b|SQUARE\s*OFF|BOOK/.test(h) && !/DON'T|NOT/.test(h)) {
    // "EXIT NOW" and close variants ("EXIT — target hit", "BOOK NOW")
    if (/EXIT|SQUARE/.test(h)) return { verdict: 'EXIT NOW', slLevel: null };
  }
  const mv = h.match(/MOVE\s*SL\s*(?:TO|→|UP\s*TO)?\s*(₹?\s*[\d,]+(?:\.\d+)?)/);
  if (mv) return { verdict: 'MOVE SL', slLevel: Number(mv[1].replace(/[₹,\s]/g, '')) || null };
  if (/TRADE\s*NOW|BUY\s*NOW/.test(h)) return { verdict: 'TRADE NOW', slLevel: null };
  if (/\bHOLD\b/.test(h)) return { verdict: 'HOLD', slLevel: null };
  // WATCH family — non-actionable stances the model legitimately uses for a
  // name it never entered ("no position", "still watching", "skip", EOD recap).
  if (/\bWATCH|NO\s*(POSITION|TRADE)|SKIP|STAND\s*ASIDE|DROPPED|NOT\s*ENTERED/.test(h)) return { verdict: 'WATCH', slLevel: null };
  return { verdict: 'OTHER', slLevel: null };
}

/** Split a narration into ### sections and classify each heading. */
export function parseSections(text: string, knownSymbols: Set<string>): { intro: string; sections: ParsedSection[] } {
  const parts = text.split(/^###\s*/m);
  const intro = parts[0] ?? '';
  const sections: ParsedSection[] = [];
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    const body = nl === -1 ? '' : part.slice(nl + 1);
    if (NON_STOCK_HEADINGS.test(heading)) {
      sections.push({ heading, ticker: null, tickerFirst: false, verdict: 'OTHER', slLevel: null, body });
      continue;
    }
    const clean = heading.replace(/[*_`]/g, '');
    const caps = clean.match(/[A-Z][A-Z0-9&-]{2,}/g) ?? [];
    const ticker = caps.find((c) => knownSymbols.has(c)) ?? null;
    const tickerFirst = ticker != null && new RegExp(`^\\s*${ticker}\\b`).test(clean);
    sections.push({ heading, ticker, tickerFirst, body, ...classifyVerdict(heading) });
  }
  return { intro, sections };
}

export interface ContractResult {
  fails: string[];
  warns: string[];
  sections: ParsedSection[];
}

/**
 * Structure-contract check for one narration.
 * `pickSymbols` = this scan's suggestions; `contextSymbols` = anything
 * legitimately mentionable (picks + names from earlier reads today);
 * `allSymbols` = the F&O universe (to recognise tickers at all);
 * `openPositions` (optional) = names a PRIOR read called TRADE NOW — when
 * given, a HOLD/MOVE SL/EXIT NOW verdict on any other name is a FAIL
 * (managing a position that was never entered — the phantom-position bug the
 * Jul-10 replay caught).
 */
export function checkContract(
  text: string,
  pickSymbols: Set<string>,
  contextSymbols: Set<string>,
  allSymbols: Set<string>,
  openPositions?: Set<string>,
): ContractResult {
  const fails: string[] = [];
  const warns: string[] = [];
  if (!text.trim()) fails.push('empty text');

  const tableRows = countTableRows(text);
  if (hasTableSeparator(text) || tableRows >= 2) fails.push(`markdown table (${tableRows} table rows)`);

  // Malformed heading markers: "**### X**" or a mid-line ### — the page's
  // section splitter only matches "### " at line start, so these render as
  // body text and the whole read loses its structure (iter2 regression).
  const malformed = text.split('\n').filter((l) => l.includes('###') && !/^\s*###\s/.test(l));
  for (const l of malformed.slice(0, 3)) fails.push(`malformed heading marker (### wrapped/mid-line): "${l.trim().slice(0, 60)}"`);

  const { sections } = parseSections(text, allSymbols);
  const stock = sections.filter((s) => s.ticker != null);
  for (const s of stock) {
    if (!s.tickerFirst) fails.push(`heading not ticker-first: "### ${s.heading.slice(0, 50)}"`);
    if (s.ticker && !contextSymbols.has(s.ticker)) fails.push(`section for ${s.ticker} — never in today's picks`);
    if (s.verdict === 'OTHER') warns.push(`${s.ticker}: heading has no clear verdict (TRADE NOW/HOLD/MOVE SL/EXIT NOW/WATCH): "${s.heading.slice(0, 50)}"`);
  }
  if (!hasBottomLine(text)) warns.push('no "### Bottom line" section');
  const tradeNows = stock.filter((s) => s.verdict === 'TRADE NOW');
  if (tradeNows.length > 2) warns.push(`${tradeNows.length} TRADE NOW verdicts in one read (contract: max 2, prefer 1)`);
  if (stock.length > 3) warns.push(`${stock.length} stock sections in one read (contract: positions + ≤2 calls + ≤1 WATCH)`);
  for (const s of stock) {
    if (s.verdict === 'TRADE NOW' && s.ticker && !pickSymbols.has(s.ticker)) {
      fails.push(`TRADE NOW for ${s.ticker} which is not in THIS scan's suggestions`);
    }
    if (
      openPositions &&
      s.ticker &&
      (s.verdict === 'HOLD' || s.verdict === 'MOVE SL' || s.verdict === 'EXIT NOW') &&
      !openPositions.has(s.ticker)
    ) {
      fails.push(`${s.verdict} for ${s.ticker} but no prior read said TRADE NOW (phantom position)`);
    }
  }
  const words = wordCount(text);
  if (words > 260) warns.push(`${words} words (contract ~150, max 220)`);

  return { fails, warns, sections };
}
