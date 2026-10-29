import { describe, expect, it } from 'vitest';
import { mapNightscoutTrendDirection, normalizeNightscoutDeviceStatus } from './nightscout-devicestatus-normalizer';

describe('nightscout device status normalization', () => {
  it('maps Nightscout direction values to domain trend values', () => {
    expect(mapNightscoutTrendDirection('DoubleUp')).toBe('DOUBLE_UP');
    expect(mapNightscoutTrendDirection('SingleUp')).toBe('UP');
    expect(mapNightscoutTrendDirection('FortyFiveUp')).toBe('UP');
    expect(mapNightscoutTrendDirection('Flat')).toBe('FLAT');
    expect(mapNightscoutTrendDirection('FortyFiveDown')).toBe('DOWN');
    expect(mapNightscoutTrendDirection('SingleDown')).toBe('DOWN');
    expect(mapNightscoutTrendDirection('DoubleDown')).toBe('DOUBLE_DOWN');
    expect(mapNightscoutTrendDirection('UNKNOWN')).toBe('UNKNOWN');
    expect(mapNightscoutTrendDirection('bogus')).toBe('UNKNOWN');
  });

  it('extracts iob and cob from the latest valid devicestatus payload', () => {
    const normalized = normalizeNightscoutDeviceStatus({
      _id: 'status-1',
      created_at: '2026-10-05T19:19:25.472Z',
      openaps: {
        iob: { iob: 1.358 },
        suggested: { COB: 9 },
        enacted: { IOB: 1.487, COB: 10 },
      },
    }, 'patient-1', '2026-10-05T19:20:00.000Z');

    expect(normalized.status).toBe('VALID');
    if (normalized.status !== 'VALID') {
      throw new Error('expected valid status');
    }

    expect(normalized.statusSnapshot.iob).toBe(1.358);
    // The suggestion is oref's newest calculation: its COB wins over the last enacted one (as on the dashboard).
    expect(normalized.statusSnapshot.cob).toBe(9);
    expect(normalized.statusSnapshot.observed_at).toBe('2026-10-05T19:19:25.472Z');
  });

  it('keeps unknown values when iob or cob are missing or malformed', () => {
    expect(normalizeNightscoutDeviceStatus({
      _id: 'status-no-iob',
      created_at: '2026-10-05T19:19:25.472Z',
      openaps: { suggested: { COB: 9 } },
    }, 'patient-1', '2026-10-05T19:20:00.000Z').status).toBe('VALID');

    const noCob = normalizeNightscoutDeviceStatus({
      _id: 'status-no-cob',
      created_at: '2026-10-05T19:19:25.472Z',
      openaps: { iob: { iob: 1.358 } },
    }, 'patient-1', '2026-10-05T19:20:00.000Z');

    expect(noCob.status).toBe('VALID');
    if (noCob.status !== 'VALID') {
      throw new Error('expected valid status');
    }
    expect(noCob.statusSnapshot.iob).toBe(1.358);
    expect(noCob.statusSnapshot.cob).toBeNull();

    const malformed = normalizeNightscoutDeviceStatus({
      _id: 'status-malformed',
      created_at: 'bad-ts',
      openaps: {
        iob: { iob: 'bad' },
        suggested: { COB: 'bad' },
      },
    }, 'patient-1', '2026-10-05T19:20:00.000Z');

    expect(malformed.status).toBe('REJECTED');
  });

  it('accepts canonical timestamp variants: Z, explicit offset, and GMT+0200 string', () => {
    const importedAt = '2026-10-05T19:20:00.000Z';
    const z = normalizeNightscoutDeviceStatus({
      _id: 'status-z',
      created_at: '2026-10-05T19:19:25.472Z',
      openaps: { iob: { iob: 1.0 } },
    }, 'patient-1', importedAt);
    expect(z.status).toBe('VALID');

    const withOffset = normalizeNightscoutDeviceStatus({
      _id: 'status-offset',
      created_at: '2026-10-05T21:19:25.472+02:00',
      openaps: { iob: { iob: 1.0 } },
    }, 'patient-1', importedAt);
    expect(withOffset.status).toBe('VALID');

    const gmtString = normalizeNightscoutDeviceStatus({
      _id: 'status-gmt',
      created_at: 'Mon Oct 05 2026 21:19:25 GMT+0200 (Central European Summer Time)',
      openaps: { iob: { iob: 1.0 } },
    }, 'patient-1', importedAt);
    expect(gmtString.status).toBe('VALID');
  });

  it('rejects explicit foreign patient rows', () => {
    const result = normalizeNightscoutDeviceStatus({
      _id: 'status-other-patient',
      patient: 'patient-2',
      created_at: '2026-10-05T19:19:25.472Z',
      openaps: { iob: { iob: 1.0 } },
    }, 'patient-1', '2026-10-05T19:20:00.000Z');

    expect(result.status).toBe('REJECTED');
    if (result.status !== 'REJECTED') {
      throw new Error('expected rejected status');
    }
    expect(result.reason).toBe('patient_mismatch');
  });
});
