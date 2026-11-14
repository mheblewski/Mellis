import { describe, expect, it } from 'vitest';
import { patientTimeZoneFromProfile } from './home-time-zone';

const WINTER = Date.parse('2026-11-12T12:00:00Z');
const SUMMER = Date.parse('2026-07-12T12:00:00Z');
const env = { TZ: 'Europe/Warsaw' } as NodeJS.ProcessEnv;

describe('patientTimeZoneFromProfile (audit 2026-11-12: Loop uploads "ETC/GMT-1")', () => {
  it('reads a fixed offset that matches the home zone as the home zone, in winter and summer', () => {
    expect(patientTimeZoneFromProfile('ETC/GMT-1', WINTER, env)).toBe('Europe/Warsaw');
    expect(patientTimeZoneFromProfile('ETC/GMT-2', SUMMER, env)).toBe('Europe/Warsaw');
  });

  it('keeps another fixed offset, in IANA spelling', () => {
    expect(patientTimeZoneFromProfile('ETC/GMT-2', WINTER, env)).toBe('Etc/GMT-2');
    expect(patientTimeZoneFromProfile('etc/gmt+5', WINTER, env)).toBe('Etc/GMT+5');
  });

  it('keeps a named zone and refuses an invalid one', () => {
    expect(patientTimeZoneFromProfile('America/New_York', WINTER, env)).toBe('America/New_York');
    expect(patientTimeZoneFromProfile('Not/AZone', WINTER, env)).toBeNull();
    expect(patientTimeZoneFromProfile('', WINTER, env)).toBeNull();
    expect(patientTimeZoneFromProfile(null, WINTER, env)).toBeNull();
  });
});
