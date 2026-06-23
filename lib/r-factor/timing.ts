/**
 * R-Factor library — entry-time gate.
 *
 *  • isAfterEntryTime — is it past the entry window (default 9:45 IST) and is the
 *    market open? TradeFinder reads R-Factor only after ~9:45, once the opening
 *    auction noise has settled. This is a gate, not a scored factor.
 *
 * IST is derived with Intl (Asia/Kolkata) — no timezone library, no app coupling.
 */

export interface EntryTimeStatus {
  /** Current time in IST, "HH:MM". */
  istTime: string;
  /** Weekday and within NSE cash hours 09:15–15:30. */
  marketOpen: boolean;
  /** marketOpen AND past the entry window. */
  afterEntryWindow: boolean;
}

const MARKET_OPEN_MIN = 9 * 60 + 15; // 09:15 IST
const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30 IST

/** Minutes-since-midnight + weekday for a Date, evaluated in IST. */
function istClock(now: Date): { minutes: number; weekday: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0; // some engines emit "24" for midnight
  const minute = Number(get('minute'));
  const weekday = get('weekday');
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { minutes: hour * 60 + minute, weekday, hhmm };
}

/** Parse "HH:MM" to minutes-since-midnight (invalid parts count as 0). */
function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** #10 Time 9:45 AM after — entry-window + market-hours gate (IST). */
export function isAfterEntryTime(now: Date, entryTimeIST = '09:45'): EntryTimeStatus {
  const { minutes, weekday, hhmm } = istClock(now);
  const isWeekday = weekday !== 'Sat' && weekday !== 'Sun';
  const marketOpen = isWeekday && minutes >= MARKET_OPEN_MIN && minutes <= MARKET_CLOSE_MIN;
  const afterEntryWindow = marketOpen && minutes >= parseHHMM(entryTimeIST);
  return { istTime: hhmm, marketOpen, afterEntryWindow };
}
