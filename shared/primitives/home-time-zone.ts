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
