import { describe, expect, it } from 'vitest';
import { nightscoutEntryObservedAt, normalizeNightscoutEntry } from './nightscout-normalizer';
import type { NightscoutEntryDto } from './nightscout-client';

const IMPORTED_AT = '2026-10-21T12:00:00.000Z';

function valid(entry: NightscoutEntryDto) {
  const normalized = normalizeNightscoutEntry(entry, 'patient-1', IMPORTED_AT);
  if (normalized.status !== 'VALID') throw new Error(`fixture rejected: ${normalized.reason}`);
  return normalized.reading;
}

describe('normalizeNightscoutEntry identity', () => {
  it('never uses enteredBy as the record id: entries of one uploader without ids stay separate readings', async () => {
    const first = valid({ enteredBy: 'xDrip', sgv: 110, date: Date.parse('2026-10-21T11:00:00.000Z'), type: 'sgv' });
    const second = valid({ enteredBy: 'xDrip', sgv: 112, date: Date.parse('2026-10-21T11:05:00.000Z'), type: 'sgv' });
    const sameTimeOtherValue = valid({ enteredBy: 'xDrip', sgv: 115, date: Date.parse('2026-10-21T11:00:00.000Z'), type: 'sgv' });

    expect([first.source_record_id, second.source_record_id, sameTimeOtherValue.source_record_id]).toEqual([null, null, null]);
    expect(new Set([first.natural_key, second.natural_key, sameTimeOtherValue.natural_key]).size).toBe(3);
    expect(first.natural_key).toMatch(/^nightscout:fallback:/);
    expect(first.natural_key).not.toContain('xDrip');
  });

  it('gives the same reading fetched again the same fallback key', async () => {
    const entry: NightscoutEntryDto = { enteredBy: 'xDrip', sgv: 110, date: Date.parse('2026-10-21T11:00:00.000Z'), type: 'sgv' };

    expect(valid({ ...entry }).natural_key).toBe(valid({ ...entry }).natural_key);
  });

  it('keeps the Nightscout id when there is one', async () => {
    const reading = valid({ _id: '6a1f00000000000000000001', enteredBy: 'xDrip', sgv: 110, dateString: '2026-10-21T11:00:00.000Z' });

    expect(reading).toMatchObject({ source_record_id: '6a1f00000000000000000001', natural_key: 'nightscout:6a1f00000000000000000001' });
  });
});

describe('nightscoutEntryObservedAt', () => {
  it('reads dateString first, then epoch-ms date as a number or a numeric string', async () => {
    expect(nightscoutEntryObservedAt({ dateString: '2026-10-21T11:00:00.000Z', date: 0 })).toBe('2026-10-21T11:00:00.000Z');
    expect(nightscoutEntryObservedAt({ date: 1_792_581_600_000 })).toBe('2026-10-21T11:20:00.000Z');
    expect(nightscoutEntryObservedAt({ date: '1792581600000' })).toBe('2026-10-21T11:20:00.000Z');
    expect(nightscoutEntryObservedAt({ date: 'not a date' })).toBeNull();
    expect(nightscoutEntryObservedAt({})).toBeNull();
  });
});

describe('normalizeNightscoutEntry glucose range', () => {
  it('rejects uploader error codes below 39 mg/dL and values no CGM measures; keeps 39 and 400', () => {
    const at = Date.parse('2026-10-21T11:00:00.000Z');
    for (const sgv of [5, 12, 38, 601]) expect(normalizeNightscoutEntry({ sgv, date: at, type: 'sgv' }, 'patient-1', IMPORTED_AT).status).not.toBe('VALID');
    expect(valid({ sgv: 39, date: at, type: 'sgv' }).glucose_value).toBe(39);
    expect(valid({ sgv: 400, date: at, type: 'sgv' }).glucose_value).toBe(400);
  });
});
