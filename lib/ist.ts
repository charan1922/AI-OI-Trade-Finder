/**
 * IST helpers — single source of truth for Asia/Kolkata time on a UTC server
 * (Railway runs UTC; all market-hour logic needs IST). Every call site that
 * previously computed `new Date(Date.now() + (330 + offset) * 60_000)` should
 * import from here instead.
 */

/** Current time as a Date shifted to IST wall-clock (the Date object's
 *  getHours()/getMinutes() etc. will read IST values). */
export function nowIST(): Date {
  return new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60_000);
}

/** "HH:mm:ss" in IST. */
export function nowISTClock(): string {
  const ist = nowIST();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(ist.getHours())}:${pad(ist.getMinutes())}:${pad(ist.getSeconds())}`;
}

/** "YYYY-MM-DD" in IST. */
export function todayIST(): string {
  const ist = nowIST();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${ist.getFullYear()}-${pad(ist.getMonth() + 1)}-${pad(ist.getDate())}`;
}

/** Minutes since midnight in IST. */
export function minuteOfDayIST(): number {
  const ist = nowIST();
  return ist.getHours() * 60 + ist.getMinutes();
}