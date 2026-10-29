import { describe, expect, it } from 'vitest';
import { parseArgs, validateEpochRequest, type CreateEpochOptions } from './create-meal-history-epoch';

const NOW = new Date('2026-10-13T10:00:00.000Z');
const VALID: CreateEpochOptions = {
  database: 'gluco_mind',
  patientId: '11111111-1111-4111-8111-111111111111',
  startsAt: '2026-10-15T03:00:00+02:00',
  policy: 'new-meal-assignment.v1',
  decidedBy: 'caregiver',
  note: 'Start collecting verified meal history',
  execute: false,
};

describe('create-meal-history-epoch arguments', () => {
  it('defaults to a dry run and parses every required value', () => {
    expect(parseArgs([
      '--database', 'gluco_mind', '--patient', VALID.patientId, '--starts-at', VALID.startsAt,
      '--policy', VALID.policy, '--decided-by', 'caregiver', '--note', VALID.note,
    ])).toEqual(VALID);
    expect(parseArgs(['--database', 'x', '--execute']).execute).toBe(true);
  });

  it('accepts no stray flags', () => {
    expect(() => parseArgs(['--mode', 'SEND'])).toThrow('Unknown argument: --mode');
    expect(() => parseArgs(['--patient'])).toThrow('Missing value for --patient');
    expect(() => parseArgs(['--patient', '--execute'])).toThrow('Missing value for --patient');
  });
});

describe('create-meal-history-epoch validation', () => {
  it('normalises a zoned future starts_at to UTC', () => {
    expect(validateEpochRequest(VALID, NOW)).toEqual({ startsAtIso: '2026-10-15T01:00:00.000Z' });
    expect(validateEpochRequest({ ...VALID, startsAt: '2026-10-15T01:00:00Z' }, NOW)).toEqual({ startsAtIso: '2026-10-15T01:00:00.000Z' });
  });

  it('requires an explicit zone', () => {
    expect(() => validateEpochRequest({ ...VALID, startsAt: '2026-10-15T03:00:00' }, NOW)).toThrow('explicit zone');
    expect(() => validateEpochRequest({ ...VALID, startsAt: '2026-10-15 03:00:00+02' }, NOW)).toThrow('explicit zone');
    expect(() => validateEpochRequest({ ...VALID, startsAt: '2026-13-01T03:00:00Z' }, NOW)).toThrow('not a valid timestamp');
    expect(() => validateEpochRequest({ ...VALID, startsAt: '2026-02-30T03:00:00Z' }, NOW)).toThrow('not a valid timestamp');
  });

  it('refuses starts_at that is not in the future', () => {
    expect(() => validateEpochRequest({ ...VALID, startsAt: '2026-10-13T10:00:00Z' }, NOW)).toThrow('must be in the future');
    expect(() => validateEpochRequest({ ...VALID, startsAt: '2026-10-12T10:00:00Z' }, NOW)).toThrow('must be in the future');
  });

  it('accepts exactly the code policy version', () => {
    expect(() => validateEpochRequest({ ...VALID, policy: 'new-meal-assignment.v2' }, NOW)).toThrow('must be exactly new-meal-assignment.v1');
    expect(() => validateEpochRequest({ ...VALID, policy: 'NEW-MEAL-ASSIGNMENT.V1' }, NOW)).toThrow('must be exactly');
  });

  it('requires database, patient uuid, decided_by and a note', () => {
    expect(() => validateEpochRequest({ ...VALID, database: '' }, NOW)).toThrow('--database');
    expect(() => validateEpochRequest({ ...VALID, patientId: 'patient-a' }, NOW)).toThrow('UUID');
    expect(() => validateEpochRequest({ ...VALID, decidedBy: '  ' }, NOW)).toThrow('--decided-by');
    expect(() => validateEpochRequest({ ...VALID, note: 'short' }, NOW)).toThrow('--note');
  });
});
