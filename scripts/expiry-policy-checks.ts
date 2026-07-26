/** Pure, DB-free regression matrix for the stock-option expiry roll policy. */
import {
  activeOptionExpiryMonths,
  checkOptionExpiryForEntry,
  checkOptionMonthCoverage,
  checkOptionSeriesCoverage,
  checkOptionUnderlyingCoverage,
  normalizeIsoDate,
  optionExpiryWeekStart,
  selectOptionExpiryForEntry,
} from '../lib/options/expiry-policy';

type Check = (name: string, ok: boolean, detail?: string) => void;

export function runExpiryPolicyChecks(check: Check): void {
  check(
    'expiry: 28-Jul belongs to the calendar week starting Monday 27-Jul',
    optionExpiryWeekStart('2026-07-28') === '2026-07-27'
  );
  check(
    'expiry: Friday 24-Jul remains eligible because it is in the prior calendar week',
    checkOptionExpiryForEntry('2026-07-24', '2026-07-28').allow
  );
  check(
    'expiry: Monday 27-Jul blocks the Tuesday 28-Jul contract',
    !checkOptionExpiryForEntry('2026-07-27', '2026-07-28').allow
  );
  check(
    'expiry: expiry day itself remains blocked',
    !checkOptionExpiryForEntry('2026-07-28', '2026-07-28').allow
  );
  check(
    'expiry: 24-Jul can enter the next-month 25-Aug contract',
    checkOptionExpiryForEntry('2026-07-24', '2026-08-25').allow
  );
  check(
    'expiry: malformed or missing expiry fails closed',
    !checkOptionExpiryForEntry('2026-07-24', null).allow &&
      !checkOptionExpiryForEntry('bad-date', '2026-08-25').allow
  );
  check(
    'expiry: a complete Prisma-style RFC3339 DateTime is normalized',
    normalizeIsoDate('2026-07-28T00:00:00.000Z') === '2026-07-28' &&
      checkOptionExpiryForEntry('2026-07-27', '2026-07-28T00:00:00.000Z').allow === false
  );
  check(
    'expiry: valid date prefix plus arbitrary garbage fails closed',
    normalizeIsoDate('2026-07-28garbage') == null &&
      normalizeIsoDate('2026-07-28-WRONG') == null &&
      checkOptionExpiryForEntry('2026-07-24', '2026-07-28garbage').allow === false
  );

  const futureExpiryCases = [
    { label: 'August monthly', before: '2026-08-21', inWeek: '2026-08-24', expiryDate: '2026-08-25' },
    { label: 'September monthly', before: '2026-09-25', inWeek: '2026-09-28', expiryDate: '2026-09-29' },
    // NSE revised the March 2026 contract from Tue 31-Mar to Mon 30-Mar. The
    // actual Monday expiry starts its own calendar week.
    { label: 'holiday-shifted March monthly', before: '2026-03-27', inWeek: '2026-03-30', expiryDate: '2026-03-30' },
    // Synthetic Friday expiry proves the algorithm follows the stored date's
    // Monday-Sunday week and does not assume Tuesday.
    { label: 'Friday-shifted monthly', before: '2026-11-20', inWeek: '2026-11-23', expiryDate: '2026-11-27' },
    // Future-year synthetic dates prove the rule has no hard-coded 2026/month
    // table: it always derives the Monday from the exchange-provided expiry.
    { label: '2027 future monthly', before: '2027-07-23', inWeek: '2027-07-26', expiryDate: '2027-07-29' },
    { label: '2028 future monthly', before: '2028-07-21', inWeek: '2028-07-24', expiryDate: '2028-07-27' },
  ];
  for (const expiryCase of futureExpiryCases) {
    check(
      `expiry: ${expiryCase.label} is allowed in the prior calendar week`,
      checkOptionExpiryForEntry(expiryCase.before, expiryCase.expiryDate).allow
    );
    check(
      `expiry: ${expiryCase.label} is blocked in its expiry calendar week`,
      !checkOptionExpiryForEntry(expiryCase.inWeek, expiryCase.expiryDate).allow
    );
  }
  check(
    'expiry: an already-expired contract is blocked',
    !checkOptionExpiryForEntry('2026-07-29', '2026-07-28').allow
  );
  const listed = ['2026-07-28', '2026-08-25', '2026-09-29'];
  check(
    'expiry selection: prior Friday keeps the July contract',
    selectOptionExpiryForEntry('2026-07-24', listed) === '2026-07-28'
  );
  check(
    'expiry selection: July expiry week rolls to August',
    selectOptionExpiryForEntry('2026-07-27', listed) === '2026-08-25'
  );
  check(
    'expiry selection: August prior Friday keeps August',
    selectOptionExpiryForEntry('2026-08-21', listed) === '2026-08-25'
  );
  check(
    'expiry selection: August expiry week rolls to September',
    selectOptionExpiryForEntry('2026-08-24', listed) === '2026-09-29'
  );
  check(
    'expiry selection: no eligible listed month means no contract',
    selectOptionExpiryForEntry('2026-09-28', listed) == null
  );

  // Month-coverage guard. A row-count floor cannot catch a missing SERIES: one
  // month is only ~1/3 of the option rows, so a truncated CSV still parses
  // "large" while the resolver quietly rolls past the intended next month.
  const stored = ['2026-07-28', '2026-08-25', '2026-09-29'];
  check(
    'coverage: expired months are excluded from the count',
    activeOptionExpiryMonths('2026-07-29', stored).join(',') === '2026-08-25,2026-09-29'
  );
  check(
    'coverage: an identical download passes',
    checkOptionMonthCoverage('2026-07-27', stored, stored).ok
  );
  check(
    'coverage: THE BUG — August missing from the download is refused, so the resolver cannot skip to September',
    (() => {
      const v = checkOptionMonthCoverage('2026-07-27', ['2026-07-28', '2026-09-29'], stored);
      return !v.ok && v.reason?.includes('2026-08-25') === true;
    })(),
    checkOptionMonthCoverage('2026-07-27', ['2026-07-28', '2026-09-29'], stored).reason ?? 'no reason'
  );
  check(
    'coverage: the normal cycle (July expires, October is listed) passes',
    checkOptionMonthCoverage('2026-07-29', ['2026-08-25', '2026-09-29', '2026-10-27'], stored).ok
  );
  check(
    'coverage: the far month listed a day late does NOT false-abort the sync',
    checkOptionMonthCoverage('2026-07-29', ['2026-08-25', '2026-09-29'], stored).ok
  );
  check(
    'coverage: a duplicated month is not counted twice',
    !checkOptionMonthCoverage('2026-07-27', ['2026-07-28', '2026-07-28', '2026-09-29'], stored).ok
  );
  check(
    'coverage: malformed expiry strings are ignored, not trusted as a month',
    !checkOptionMonthCoverage('2026-07-27', ['2026-07-28', '2026-08-25-WRONG', '2026-09-29'], stored).ok
  );
  check(
    'coverage: RFC3339 master timestamps normalize to the same month',
    checkOptionMonthCoverage(
      '2026-07-27',
      ['2026-07-28T09:00:00.000Z', '2026-08-25T09:00:00.000Z', '2026-09-29T09:00:00.000Z'],
      stored
    ).ok
  );
  check(
    'coverage: first sync (no stored baseline) is allowed — row floors are the only guard there',
    checkOptionMonthCoverage('2026-07-27', ['2026-08-25'], []).ok
  );
  check(
    'coverage: a fully expired baseline is not treated as a shrink',
    checkOptionMonthCoverage('2026-10-01', ['2026-10-27'], stored).ok
  );
  check(
    'coverage: EQUAL COUNT but a different month — Jul/Sep/Oct vs Jul/Aug/Sep — is refused',
    (() => {
      const v = checkOptionMonthCoverage('2026-07-27', ['2026-07-28', '2026-09-29', '2026-10-27'], stored);
      return !v.ok && v.reason?.includes('2026-08-25') === true;
    })(),
    checkOptionMonthCoverage('2026-07-27', ['2026-07-28', '2026-09-29', '2026-10-27'], stored).reason ?? 'no reason'
  );

  // Per-symbol / per-side coverage. The aggregate guards above cannot see ONE
  // stock losing ONE month on ONE side — and that is exactly what the resolver
  // would roll past during expiry week, because it only ever queries that
  // symbol and that side.
  const series = (underlying: string, optionType: string, expiryDate: string) => ({
    underlying,
    optionType,
    expiryDate,
  });
  const fullBook = [
    series('INFY', 'CE', '2026-07-28'),
    series('INFY', 'PE', '2026-07-28'),
    series('INFY', 'CE', '2026-08-25'),
    series('INFY', 'PE', '2026-08-25'),
    series('INFY', 'CE', '2026-09-29'),
    series('INFY', 'PE', '2026-09-29'),
    series('TCS', 'CE', '2026-07-28'),
    series('TCS', 'CE', '2026-08-25'),
    series('TCS', 'CE', '2026-09-29'),
  ];
  check('series: an identical download passes', checkOptionSeriesCoverage('2026-07-27', fullBook, fullBook).ok);
  check(
    'series: THE BUG — INFY August CE missing while every GLOBAL month still exists is refused',
    (() => {
      const damaged = fullBook.filter((r) => !(r.underlying === 'INFY' && r.optionType === 'CE' && r.expiryDate === '2026-08-25'));
      const global = checkOptionMonthCoverage('2026-07-27', damaged.map((r) => r.expiryDate), fullBook.map((r) => r.expiryDate));
      const v = checkOptionSeriesCoverage('2026-07-27', damaged, fullBook);
      // The aggregate guard is blind to it — that is the whole point.
      return global.ok && !v.ok && v.missing.includes('INFY|CE|2026-08');
    })()
  );
  check(
    'series: INFY August CE missing is caught even though INFY August PE remains',
    (() => {
      const damaged = fullBook.filter((r) => !(r.underlying === 'INFY' && r.optionType === 'CE' && r.expiryDate === '2026-08-25'));
      const v = checkOptionSeriesCoverage('2026-07-27', damaged, fullBook);
      return !v.ok && v.missing.length === 1 && v.missing[0] === 'INFY|CE|2026-08';
    })()
  );
  check(
    'series: a holiday moving 25-Aug to 24-Aug is the SAME series, not a missing one',
    checkOptionSeriesCoverage(
      '2026-07-27',
      fullBook.map((r) => (r.expiryDate === '2026-08-25' ? { ...r, expiryDate: '2026-08-24' } : r)),
      fullBook
    ).ok
  );
  check(
    'series: the normal cycle (July expires, October listed) passes',
    checkOptionSeriesCoverage(
      '2026-07-29',
      [
        ...fullBook.filter((r) => r.expiryDate !== '2026-07-28'),
        series('INFY', 'CE', '2026-10-27'),
        series('INFY', 'PE', '2026-10-27'),
        series('TCS', 'CE', '2026-10-27'),
      ],
      fullBook
    ).ok
  );
  check(
    'series: a whole stock de-listed from F&O is allowed (mass loss is the underlying-count guard)',
    checkOptionSeriesCoverage('2026-07-27', fullBook.filter((r) => r.underlying !== 'TCS'), fullBook).ok
  );
  check(
    'series: RFC3339 master timestamps match plain dates',
    checkOptionSeriesCoverage(
      '2026-07-27',
      fullBook.map((r) => ({ ...r, expiryDate: `${r.expiryDate}T09:00:00.000Z` })),
      fullBook
    ).ok
  );
  check(
    'series: rows with a malformed side or expiry are ignored, never counted as coverage',
    !checkOptionSeriesCoverage(
      '2026-07-27',
      [
        ...fullBook.filter((r) => !(r.underlying === 'INFY' && r.optionType === 'CE' && r.expiryDate === '2026-08-25')),
        series('INFY', 'XX', '2026-08-25'),
        series('INFY', 'CE', '2026-08-25-WRONG'),
      ],
      fullBook
    ).ok
  );
  check('series: first sync with no baseline is allowed', checkOptionSeriesCoverage('2026-07-27', fullBook, []).ok);

  check(
    'underlyings: an exact match and a small dip both pass, a >10% collapse is refused',
    checkOptionUnderlyingCoverage(210, 210).ok &&
      checkOptionUnderlyingCoverage(200, 210).ok &&
      !checkOptionUnderlyingCoverage(150, 210).ok &&
      checkOptionUnderlyingCoverage(5, 0).ok
  );
  check(
    'underlyings: the refusal names both counts',
    checkOptionUnderlyingCoverage(150, 210).reason?.includes('210→150') === true,
    checkOptionUnderlyingCoverage(150, 210).reason ?? 'no reason'
  );
}
