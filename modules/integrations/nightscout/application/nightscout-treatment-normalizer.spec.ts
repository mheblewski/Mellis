import { describe, expect, it } from 'vitest';
import { normalizeNightscoutTreatment } from './nightscout-treatment-normalizer';

describe('normalizeNightscoutTreatment', () => {
  const patientId = 'patient-1';
  const importedAt = '2026-10-04T12:00:00.000Z';

  it('maps Carb Correction to CARB_ENTRY with positive carbs', () => {
    const result = normalizeNightscoutTreatment({
      _id: 'tx-carb-1',
      eventType: 'Carb Correction',
      created_at: '2026-10-04T10:00:00.000Z',
      carbs: 42,
    }, patientId, importedAt);

    expect(result.status).toBe('VALID');
    if (result.status !== 'VALID') {
      return;
    }

    expect(result.treatment.event_type).toBe('CARB_ENTRY');
    expect(result.treatment.payload.carbs).toBe(42);
  });

  it('maps Bolus and SMB to insulin payload', () => {
    const bolus = normalizeNightscoutTreatment({
      _id: 'tx-bolus-1',
      eventType: 'Bolus',
      created_at: '2026-10-04T10:05:00.000Z',
      insulin: 3,
    }, patientId, importedAt);

    const smb = normalizeNightscoutTreatment({
      _id: 'tx-smb-1',
      eventType: 'SMB',
      created_at: '2026-10-04T10:06:00.000Z',
      enteredInsulin: 0.5,
    }, patientId, importedAt);

    expect(bolus.status).toBe('VALID');
    expect(smb.status).toBe('VALID');
    if (bolus.status === 'VALID') {
      expect(bolus.treatment.event_type).toBe('BOLUS');
      expect(bolus.treatment.payload.insulin_units).toBe(3);
    }
    if (smb.status === 'VALID') {
      expect(smb.treatment.event_type).toBe('SMB');
      expect(smb.treatment.payload.insulin_units).toBe(0.5);
    }
  });

  it('maps Temp Basal with available numeric fields', () => {
    const result = normalizeNightscoutTreatment({
      _id: 'tx-temp-1',
      eventType: 'Temp Basal',
      created_at: '2026-10-04T10:07:00.000Z',
      rate: 0.75,
      absolute: 0.9,
      duration: 30,
    }, patientId, importedAt);

    expect(result.status).toBe('VALID');
    if (result.status !== 'VALID') {
      return;
    }

    expect(result.treatment.event_type).toBe('TEMP_BASAL');
    expect(result.treatment.payload.rate).toBe(0.75);
    expect(result.treatment.payload.absolute).toBe(0.9);
    expect(result.treatment.payload.duration_minutes).toBe(30);
  });

  it('reads Loop\'s boluses: "Correction Bolus" given by a person is BOLUS, one Loop gave itself is SMB', () => {
    const at = '2026-10-04T10:05:00.000Z';
    const kind = (treatment: Record<string, unknown>) => {
      const result = normalizeNightscoutTreatment({ _id: `tx-${Math.random()}`, created_at: at, ...treatment }, patientId, importedAt);
      return result.status === 'VALID' ? [result.treatment.event_type, result.treatment.payload] : [result.status];
    };
    // Loop (NightscoutServiceKit DoseEntry): every bolus is "Correction Bolus", `automatic` says who gave it.
    expect(kind({ eventType: 'Correction Bolus', insulin: 2.4, automatic: false, enteredBy: 'loop://iPhone', type: 'normal' }))
      .toEqual(['BOLUS', { insulin_units: 2.4, source_event_type: 'Correction Bolus' }]);
    expect(kind({ eventType: 'Correction Bolus', insulin: 0.15, automatic: true, enteredBy: 'loop://iPhone' }))
      .toEqual(['SMB', { insulin_units: 0.15, source_event_type: 'Correction Bolus' }]);
    // AAPS marks its SMBs; Careportal names a meal bolus.
    expect(kind({ eventType: 'Correction Bolus', insulin: 0.3, isSMB: true, enteredBy: 'openaps://AndroidAPS' })[0]).toBe('SMB');
    expect(kind({ eventType: 'Meal Bolus', insulin: 3, enteredBy: 'careportal' })[0]).toBe('BOLUS');
    // Loop's carbs and temp basals (a suspend is a temp basal of 0 U/h).
    expect(kind({ eventType: 'Carb Correction', carbs: 30, absorptionTime: 180, enteredBy: 'loop://iPhone' })[0]).toBe('CARB_ENTRY');
    expect(kind({ eventType: 'Temp Basal', rate: 0, absolute: 0, duration: 25, automatic: true, reason: 'suspend' })[0]).toBe('TEMP_BASAL');
  });

  it('rejects unsupported treatment types', () => {
    const result = normalizeNightscoutTreatment({
      _id: 'tx-note-1',
      eventType: 'Note',
      created_at: '2026-10-04T10:08:00.000Z',
    }, patientId, importedAt);

    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') {
      expect(result.reason).toBe('unsupported_event_type');
    }
  });

  it('rejects malformed treatment payloads for supported types', () => {
    const result = normalizeNightscoutTreatment({
      _id: 'tx-bolus-0',
      eventType: 'Bolus',
      created_at: '2026-10-04T10:09:00.000Z',
      insulin: 0,
    }, patientId, importedAt);

    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') {
      expect(result.reason).toBe('unsupported_payload');
    }
  });

  it('rejects missing treatment identity deterministically', () => {
    const result = normalizeNightscoutTreatment({
      eventType: 'SMB',
      created_at: '2026-10-04T10:10:00.000Z',
      insulin: 0.4,
    }, patientId, importedAt);

    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') {
      expect(result.reason).toBe('missing_treatment_id');
    }
  });

  it('rejects patient mismatch when source treatment carries patient identifier', () => {
    const result = normalizeNightscoutTreatment({
      _id: 'tx-patient-mismatch',
      eventType: 'Carb Correction',
      created_at: '2026-10-04T10:11:00.000Z',
      carbs: 10,
      patient: 'someone-else',
    }, patientId, importedAt);

    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') {
      expect(result.reason).toBe('patient_mismatch');
    }
  });

  it('normalizes a Trio carbohydrate entry as CARB_ENTRY without inventing fat or protein', () => {
    // Shape uploaded by Trio (the only carbohydrate uploader in the dev data): string carbs, fat/protein "0" meaning
    // "not entered", and foodType/notes carrying a remote-command marker rather than a meal description.
    const result = normalizeNightscoutTreatment({
      _id: 'trio-carb-1',
      id: 'trio-carb-1',
      eventType: 'Carb Correction',
      carbs: '30',
      fat: '0',
      protein: '0',
      foodType: 'Remote meal command',
      notes: 'Remote meal command',
      enteredBy: 'Trio',
      created_at: '2026-10-10T07:00:00.000Z',
    }, 'patient-1', '2026-10-10T07:01:00.000Z');

    expect(result.status).toBe('VALID');
    if (result.status !== 'VALID') return;
    expect(result.treatment.event_type).toBe('CARB_ENTRY');
    expect(result.treatment.payload).toEqual({ carbs: 30, source_event_type: 'Carb Correction' });
    expect(result.treatment.raw_payload).toMatchObject({ fat: '0', protein: '0' });
  });

  it('matches the carbohydrate event type case- and whitespace-insensitively', () => {
    const result = normalizeNightscoutTreatment({ _id: 'carb-2', eventType: '  carb correction ', carbs: 12, created_at: '2026-10-10T07:00:00.000Z' }, 'patient-1', '2026-10-10T07:01:00.000Z');
    expect(result.status === 'VALID' && result.treatment.event_type).toBe('CARB_ENTRY');
  });
});
