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

/** Pick the nearest eligible expiry from the contract master's available
 * months. Invalid/duplicate rows are harmless; no eligible month means no
 * contract and therefore no trade. */
export function selectOptionExpiryForEntry(tradeDate: string, expiryDates: readonly string[]): string | null {
  const ordered = [
    ...new Set(expiryDates.map(normalizeIsoDate).filter((expiry): expiry is string => expiry != null)),
  ].sort();
  return ordered.find((expiryDate) => checkOptionExpiryForEntry(tradeDate, expiryDate).allow) ?? null;
}
