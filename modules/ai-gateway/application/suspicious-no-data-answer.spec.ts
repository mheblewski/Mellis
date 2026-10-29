import { describe, expect, it } from 'vitest';
import { evaluateNoDataClaims, findNoDataClaims, type PatientDataCounts } from './suspicious-no-data-answer';

const FULL: PatientDataCounts = { glucose_readings: 288, boluses: 12, smbs: 30, temp_basals: 150, loop_snapshots: 660 };
const EMPTY: PatientDataCounts = { glucose_readings: 0, boluses: 0, smbs: 0, temp_basals: 0, loop_snapshots: 0 };

describe('findNoDataClaims', () => {
  it.each([
    ['Niestety nie mam danych z tej nocy.', 'ANY_DATA', 'nie mam danych'],
    ['Nie mam wczytanych danych z CGM.', 'ANY_DATA', 'nie mam danych'],
    ['Z dzisiejszej nocy nie ma odczytów CGM.', 'GLUCOSE', 'nie ma odczytów'],
    ['Brak odczytów między 2:00 a 4:00.', 'GLUCOSE', 'brak odczytów'],
    ['Nie było bolusa na kolację.', 'BOLUS', 'nie było bolusa'],
    ['W nocy nie było żadnego SMB.', 'SMB', 'nie było smb'],
    ['Brak bazy przez całą noc.', 'BASAL', 'brak bazy'],
    ['Nie widzę danych o glukozie.', 'ANY_DATA', 'nie widzę danych'],
    ['Nie mam dostępu do pomiarów.', 'ANY_DATA', 'nie mam dostępu'],
    ['IOB i COB są nieznane.', 'IOB_COB', 'IOB/COB nieznane'],
    ['IOB: nieznane', 'IOB_COB', 'IOB/COB nieznane'],
    ['Nie ma w danych bolusa z 12:30.', 'BOLUS', 'nie ma bolusa'],
    ['Nie zarejestrowano insuliny w tym czasie.', 'INSULIN', 'nie zarejestrowano insuliny'],
    ["I don't have any glucose readings for last night.", 'GLUCOSE', "i don't have glucose"],
    ['There was no bolus before dinner.', 'BOLUS', 'there was no bolus'],
    ['No data for this period.', 'ANY_DATA', 'no data'],
    ['IOB unknown.', 'IOB_COB', 'IOB/COB nieznane'],
  ])('%s', (answer, kind, phrase) => {
    expect(findNoDataClaims(answer)).toContainEqual({ kind, phrase });
  });

  it.each([
    'Nie ma potrzeby podawać insuliny.',
    'Nie było spadku cukru w nocy.',
    'Nie widzę w danych żadnej hipoglikemii.',
    'Nie mam danych o posiłku z 13:00 – opiszesz go?',
    'No to bolus był podany o 12:30.',
    'Cukier był stabilny, odczyty CGM są kompletne.',
    'Nie mam wątpliwości, że dane są pełne.',
    'There is no need for a correction bolus.',
    'Brak ryzyka spadku cukru.',
  ])('no claim: %s', (answer) => {
    expect(findNoDataClaims(answer)).toEqual([]);
  });

  it('lists each claim once', () => {
    expect(findNoDataClaims('Brak odczytów. Brak odczytów. Nie było bolusa.')).toEqual([
      { kind: 'GLUCOSE', phrase: 'brak odczytów' },
      { kind: 'BOLUS', phrase: 'nie było bolusa' },
    ]);
  });
});

describe('evaluateNoDataClaims', () => {
  const window = { windowBasis: 'ANALYSED_RANGE' as const, windowFrom: '2026-10-18T19:00:00.000Z', windowTo: '2026-10-19T07:15:00.000Z' };

  it('flags the claims the counts contradict, with the counts and the window', () => {
    const claims = findNoDataClaims('Nie mam danych z nocy i nie było bolusa.');
    expect(evaluateNoDataClaims({ claims, counts: FULL, ...window })).toEqual({
      type: 'SUSPICIOUS_NO_DATA_ANSWER',
      detector_version: 'suspicious-no-data-answer.v1',
      claims: [{ kind: 'ANY_DATA', phrase: 'nie mam danych' }, { kind: 'BOLUS', phrase: 'nie było bolusa' }],
      window_basis: 'ANALYSED_RANGE',
      window_from: window.windowFrom,
      window_to: window.windowTo,
      counts: FULL,
    });
  });

  it('does not flag a claim that is true', () => {
    expect(evaluateNoDataClaims({ claims: findNoDataClaims('Brak odczytów CGM.'), counts: EMPTY, ...window })).toBeNull();
    // Readings but no boluses: "nie było bolusa" is right, "brak odczytów" is not.
    const onlyGlucose = { ...EMPTY, glucose_readings: 100 };
    expect(evaluateNoDataClaims({ claims: findNoDataClaims('Nie było bolusa.'), counts: onlyGlucose, ...window })).toBeNull();
    expect(evaluateNoDataClaims({ claims: findNoDataClaims('Nie było bolusa, brak odczytów.'), counts: onlyGlucose, ...window })!.claims)
      .toEqual([{ kind: 'GLUCOSE', phrase: 'brak odczytów' }]);
  });
});
