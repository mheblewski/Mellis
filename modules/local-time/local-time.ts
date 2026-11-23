/**
 * Local wall-clock time of the patient (DST included): the local date, minute of the day and weekday of an instant, and
 * the instant of a local time. Pure functions, no I/O. Moved out of the retired settings-insights module (2026-11-21).
 */
const MINUTE_MS = 60_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let found = formatters.get(timezone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timezone, found);
  }
  return found;
}

/** Local date (YYYY-MM-DD) and minute of the day (0–1439) of an instant in the patient's timezone (DST included). */
export function localParts(ms: number, timezone: string): { date: string; minute: number; weekday: number } {
  const parts = formatter(timezone).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  // Weekday of the local date (0 = Sunday), computed from the date itself so it does not depend on the host zone.
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return { date, minute, weekday };
}

/** The instant of a local wall-clock time (first match on a DST fold, next valid minute in a gap). */
export function localInstant(date: string, minute: number, timezone: string): number {
  const [year, month, day] = date.split('-').map(Number);
  let guess = Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60);
  // Two passes of offset correction converge for every real timezone.
  for (let pass = 0; pass < 3; pass += 1) {
    const local = localParts(guess, timezone);
    const [ly, lm, ld] = local.date.split('-').map(Number);
    const diffMinutes = (Date.UTC(ly, lm - 1, ld) - Date.UTC(year, month - 1, day)) / MINUTE_MS + (local.minute - minute);
    if (diffMinutes === 0) break;
    guess -= diffMinutes * MINUTE_MS;
  }
  return guess;
}
