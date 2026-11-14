/**
 * The patient's local date and time for the model: "2026-11-12 18:30 czwartek". The date and clock use sv-SE (ISO-like
 * digits); the weekday is Polish, the language of the answer (sv-SE with weekday gave "torsdag").
 */
export function formatPatientLocalTime(at: Date, timeZone: string): string {
  const clock = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(at);
  const weekday = new Intl.DateTimeFormat('pl-PL', { timeZone, weekday: 'long' }).format(at);
  return `${clock} ${weekday}`;
}
