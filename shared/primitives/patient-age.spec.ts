import { describe, expect, it } from 'vitest';
import { patientAge, patientAgeInstruction, patientAgeInstructionPl, polishYears } from './patient-age';

const now = new Date('2026-10-20T12:00:00Z');

describe('patientAge', () => {
  it('groups by the difference of years: child under 13, teenager under 18, adult from 18', () => {
    expect(patientAge(2016, now)).toEqual({ birth_year: 2016, age_years: 10, age_group: 'CHILD' });
    expect(patientAge(2014, now)?.age_group).toBe('CHILD');
    expect(patientAge(2013, now)?.age_group).toBe('TEEN');
    expect(patientAge(2009, now)?.age_group).toBe('TEEN');
    expect(patientAge(2008, now)?.age_group).toBe('ADULT');
  });

  it('is unknown without a year, or with a year in the future', () => {
    expect(patientAge(null, now)).toBeNull();
    expect(patientAge(undefined, now)).toBeNull();
    expect(patientAge(2027, now)).toBeNull();
  });
});

describe('patient age instructions', () => {
  it('state the age and the group, or that the age is not known', () => {
    expect(patientAgeInstruction(patientAge(2016, now))).toContain('about 10 (born 2016), a child');
    expect(patientAgeInstruction(patientAge(1990, now))).toContain('about 36 (born 1990), an adult');
    expect(patientAgeInstruction(null)).toContain('not known');
    expect(patientAgeInstructionPl(patientAge(2016, now))).toContain('ok. 10 lat (rocznik 2016), dziecko');
    expect(patientAgeInstructionPl(patientAge(1994, now))).toContain('ok. 32 lata (rocznik 1994), osoba dorosła');
    expect(patientAgeInstructionPl(null)).toContain('nieznany');
  });

  it('uses the Polish plural of years', () => {
    expect([1, 2, 4, 5, 12, 14, 22, 25, 34].map(polishYears)).toEqual(['rok', 'lata', 'lata', 'lat', 'lat', 'lat', 'lata', 'lat', 'lata']);
  });
});
