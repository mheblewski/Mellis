import { describe, expect, it } from 'vitest';
import { sanitizeMetricCard } from '@modules/context/application/metric-card';
import { readTherapySettingsRequest, type TherapySettingsRequest } from './therapy-settings-request';
import {
  buildTherapySettingsCard,
  lastTherapyChange,
  loopTile,
  scheduleRuns,
  therapySettingsReply,
  type TherapySettingsLoopInput,
  type TherapySettingsProfile,
} from './therapy-settings-card';

// Wednesday 11 November 2026, 13:20 in Warsaw.
const NOW = new Date('2026-11-11T12:20:00.000Z');
const TZ = 'Europe/Warsaw';

const PROFILE: TherapySettingsProfile = {
  status: 'KNOWN',
  units: 'mg/dl',
  timezone: TZ,
  dia_hours: 6,
  basal_u_per_h: [['00:00', 0.3], ['03:00', 0.35], ['06:00', 0.45], ['09:00', 0.4], ['12:00', 0.35], ['15:00', 0.4], ['18:00', 0.45], ['21:00', 0.35]],
  carb_ratio_g_per_u: [['00:00', 10], ['06:00', 5], ['09:30', 8.3], ['18:00', 6.8]],
  sensitivity_per_u: [['00:00', 300], ['06:00', 220], ['12:00', 250], ['21:00', 280]],
  target_low: [['00:00', 110], ['06:00', 100]],
  target_high: [['00:00', 110], ['06:00', 100]],
};

const card = (question: string, overrides: Partial<Parameters<typeof buildTherapySettingsCard>[0]> = {}) => {
  const request = readTherapySettingsRequest(question) as Extract<TherapySettingsRequest, { kind: 'CARD' }>;
  expect(request?.kind).toBe('CARD');
  return buildTherapySettingsCard({
    request,
    profile: PROFILE,
    now: NOW,
    timeZone: TZ,
    patientName: 'Janek',
    loop: { nominative: 'Trio', genitive: 'Trio' },
    changedAt: '2026-11-03T08:00:00.000Z',
    uploadedAt: '2026-11-10T08:00:00.000Z',
    loopNow: null,
    ...overrides,
  })!;
};

describe('scheduleRuns', () => {
  it('merges equal neighbours and ends the day at 24:00', () => {
    expect(scheduleRuns([['00:00', 10], ['06:00', 10], ['12:00', 8]])).toEqual([{ start: 0, end: 720, value: 10 }, { start: 720, end: 1440, value: 8 }]);
  });

  it('wraps the last value over midnight when the schedule starts later', () => {
    expect(scheduleRuns([['06:00', 5], ['18:00', 7]])).toEqual([{ start: 0, end: 360, value: 7 }, { start: 360, end: 1080, value: 5 }, { start: 1080, end: 1440, value: 7 }]);
  });

  it('reads 30-minute segments (Medtronic 722)', () => {
    const entries = Array.from({ length: 48 }, (_, index) => [`${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`, 0.3 + (index % 3) * 0.05] as [string, number]);
    const runs = scheduleRuns(entries)!;
    expect(runs).toHaveLength(48);
    expect(runs[47]).toMatchObject({ start: 1410, end: 1440 });
    expect(runs[47].value).toBeCloseTo(0.4);
  });

  it('is null without usable entries', () => {
    expect(scheduleRuns(null)).toBeNull();
    expect(scheduleRuns([['xx', 1]])).toBeNull();
  });
});

describe('buildTherapySettingsCard', () => {
  it('builds the ICR card about now (board 3)', () => {
    const icr = card('Jakie jest ICR?');
    expect(icr).toMatchObject({
      layout: 'SINGLE',
      title: 'ICR teraz',
      history_title: 'ICR o 13:20',
      at: '13:20',
      is_now: true,
      live_until: '2026-11-11T12:50:00.000Z',
      changed_label: 'zmiana 3 lis',
      stale_label: null,
      sentence: 'Ta wartość jest ustawiona od 9:30 do 18:00.',
      footer: 'Im mniej gramów na 1 j, tym więcej insuliny na ten sam posiłek.',
      loop_now: null,
    });
    const lane = icr.settings[0];
    expect(lane.segments.map((segment) => [segment.start, segment.end, segment.label])).toEqual([
      ['00:00', '06:00', '10'], ['06:00', '09:30', '5'], ['09:30', '18:00', '8,3'], ['18:00', '24:00', '6,8'],
    ]);
    expect(lane.current_index).toBe(2);
    expect(lane.previous).toBeNull();
    expect(lane.accessibility_label).toBe('ICR: od 0:00 do 6:00 10 g na 1 j; od 6:00 do 9:30 5 g na 1 j; od 9:30 do 18:00 8,3 g na 1 j; od 18:00 do 24:00 6,8 g na 1 j; teraz 8,3');
    expect(icr.table.filter((row) => row.current).map((row) => row.start)).toEqual(['09:30']);
  });

  it('builds the basal card with the plan total and the loop tile (board 2)', () => {
    const loopNow: TherapySettingsLoopInput = { source: 'TEMP', rate: 0.2, plan_rate: 0.35, since: '2026-11-11T12:05:00.000Z', status_at: '2026-11-11T12:17:00.000Z' };
    const basal = card('Jaką bazę ma Janek?', { loopNow });
    expect(basal).toMatchObject({
      title: 'Baza z planu teraz',
      sentence: 'Ta wartość jest ustawiona od 12:00 do 15:00.',
      footer: 'W planie jest 9,15 j bazy na dobę.',
      basal_plan_total_u: 9.15,
      loop_now: { kind: 'TEMP', rate_u_per_h: 0.2, text: 'Pętla ustawiła teraz bazę tymczasową 0,20 j/h.' },
    });
    expect(basal.settings[0].segments.map((segment) => segment.label)).toEqual(['0,30', '0,35', '0,45', '0,40', '0,35', '0,40', '0,45', '0,35']);
  });

  it('gives the boundary hour to the new segment (board 7)', () => {
    const basal = card('Jaką bazę ma o 3 w nocy?');
    expect(basal).toMatchObject({
      layout: 'AT_ONE',
      title: 'Baza z planu o 3:00',
      history_title: 'Baza z planu o 3:00',
      is_now: false,
      live_until: null,
      sentence: 'O 3:00 baza zmienia się z 0,30 na 0,35 j/h i zostaje tak do 6:00.',
      footer: 'To plan z Trio. Pętla może w nocy podawać więcej albo mniej.',
      loop_now: null,
    });
    expect(basal.settings[0].segments[basal.settings[0].current_index].label).toBe('0,35');
    expect(basal.settings[0].previous).toMatchObject({ start: '00:00', end: '03:00', label: '0,30' });
    expect(basal.settings[0].next).toMatchObject({ start: '06:00', end: '09:00', label: '0,45' });
  });

  it('builds the ICR card at an hour with the hours before and after (board 6)', () => {
    const icr = card('Jakie jest ICR o 13:00?');
    expect(icr).toMatchObject({ title: 'ICR o 13:00', sentence: 'Ta wartość jest ustawiona od 9:30 do 18:00.', footer: null });
    expect(icr.settings[0].previous).toMatchObject({ start: '06:00', end: '09:30', label: '5' });
    expect(icr.settings[0].next).toMatchObject({ start: '18:00', end: '24:00', label: '6,8' });
  });

  it('builds the overview with one shared table (board 1)', () => {
    const overview = card('Jakie Janek ma ustawienia?');
    expect(overview).toMatchObject({
      layout: 'OVERVIEW',
      title: 'Ustawienia terapii',
      footer: 'W planie jest 9,15 j bazy na dobę. Czas działania insuliny w ustawieniach: 6 godzin.',
      sentence: null,
    });
    expect(overview.settings.map((lane) => [lane.key, lane.segments[lane.current_index].label])).toEqual([['BASAL', '0,35'], ['ICR', '8,3'], ['ISF', '250'], ['TARGET', '100']]);
    expect(overview.table.map((row) => row.start)).toEqual(['00:00', '03:00', '06:00', '09:00', '09:30', '12:00', '15:00', '18:00', '21:00']);
  });

  it('marks in the combo table which value changed in each row (board 5)', () => {
    const combo = card('Pokaż ICR i ISF razem');
    expect(combo).toMatchObject({ layout: 'COMBO', title: 'ICR i ISF', footer: null });
    expect(combo.table.map((row) => [row.start, row.end, ...row.values.map((value) => `${value.label}${value.changed ? '*' : ''}`), row.current])).toEqual([
      ['00:00', '06:00', '10*', '300*', false],
      ['06:00', '09:30', '5*', '220*', false],
      ['09:30', '12:00', '8,3*', '220', false],
      ['12:00', '18:00', '8,3', '250*', true],
      ['18:00', '21:00', '6,8*', '250', false],
      ['21:00', '24:00', '6,8', '280*', false],
    ]);
  });

  it('builds the tiles at an hour (board 8)', () => {
    const many = card('Jakie ustawienia obowiązują o 18:30?');
    expect(many).toMatchObject({ layout: 'AT_MANY', title: 'Ustawienia o 18:30', footer: null });
    expect(many.settings.map((lane) => [lane.name, lane.segments[lane.current_index].label, lane.span_label])).toEqual([
      ['Baza', '0,45', 'od 18:00 do 21:00'],
      ['ICR', '6,8', 'od 18:00 do 24:00'],
      ['ISF', '250', 'od 12:00 do 21:00'],
      ['Cel', '100', 'od 6:00 do 24:00'],
    ]);
    expect(card('ICR i ISF o 7:00').title).toBe('ICR i ISF o 7:00');
  });

  it('says a single value holds the whole day (board 11 B)', () => {
    const target = card('Jaki jest cel?', { profile: { ...PROFILE, target_low: [['00:00', 100]], target_high: [['00:00', 100]] } });
    expect(target).toMatchObject({ title: 'Cel teraz', sentence: 'Ta wartość jest ustawiona na całą dobę.', footer: null });
    expect(target.settings[0].segments).toHaveLength(1);
  });

  it('shows a target range and its middle', () => {
    const target = card('Jaki jest cel?', { profile: { ...PROFILE, target_low: [['00:00', 100]], target_high: [['00:00', 120]] } });
    expect(target.settings[0].segments[0]).toMatchObject({ value: 100, high: 120, label: '100–120' });
    expect(target.footer).toBe('Pętla celuje w środek: 110 mg/dl.');
  });

  it('joins a value that runs over midnight in its sentence', () => {
    const icr = card('Jakie jest ICR o 2?', { profile: { ...PROFILE, carb_ratio_g_per_u: [['00:00', 10], ['06:00', 5], ['22:00', 10]] } });
    expect(icr.sentence).toBe('Ta wartość jest ustawiona od 22:00 do 6:00.');
    expect(icr.settings[0].previous).toMatchObject({ start: '06:00', end: '22:00' });
  });

  it('says which hour it shows for "o 7" when 19:00 differs', () => {
    expect(card('Jakie jest ICR o 7?').hour_note).toBe('Pokazuję 7:00 rano.');
    expect(card('Jaki jest cel o 7?').hour_note).toBeNull();
  });

  it('says "do północy" in sentences and 24:00 in tables', () => {
    const icr = card('Jakie jest ICR o 19?');
    expect(icr.sentence).toBe('Ta wartość jest ustawiona od 18:00 do północy.');
    expect(icr.table[icr.table.length - 1].end).toBe('24:00');
  });

  it('marks a profile not uploaded for 7 days and leaves the loop tile out', () => {
    const loopNow: TherapySettingsLoopInput = { source: 'PROFILE', rate: 0.35, plan_rate: 0.35, since: null, status_at: '2026-11-11T12:17:00.000Z' };
    const stale = card('Jaką bazę ma Janek?', { uploadedAt: '2026-10-30T08:00:00.000Z', loopNow });
    expect(stale.stale_label).toBe('12 dni temu');
    expect(stale.stale_text).toBe('Ustawienia z Trio są sprzed 12 dni. Jeśli od tego czasu coś się zmieniło, karta tego nie pokaże.');
    expect(stale.loop_now).toBeNull();
    expect(card('Jaką bazę ma Janek?', { uploadedAt: '2026-11-05T08:00:00.000Z' }).stale_label).toBeNull();
  });

  it('gives the NO_PROFILE card without a profile', () => {
    const missing = card('Jaką bazę ma Janek?', { profile: null });
    expect(missing).toMatchObject({ layout: 'NO_PROFILE', settings: [], missing: { title: 'Mellis nie ma jeszcze ustawień z Trio.', text: 'Pojawią się, gdy Trio wyśle profil do Nightscout.' } });
    expect(card('Jakie jest ICR?', { profile: { ...PROFILE, status: 'MISSING' } }).layout).toBe('NO_PROFILE');
    expect(card('Jakie jest ICR?', { profile: { ...PROFILE, carb_ratio_g_per_u: null }, loop: { nominative: 'Loop', genitive: 'Loopa' } }).missing?.title).toBe('Mellis nie ma jeszcze ustawień z Loopa.');
  });

  it('drops a lane the profile lacks', () => {
    expect(card('Pokaż ICR i ISF razem', { profile: { ...PROFILE, sensitivity_per_u: null } })).toMatchObject({ layout: 'SINGLE', title: 'ICR teraz' });
  });

  it('draws no card for a profile in mmol/l', () => {
    expect(card('Jakie jest ISF?', { profile: { ...PROFILE, units: 'mmol' } })).toBeNull();
  });

  it('goes through sanitizeMetricCard', () => {
    const therapy = card('Jakie Janek ma ustawienia?');
    expect(sanitizeMetricCard({ kind: 'THERAPY_SETTINGS', period_label: 'teraz', therapy })).toEqual({ kind: 'THERAPY_SETTINGS', period_label: 'teraz', therapy });
    expect(sanitizeMetricCard({ kind: 'THERAPY_SETTINGS', period_label: 'teraz', therapy: { ...therapy, version: 'v0' } })).toBeNull();
    expect(sanitizeMetricCard({ kind: 'THERAPY_SETTINGS', period_label: 'teraz', therapy: { ...therapy, settings: [] } })).toBeNull();
  });
});

describe('loopTile', () => {
  const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

  it('says "teraz" up to 15 minutes, the hour up to 30, nothing after', () => {
    const temp = { source: 'TEMP' as const, rate: 0.2, plan_rate: 0.35, since: null };
    expect(loopTile({ ...temp, status_at: at(10) }, NOW, TZ)?.text).toBe('Pętla ustawiła teraz bazę tymczasową 0,20 j/h.');
    expect(loopTile({ ...temp, status_at: at(22) }, NOW, TZ)?.text).toBe('Pętla podawała 0,20 j/h o 12:58.');
    expect(loopTile({ ...temp, status_at: at(31) }, NOW, TZ)).toBeNull();
  });

  it('says the plan, a temp at the plan rate, and a suspended pump', () => {
    expect(loopTile({ source: 'PROFILE', rate: 0.35, plan_rate: 0.35, since: null, status_at: at(3) }, NOW, TZ)?.text).toBe('Pętla podaje teraz bazę z planu.');
    expect(loopTile({ source: 'TEMP', rate: 0.35, plan_rate: 0.35, since: null, status_at: at(3) }, NOW, TZ)?.kind).toBe('PLAN');
    expect(loopTile({ source: 'SUSPENDED', rate: 0, plan_rate: 0.35, since: at(22), status_at: at(3) }, NOW, TZ)?.text).toBe('Pompa wstrzymana od 12:58.');
    expect(loopTile({ source: 'UNKNOWN', rate: null, plan_rate: 0.35, since: null, status_at: at(3) }, NOW, TZ)).toBeNull();
  });
});

describe('lastTherapyChange', () => {
  const upload = (at: string, icr: number) => ({ uploaded_at: at, profile: { carbratio: [{ time: '00:00', value: icr }], basal: [{ time: '00:00', value: 0.3 }], dia: 6 } });

  it('takes the first upload of the newest values, not the newest upload', () => {
    expect(lastTherapyChange([
      upload('2026-11-10T08:00:00.000Z', 8),
      upload('2026-11-03T08:00:00.000Z', 8),
      upload('2026-10-28T08:00:00.000Z', 9),
    ])).toEqual({ changed_at: '2026-11-03T08:00:00.000Z', uploaded_at: '2026-11-10T08:00:00.000Z', complete: true });
  });

  it('says when every listed upload holds the same values', () => {
    expect(lastTherapyChange([upload('2026-11-10T08:00:00.000Z', 8), upload('2026-11-03T08:00:00.000Z', 8)])).toMatchObject({ changed_at: '2026-11-03T08:00:00.000Z', complete: false });
    expect(lastTherapyChange([])).toBeNull();
  });
});

describe('therapySettingsReply (therapy-settings-reply.v1)', () => {
  const loop = { locative: 'Trio' };

  it('writes one line without numbers and offers the other settings', () => {
    for (const question of ['Jaką bazę ma Janek?', 'Jakie jest ICR o 13:00?', 'Pokaż ICR i ISF razem', 'A cel?']) {
      expect(therapySettingsReply(card(question)!, loop)).toEqual({ text: 'To ustawienia z profilu w Trio.', chips: ['Pokaż wszystkie ustawienia'] });
    }
  });

  it('offers no chip when the card shows every setting', () => {
    expect(therapySettingsReply(card('Jakie Janek ma ustawienia?')!, loop).chips).toEqual([]);
    expect(therapySettingsReply(card('Jakie ustawienia obowiązują o 18:30?')!, loop).chips).toEqual([]);
  });

  it('says which hour it shows when "o 7" holds another value at 19:00', () => {
    expect(therapySettingsReply(card('Jakie jest ICR o 7?')!, loop).text).toBe('Pokazuję 7:00 rano.');
  });

  it('points to the loop when there is no profile yet', () => {
    expect(therapySettingsReply(card('Jaką bazę ma Janek?', { profile: null })!, { locative: 'Loopie' })).toEqual({ text: 'Do tego czasu ustawienia są widoczne w Loopie.', chips: [] });
  });

  it('its chip is read as a settings question again', () => {
    expect(readTherapySettingsRequest('Pokaż wszystkie ustawienia')).toMatchObject({ kind: 'CARD', layout: 'OVERVIEW' });
  });
});
