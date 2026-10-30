/**
 * stale-alerts.v1: a rescue alert, or a rescue carb card, older than this is history. Its forecast and dose were
 * computed on a glucose that has changed since, so nothing is sent to the loop from it any more (rescue carbs to
 * Trio/Loop are refused with RESCUE_ALERT_STALE). Logging what was actually given ("Podano dosłodzenie", "Jednak podano
 * dosłodzenie", a chat card's "Podano X g" when it only logs) and "Nie podaję" stay allowed at any age.
 */
export const RESCUE_ALERT_STALE_AFTER_MINUTES = 30;

/** The loop-send refusal: the app offers logging only for such an alert or card. */
export const RESCUE_ALERT_STALE_MESSAGE = 'Alarm jest nieaktualny (sprzed ponad 30 min): do pętli nic nie wysłano. Możesz zapisać, co podano.';

/** When the alert last reached the caregivers: its reminder, else its push, else its first detection. */
export function rescueAlertIssuedAt(alert: { reminder_sent_at?: string | null; notified_at?: string | null; first_flag_at?: string | null }): string | null {
  return alert.reminder_sent_at ?? alert.notified_at ?? alert.first_flag_at ?? null;
}

/** True when `issuedAt` is more than 30 minutes before `now`; an unknown or unreadable time is never stale. */
export function isRescueIssueStale(issuedAt: string | Date | null | undefined, now: Date): boolean {
  if (issuedAt === null || issuedAt === undefined) return false;
  const at = issuedAt instanceof Date ? issuedAt.getTime() : Date.parse(issuedAt);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at > RESCUE_ALERT_STALE_AFTER_MINUTES * 60_000;
}
