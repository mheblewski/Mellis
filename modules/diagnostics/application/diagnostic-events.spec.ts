import { describe, expect, it } from 'vitest';
import { allowedDiagnosticFields, diagnosticEventFromLog } from './diagnostic-events';

describe('diagnosticEventFromLog', () => {
  it('keeps the event, allowed codes and the duration of a structured line', () => {
    const event = diagnosticEventFromLog('warn', JSON.stringify({ event: 'push_outbox_send_failed', error_code: 'BadDeviceToken', attempt: 2, retrying: true, duration_ms: 41.6 }), 'Worker');
    expect(event).toEqual({ level: 'warn', event: 'push_outbox_send_failed', fields: { attempt: 2, error_code: 'BadDeviceToken', retrying: true }, duration_ms: 42 });
  });

  it('drops identifiers, therapy values and free text, whatever the event', () => {
    const event = diagnosticEventFromLog('info', JSON.stringify({
      event: 'rescue_carbs_decision',
      patient_id: '6f1c2c1e-3a53-4f4e-9c55-0c8f0d8a1b11',
      meal_record_id: 'abc',
      units: 2.5,
      meal_carbs_g: 40,
      percent: 12,
      slope_per_min: -3,
      observed_at: '2026-11-07T10:00:00Z',
      error: 'connect ECONNREFUSED nightscout.example.com',
      message: 'Kuba zjadł obiad',
      level: 70,
    }), null);
    expect(event?.fields).toEqual({});
  });

  it('drops a value of the wrong shape under an allowed name', () => {
    expect(allowedDiagnosticFields({
      reason: 'Kuba nie odpowiada',
      error_code: 'https://nightscout.example.com/api',
      code: 'mama@example.com',
      state: '6f1c2c1e-3a53-4f4e-9c55-0c8f0d8a1b11',
      kind: '48601234567',
      attempt: 'three',
      retrying: 'yes',
      route: '/v1/patients/6f1c2c1e-3a53-4f4e-9c55-0c8f0d8a1b11/dashboard',
    })).toEqual({});
  });

  it('keeps a route template and a dated model name', () => {
    expect(allowedDiagnosticFields({ route: '/v1/patients/:patientId/dashboard', model: 'claude-opus-4-20250514' }))
      .toEqual({ model: 'claude-opus-4-20250514', route: '/v1/patients/:patientId/dashboard' });
  });

  it('keeps only that an unstructured warning happened, and ignores ordinary framework lines', () => {
    expect(diagnosticEventFromLog('error', 'Unhandled exception for Kuba at https://secret-host/', 'ProblemDetailsFilter'))
      .toEqual({ level: 'error', event: 'unstructured_log', fields: { context: 'ProblemDetailsFilter' }, duration_ms: null });
    expect(diagnosticEventFromLog('info', 'Mapped {/v1/me/patients, GET} route', 'RouterExplorer')).toBeNull();
  });

  it('treats a line with a malformed event name as unstructured', () => {
    expect(diagnosticEventFromLog('warn', JSON.stringify({ event: 'Kuba ma hipo' }), null)?.event).toBe('unstructured_log');
  });
});
