import { describe, expect, it } from 'vitest';
import { isfToMgdl } from './application/isf-units';

describe('isfToMgdl (one ISF rule for the profile and the loop)', () => {
  it('keeps mg/dL ISFs, including 15–25 under a mg/dL label', () => {
    expect(isfToMgdl(150, 'mg/dl')).toBe(150);
    expect(isfToMgdl(40, null)).toBe(40);
    expect(isfToMgdl(20, 'mg/dL')).toBe(20);
    expect(isfToMgdl(10, 'mg/dl')).toBe(10);
  });

  it('converts mmol/L ISFs, labeled or (below 25) unlabeled', () => {
    expect(isfToMgdl(2.5, 'mmol')).toBe(45);
    expect(isfToMgdl(8.3, 'mmol/L')).toBe(149);
    expect(isfToMgdl(20, 'mmol')).toBe(360);
    expect(isfToMgdl(20, null)).toBe(360);
    expect(isfToMgdl(3, '')).toBe(54);
  });

  it('reads 25 or more as mg/dL and below 10 as mmol/L whatever the label', () => {
    expect(isfToMgdl(45, 'mmol')).toBe(45);
    expect(isfToMgdl(3, 'mg/dl')).toBe(54);
  });

  it('returns null for a missing or non-positive ISF', () => {
    expect(isfToMgdl(null, 'mg/dl')).toBeNull();
    expect(isfToMgdl(undefined, null)).toBeNull();
    expect(isfToMgdl(0, 'mmol')).toBeNull();
    expect(isfToMgdl(Number.NaN, null)).toBeNull();
  });
});
