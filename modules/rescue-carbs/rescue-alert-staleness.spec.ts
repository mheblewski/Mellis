import { describe, expect, it } from 'vitest';
import { isRescueIssueStale, rescueAlertIssuedAt, RESCUE_ALERT_STALE_AFTER_MINUTES, RESCUE_ALERT_STALE_MESSAGE } from './application/rescue-alert-staleness';

const now = new Date('2026-10-30T12:00:00.000Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

describe('stale rescue alerts (stale-alerts.v1)', () => {
  it('is stale only after 30 minutes; an unknown time never is', () => {
    expect(RESCUE_ALERT_STALE_AFTER_MINUTES).toBe(30);
    expect(isRescueIssueStale(ago(29), now)).toBe(false);
    expect(isRescueIssueStale(ago(30), now)).toBe(false);
    expect(isRescueIssueStale(ago(31), now)).toBe(true);
    expect(isRescueIssueStale(null, now)).toBe(false);
    expect(isRescueIssueStale('not a date', now)).toBe(false);
  });

  it('counts an alert from its reminder, else its push, else its detection', () => {
    expect(rescueAlertIssuedAt({ reminder_sent_at: ago(10), notified_at: ago(25), first_flag_at: ago(30) })).toBe(ago(10));
    expect(rescueAlertIssuedAt({ reminder_sent_at: null, notified_at: ago(25), first_flag_at: ago(30) })).toBe(ago(25));
    expect(rescueAlertIssuedAt({ reminder_sent_at: null, notified_at: null, first_flag_at: ago(30) })).toBe(ago(30));
  });

  it('the refusal says nothing went to the loop and that logging is still possible', () => {
    expect(RESCUE_ALERT_STALE_MESSAGE).toMatch(/nic nie wysłano/);
    expect(RESCUE_ALERT_STALE_MESSAGE).toMatch(/zapisać, co podano/);
  });
});
