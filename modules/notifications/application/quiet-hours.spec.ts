import { describe, expect, it } from 'vitest';
import { inQuietHours, parseQuietMinute, quietDecision, quietEndAfter, quietEndsAt, quietStartsAt, urgentLowSustained, type QuietHoursSettings } from './quiet-hours';

const night: QuietHoursSettings = { enabled: true, start_minute: 22 * 60, end_minute: 7 * 60, time_zone: 'Europe/Warsaw', low_warnings: true };
// 2026-11-22 is CET (UTC+1).
const local = (hhmm: string, date = '2026-11-22') => new Date(`${date}T${hhmm}:00+01:00`);

describe('quiet hours window', () => {
  it('spans midnight in the phone zone and ends at the end minute', () => {
    expect(inQuietHours(night, local('21:59'))).toBe(false);
    expect(inQuietHours(night, local('22:00'))).toBe(true);
    expect(inQuietHours(night, local('03:10'))).toBe(true);
    expect(inQuietHours(night, local('06:59'))).toBe(true);
    expect(inQuietHours(night, local('07:00'))).toBe(false);
  });

  it('is off when disabled or when start equals end, and works within one day', () => {
    expect(inQuietHours({ ...night, enabled: false }, local('23:00'))).toBe(false);
    expect(inQuietHours({ ...night, end_minute: night.start_minute }, local('23:00'))).toBe(false);
    const nap = { ...night, start_minute: 13 * 60, end_minute: 15 * 60 };
    expect(inQuietHours(nap, local('14:00'))).toBe(true);
    expect(inQuietHours(nap, local('15:00'))).toBe(false);
  });

  it('gives the end of the quiet hours, tomorrow before midnight and across DST', () => {
    expect(quietEndsAt(night, local('23:30'))?.toISOString()).toBe('2026-11-23T06:00:00.000Z');
    expect(quietEndsAt(night, local('03:00'))?.toISOString()).toBe('2026-11-22T06:00:00.000Z');
    expect(quietEndsAt(night, local('12:00'))).toBeNull();
    // 2026-03-29 02:00 CET → 03:00 CEST: 7:00 is 05:00 UTC that morning.
    expect(quietEndsAt(night, new Date('2026-03-28T23:00:00Z'))?.toISOString()).toBe('2026-03-29T05:00:00.000Z');
  });
});

describe('next quiet hours', () => {
  it('gives the next start and the end after it', () => {
    expect(quietStartsAt(night, local('21:30'))?.toISOString()).toBe('2026-11-22T21:00:00.000Z');
    expect(quietStartsAt(night, local('23:00'))?.toISOString()).toBe('2026-11-23T21:00:00.000Z');
    expect(quietStartsAt({ ...night, enabled: false }, local('21:30'))).toBeNull();
    expect(quietEndAfter(night, new Date('2026-11-22T21:00:00Z')).toISOString()).toBe('2026-11-23T06:00:00.000Z');
    const nap = { ...night, start_minute: 13 * 60, end_minute: 15 * 60 };
    expect(quietEndAfter(nap, local('13:00')).toISOString()).toBe('2026-11-22T14:00:00.000Z');
  });
});

describe('quiet decision', () => {
  const at = local('02:00');

  it('sends everything as before outside quiet hours', () => {
    expect(quietDecision('glucose_alert', 'high', night, {}, local('12:00'))).toBe('send');
    expect(quietDecision('dose_given', null, night, {}, local('12:00'))).toBe('send');
    expect(quietDecision('glucose_alert', 'low', null, {}, at)).toBe('send');
  });

  it('drops glucose pushes, below 54 too, until it stayed there 20 minutes', () => {
    for (const kind of ['high', 'very_high', 'peak', 'low', 'falling', 'fast_fall', 'in_range', 'stuck']) {
      expect(quietDecision('glucose_alert', kind, night, {}, at)).toBe('drop');
    }
    expect(quietDecision('glucose_alert', 'very_low', night, {}, at)).toBe('drop');
    expect(quietDecision('glucose_alert', 'very_low', night, { urgentLowSustained: true }, at)).toBe('time_sensitive');
    expect(quietDecision('glucose_alert', 'very_low', { ...night, low_warnings: false }, { urgentLowSustained: true }, at)).toBe('time_sensitive');
  });

  it('lets the low warnings through time-sensitive with the switch on, and drops them with it off', () => {
    for (const [type, kind] of [['rescue_carbs', null], ['situation_check', null], ['glucose_alert', 'prediction_low']] as const) {
      expect(quietDecision(type, kind, night, {}, at)).toBe('time_sensitive');
      expect(quietDecision(type, kind, { ...night, low_warnings: false }, {}, at)).toBe('drop');
    }
  });

  it('lets no readings through only after an hour, with the switch on', () => {
    expect(quietDecision('glucose_alert', 'no_data', night, { noDataMinutes: 30 }, at)).toBe('drop');
    expect(quietDecision('glucose_alert', 'no_data', night, { noDataMinutes: 60 }, at)).toBe('time_sensitive');
    expect(quietDecision('glucose_alert', 'no_data', { ...night, low_warnings: false }, { noDataMinutes: 90 }, at)).toBe('drop');
  });

  it('drops another caregiver\'s dose news, holds equipment and information, and sends the rest as before', () => {
    expect(quietDecision('dose_given', null, night, {}, at)).toBe('drop');
    for (const type of ['reservoir_low', 'battery_low', 'site_change', 'therapy_pattern', 'app_update', 'meal_plan', 'remote_settings_handoff', 'prediction_comparison']) {
      expect(quietDecision(type, null, night, {}, at)).toBe('hold');
    }
    for (const type of ['planned_bolus', 'wbt_reminder', 'care_reminder', 'conversation_answer', 'meal_chat_answer', 'conversation_question']) {
      expect(quietDecision(type, null, night, {}, at)).toBe('send');
    }
  });
});

describe('below 54 for 20 minutes', () => {
  const series = (values: number[], endIso = '2026-11-22T02:00:00Z') =>
    values.map((value, i) => ({ at: new Date(Date.parse(endIso) - (values.length - 1 - i) * 5 * 60_000).toISOString(), value }));

  it('needs every reading of 20 minutes under 54 and no rise at the end', () => {
    // 52 at 1:40 … 47 at 2:00: 20 minutes under 54.
    expect(urgentLowSustained(series([60, 52, 50, 49, 48, 47]), -1)).toBe(true);
    expect(urgentLowSustained(series([60, 52, 50, 49, 48, 47]), 1)).toBe(false);
    // 15 minutes only.
    expect(urgentLowSustained(series([60, 58, 50, 49, 48, 47]), -1)).toBe(false);
    expect(urgentLowSustained(series([52, 50, 49]), -1)).toBe(false);
    expect(urgentLowSustained(series([52, 50, 55, 49, 48, 47]), -1)).toBe(false);
  });

  it('does not count across a gap in readings', () => {
    const gap = series([52, 50, 49, 48, 47, 46]).filter((_, i) => i !== 2 && i !== 3);
    expect(urgentLowSustained(gap, -1)).toBe(false);
  });
});

describe('API minutes', () => {
  it('reads HH:MM and minute numbers', () => {
    expect(parseQuietMinute('22:00')).toBe(1320);
    expect(parseQuietMinute('7:05')).toBe(425);
    expect(parseQuietMinute(420)).toBe(420);
    expect(parseQuietMinute('24:00')).toBeNull();
    expect(parseQuietMinute(1440)).toBeNull();
  });
});
