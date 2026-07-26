/**
 * Stock-option expiry roll policy.
 *
 * New entries must not use a contract during the Monday-Sunday calendar week
 * containing its actual expiry date. The exchange-provided contract expiry is
 * authoritative, including holiday shifts. Open positions are not force-exited
 * here — this is a new-entry eligibility rule.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Accept only an exact ISO calendar date or a complete RFC3339 timestamp.
 * Contract-master DateTime values arrive through Prisma as timestamps; a valid
 * date prefix followed by arbitrary text must never become a tradable expiry. */
export function normalizeIsoDate(raw: string): string | null {
  const exact = raw.match(ISO_DATE);
  if (exact) {
    const epoch = Date.UTC(Number(exact[1]), Number(exact[2]) - 1, Number(exact[3]));
    return new Date(epoch).toISOString().slice(0, 10) === raw ? raw : null;
  }
  if (!RFC3339_TIMESTAMP.test(raw)) return null;
  const epoch = Date.parse(raw);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString().slice(0, 10) : null;
}

function isoDayEpoch(raw: string): number | null {
  const iso = normalizeIsoDate(raw);
  return iso == null ? null : Date.parse(`${iso}T00:00:00.000Z`);
}

/** Calendar DTE is retained for audit text only; it is NOT the roll rule. */
export function optionCalendarDte(tradeDate: string, expiryDate: string): number | null {
  const tradeEpoch = isoDayEpoch(tradeDate);
  const expiryEpoch = isoDayEpoch(expiryDate);
  if (tradeEpoch == null || expiryEpoch == null) return null;
  return Math.round((expiryEpoch - tradeEpoch) / 86_400_000);
}

/** Monday of the calendar week containing the exchange-provided expiry date. */
export function optionExpiryWeekStart(expiryDate: string): string | null {
  const expiryEpoch = isoDayEpoch(expiryDate);
  if (expiryEpoch == null) return null;
  const weekday = new Date(expiryEpoch).getUTCDay(); // Sun=0 ... Sat=6
  const daysSinceMonday = (weekday + 6) % 7;
  return new Date(expiryEpoch - daysSinceMonday * 86_400_000).toISOString().slice(0, 10);
}

export function checkOptionExpiryForEntry(
  tradeDate: string,
  expiryDate: string | null | undefined
): { allow: boolean; dte: number | null; reason: string | null } {
  if (!expiryDate) {
    return { allow: false, dte: null, reason: 'option expiry is missing — failing closed' };
  }
  const dte = optionCalendarDte(tradeDate, expiryDate);
  const tradeEpoch = isoDayEpoch(tradeDate);
  const expiryEpoch = isoDayEpoch(expiryDate);
  const weekStart = optionExpiryWeekStart(expiryDate);
  const weekStartEpoch = weekStart ? isoDayEpoch(weekStart) : null;
  if (dte == null || tradeEpoch == null || expiryEpoch == null || weekStartEpoch == null) {
    return {
      allow: false,
      dte: null,
      reason: `invalid trade/expiry date (${tradeDate}, ${expiryDate}) — failing closed`,
    };
  }
  if (dte < 0) {
    return {
      allow: false,
      dte,
      reason: `option contract expired on ${expiryDate.slice(0, 10)} — use an active contract`,
    };
  }
  if (tradeEpoch >= weekStartEpoch && tradeEpoch <= expiryEpoch) {
    return {
      allow: false,
      dte,
      reason:
        `option expires this calendar week on ${expiryDate.slice(0, 10)} — ` +
        `near-month entries are blocked from Monday ${weekStart}; use the next-month contract`,
    };
  }
  return { allow: true, dte, reason: null };
}

/** Distinct still-tradable expiry months in a set of contract-master expiries.
 * Expired dates are excluded so a legitimate month roll-off does not look like
 * a missing month. */
export function activeOptionExpiryMonths(
  tradeDate: string,
  expiryDates: readonly (string | null | undefined)[]
): string[] {
  const tradeEpoch = isoDayEpoch(tradeDate);
  if (tradeEpoch == null) return [];
  const active = new Set<string>();
  for (const raw of expiryDates) {
    if (raw == null) continue;
    const iso = normalizeIsoDate(raw);
    if (iso == null) continue;
    const epoch = isoDayEpoch(iso);
    if (epoch != null && epoch >= tradeEpoch) active.add(iso);
  }
  return [...active].sort();
}

/**
 * Completeness guard for a freshly parsed contract master.
 *
 * A row-count floor cannot catch the dangerous truncation: losing ONE monthly
 * series is only ~1/3 of the option rows, so the parse still looks large — but
 * the resolver would then skip the intended next month and silently select the
 * one after it. The honest signal is COVERAGE: a download must list at least as
 * many still-tradable expiry months as the snapshot it is about to replace.
 *
 * Expired months are excluded on both sides, so the normal cycle (the near
 * month expires, a new far month is listed) can never trip this — and it does
 * not trip either if the exchange lists the new far month a day late.
 */
export function checkOptionMonthCoverage(
  tradeDate: string,
  parsedExpiries: readonly (string | null | undefined)[],
  existingExpiries: readonly (string | null | undefined)[]
): { ok: boolean; parsedMonths: string[]; existingMonths: string[]; reason: string | null } {
  const parsedMonths = activeOptionExpiryMonths(tradeDate, parsedExpiries);
  const existingMonths = activeOptionExpiryMonths(tradeDate, existingExpiries);
  // No usable baseline (first sync, or every stored month has expired) — the
  // absolute row floors are the only guard available, and they already ran.
  if (existingMonths.length === 0) return { ok: true, parsedMonths, existingMonths, reason: null };
  // Compare MEMBERSHIP, not counts. Counting passed July/Aug/Sep → July/Sep/Oct
  // (3 vs 3) even though August had vanished — the exact hole this guard exists
  // to close (PR#22 re-review). Months are keyed YYYY-MM so an exchange holiday
  // moving 25-Aug to 24-Aug is the same series, not a missing one.
  const parsedKeys = new Set(parsedMonths.map((month) => month.slice(0, 7)));
  const missing = existingMonths.filter((month) => !parsedKeys.has(month.slice(0, 7)));
  if (missing.length === 0) return { ok: true, parsedMonths, existingMonths, reason: null };
  return {
    ok: false,
    parsedMonths,
    existingMonths,
    reason:
      `option expiry coverage lost ${missing.length} of ${existingMonths.length} unexpired month(s) ` +
      `(missing ${missing.join(', ')}) — a listed series is absent from this download`,
  };
}

/** One contract-master option row, reduced to what coverage needs. */
export interface OptionSeriesRow {
  underlying: string | null | undefined;
  optionType: string | null | undefined;
  expiryDate: string | null | undefined;
}

/** `UNDERLYING|CE|YYYY-MM` for every still-tradable series in the rows. */
export function activeOptionSeries(tradeDate: string, rows: readonly OptionSeriesRow[]): Set<string> {
  const tradeEpoch = isoDayEpoch(tradeDate);
  const series = new Set<string>();
  if (tradeEpoch == null) return series;
  for (const row of rows) {
    const underlying = row.underlying?.trim();
    const side = row.optionType?.trim().toUpperCase();
    if (!underlying || (side !== 'CE' && side !== 'PE') || row.expiryDate == null) continue;
    const iso = normalizeIsoDate(row.expiryDate);
    if (iso == null) continue;
    const epoch = isoDayEpoch(iso);
    if (epoch == null || epoch < tradeEpoch) continue;
    series.add(`${underlying}|${side}|${iso.slice(0, 7)}`);
  }
  return series;
}

/**
 * PER-SYMBOL, PER-SIDE completeness — the check the aggregate guards cannot make.
 *
 * A download can keep every global expiry month, every underlying and 60k+ rows
 * while ONE stock quietly loses ONE month on ONE side. The resolver only ever
 * looks at that stock and that side, so during expiry week it would skip the
 * missing next month and select the one after it — precisely the wrong-contract
 * outcome these guards exist to prevent (PR#22 re-review).
 *
 * An underlying that disappears ENTIRELY is not flagged here: that is what a
 * legitimate F&O de-listing looks like, and mass loss is already caught by the
 * underlying-count guard. Only a stock that is still present yet lost a series
 * is treated as a damaged download.
 */
export function checkOptionSeriesCoverage(
  tradeDate: string,
  parsedRows: readonly OptionSeriesRow[],
  existingRows: readonly OptionSeriesRow[]
): { ok: boolean; missing: string[]; parsedSeries: number; existingSeries: number; reason: string | null } {
  const parsed = activeOptionSeries(tradeDate, parsedRows);
  const existing = activeOptionSeries(tradeDate, existingRows);
  const parsedUnderlyings = new Set([...parsed].map((key) => key.split('|')[0]));
  const missing = [...existing]
    .filter((key) => !parsed.has(key) && parsedUnderlyings.has(key.split('|')[0]))
    .sort();
  if (missing.length === 0) {
    return { ok: true, missing, parsedSeries: parsed.size, existingSeries: existing.size, reason: null };
  }
  const shown = missing.slice(0, 5).join(', ');
  return {
    ok: false,
    missing,
    parsedSeries: parsed.size,
    existingSeries: existing.size,
    reason:
      `${missing.length} listed option series vanished for symbols that are still in the file ` +
      `(e.g. ${shown}${missing.length > 5 ? ', …' : ''}) — the download is damaged, not a de-listing`,
  };
}

/**
 * Option UNDERLYING coverage. Strikes churn daily, but the set of stocks with
 * listed options does not (~210), so the same 10% rule the stable instruments
 * use is safe here and catches a file truncated part-way through.
 */
export function checkOptionUnderlyingCoverage(
  parsedUnderlyings: number,
  existingUnderlyings: number,
  minRetainRatio = 0.9
): { ok: boolean; reason: string | null } {
  if (existingUnderlyings <= 0) return { ok: true, reason: null };
  if (parsedUnderlyings >= existingUnderlyings * minRetainRatio) return { ok: true, reason: null };
  return {
    ok: false,
    reason:
      `option underlyings dropped ${existingUnderlyings}→${parsedUnderlyings} ` +
      `(>${Math.round((1 - minRetainRatio) * 100)}%) — the download is truncated`,
  };
}

/** Pick the nearest eligible expiry from the contract master's available
 * months. Invalid/duplicate rows are harmless; no eligible month means no
 * contract and therefore no trade. */
export function selectOptionExpiryForEntry(tradeDate: string, expiryDates: readonly string[]): string | null {
  const ordered = [
    ...new Set(expiryDates.map(normalizeIsoDate).filter((expiry): expiry is string => expiry != null)),
  ].sort();
  return ordered.find((expiryDate) => checkOptionExpiryForEntry(tradeDate, expiryDate).allow) ?? null;
}
