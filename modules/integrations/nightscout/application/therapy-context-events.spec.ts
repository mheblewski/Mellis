import { describe, expect, it } from 'vitest';
import { toTherapyContextEvent } from './therapy-context-events';

describe('therapy context events (therapy-context-events.v1)', () => {
  it('keeps temporary targets, overrides, site and sensor changes and notes with their describing fields only', () => {
    expect(toTherapyContextEvent({ _id: 't1', eventType: 'Temporary Target', created_at: '2026-10-26T15:00:00.000Z', duration: 60, targetTop: 140, targetBottom: 140, reason: 'Activity', enteredBy: 'Trio' } as any)).toEqual({
      source_record_id: 't1', kind: 'TEMP_TARGET', event_type: 'Temporary Target', occurred_at: '2026-10-26T15:00:00.000Z', duration_minutes: 60,
      details: { target_top: 140, target_bottom: 140, reason: 'Activity' },
    });
    expect(toTherapyContextEvent({ _id: 'o1', eventType: 'Exercise', created_at: '2026-10-26T15:00:00Z', duration: '90', notes: 'Basen' } as any)).toMatchObject({ kind: 'EXERCISE', duration_minutes: 90, details: { notes: 'Basen' } });
    expect(toTherapyContextEvent({ _id: 's1', eventType: 'Sensor Start', created_at: '2026-10-26T13:27:15.396Z', notes: 'SIMULATOR activated' } as any)).toMatchObject({ kind: 'SENSOR_CHANGE' });
    expect(toTherapyContextEvent({ _id: 'n1', eventType: 'Note', created_at: '2026-10-19T15:06:14.997Z', notes: 'x'.repeat(400) } as any)?.details.notes).toHaveLength(300);
  });

  it('ignores insulin, carbs, unknown types and treatments without an id or a time', () => {
    expect(toTherapyContextEvent({ _id: 'b1', eventType: 'Bolus', created_at: '2026-10-26T15:00:00Z', insulin: 2 } as any)).toBeNull();
    expect(toTherapyContextEvent({ _id: 'q1', eventType: 'Question', created_at: '2026-10-26T15:00:00Z' } as any)).toBeNull();
    expect(toTherapyContextEvent({ eventType: 'Site Change', created_at: '2026-10-26T15:00:00Z' } as any)).toBeNull();
    expect(toTherapyContextEvent({ _id: 'x', eventType: 'Site Change' } as any)).toBeNull();
  });
});
