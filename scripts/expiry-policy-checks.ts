/** Pure, DB-free regression matrix for the stock-option expiry roll policy. */
import {
  checkOptionExpiryForEntry,
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

  const futureExpiryCases = [
    { label: 'August monthly', before: '2026-08-21', inWeek: '2026-08-24', expiryDate: '2026-08-25' },
    { label: 'September monthly', before: '2026-09-25', inWeek: '2026-09-28', expiryDate: '2026-09-29' },
    // NSE revised the March 2026 contract from Tue 31-Mar to Mon 30-Mar. The
    // actual Monday expiry starts its own calendar week.
    { label: 'holiday-shifted March monthly', before: '2026-03-27', inWeek: '2026-03-30', expiryDate: '2026-03-30' },
    // Synthetic Friday expiry proves the algorithm follows the stored date's
    // Monday-Sunday week and does not assume Tuesday.
    { label: 'Friday-shifted monthly', before: '2026-11-20', inWeek: '2026-11-23', expiryDate: '2026-11-27' },
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
}
