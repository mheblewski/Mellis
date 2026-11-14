/** The patient's home clock when TZ says nothing usable (unset, UTC or not a time zone). */
export const DEFAULT_HOME_TIME_ZONE = 'Europe/Warsaw';

/**
 * The time zone of the patient's home, as the worker and the API read days and hours: TZ when it is set, not UTC and a
 * valid IANA zone, otherwise Europe/Warsaw. A server clock in UTC never becomes the patient's day.
 */
export function resolveHomeTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TZ?.trim();
  if (configured && configured !== 'UTC') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: configured });
      return configured;
    } catch {
      // not a time zone: fall through to the default
    }
  }
  return DEFAULT_HOME_TIME_ZONE;
}

/** UTC offset of a zone at an instant, in minutes (Europe/Warsaw in winter: 60); null when the zone is not valid. */
function offsetMinutesAt(timeZone: string, atMs: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(atMs))
      .reduce<Record<string, number>>((acc, part) => (part.type === 'literal' ? acc : { ...acc, [part.type]: Number(part.value) }), {});
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    return Math.round((asUtc - Math.floor(atMs / 60_000) * 60_000) / 60_000);
  } catch {
    return null;
  }
}

/**
 * The patient's zone from a loop profile's time zone. Loop (and older Trio) upload a fixed offset ("ETC/GMT-1" = UTC+1,
 * no summer time): read as such, every local time is an hour off after the clock change until a new profile comes
 * (audit 2026-11-12). A fixed offset that matches the home zone at `atMs` (the profile's time) is the home zone; any
 * other fixed offset keeps its offset in IANA spelling; a named zone is kept. Empty or invalid: null.
 */
export function patientTimeZoneFromProfile(raw: unknown, atMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  const fixed = /^etc\/(?:gmt|utc)([+-]\d{1,2})?$/i.exec(value);
  if (!fixed) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return value;
    } catch {
      return null;
    }
  }
  const canonical = fixed[1] ? `Etc/GMT${fixed[1].replace(/^([+-])0+(\d)/, '$1$2')}` : 'Etc/GMT';
  const home = resolveHomeTimeZone(env);
  const at = Number.isFinite(atMs) ? atMs : Date.now();
  const fixedOffset = offsetMinutesAt(canonical, at);
  if (fixedOffset === null) return null;
  return offsetMinutesAt(home, at) === fixedOffset ? home : canonical;
}
