import { describe, expect, it } from 'vitest';
import type { RescueEvaluation } from '@modules/rescue-carbs/application/rescue-detection';
import type { RescueDoseProposal } from '@modules/rescue-carbs/application/rescue-dose';
import { lightFact, NOW_LIGHT_FACT, dayLinesAllowed, minutesAccusative, hoursAccusative, decideCheckPush, decideNowSituation, NOW_SITUATION_STATES, risingHeld, situationConversationSeed, situationQuestions, type NowCarbEntry, type NowRemoteBolus, type NowSituationInput } from './now-situation';

// 12:40 in Warsaw, a Saturday, so neither the morning nor the evening praise applies by default.
const NOW = new Date('2026-11-07T11:40:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

/** Readings 5 minutes apart ending `endAgo` minutes ago; the last value is the newest. */
const series = (values: number[], endAgo = 1) => values.map((value, index) => ({ at: ago(endAgo + (values.length - 1 - index) * 5), value }));
/** Flat history before the given tail, so the 3-hour and 2-hour rules have what they read. */
const withHistory = (tail: number[], flat: number, hours = 4, endAgo = 1) => series([...Array(hours * 12).fill(flat), ...tail], endAgo);
const snapshots = (overrides: Partial<{ iob_u: number; cob_g: number; rate_u_per_h: number | null }> = {}, newestAgo = 2) =>
  [125, 95, 65, 35, 25, 15, 5].map((minutes) => ({ at: ago(minutes + newestAgo - 5), iob_u: 0, cob_g: 0, rate_u_per_h: 1, ...overrides }));

const dose = (grams: number | null): RescueDoseProposal => ({
  policy_version: 'rescue-dose.v3', carbs_g: grams, min_g: 3, max_g: 20, basis: grams === null ? 'NO_PROFILE' : 'FORMULA', csf_mgdl_per_g: 10,
  isf_mgdl_per_u: 100, icr_g_per_u: 10, settings_source: 'LOOP', iob_u: 0, cob_g: 0, trio_carbs_req_g: null, explanation: [], warnings: [],
});

const evaluation = (overrides: Partial<RescueEvaluation> = {}): RescueEvaluation => ({
  policy_version: 'rescue-carbs.v2.1', evaluated_at: NOW.toISOString(), status: 'CLEAR', level: null, trigger_source: null, suppressed_reason: null, no_data_reason: null,
  glucose: null, delta_per_5min: 0, slope_per_min: 0, loop_used: true, carbs_req_g: null, predicted_min_mgdl: 100, predicted_low_at: null, minutes_to_low: null, curve: null, clear: true, ...overrides,
});

const base = (overrides: Partial<NowSituationInput>): NowSituationInput => ({
  now: NOW,
  time_zone: 'Europe/Warsaw',
  viewer_user_id: 'me',
  readings: withHistory([120, 120, 120], 120),
  loop: { system: 'TRIO', snapshots: snapshots(), plan_rate_u_per_h: 1 },
  isf_mgdl_per_u: 100,
  boluses: [],
  smbs: [],
  carbs: [],
  evaluation: evaluation(),
  dose: dose(5),
  alert: null,
  forecast_peak_mgdl: 150,
  check_push_live: true,
  ...overrides,
});

const entry = (minutesAgo: number, grams = 5, more: Partial<NowCarbEntry> = {}): NowCarbEntry => ({ at: ago(minutesAgo), grams, kind: 'HYPO_TREATMENT', source: 'MELLIS', by_user_id: 'me', ...more });
const alertNow = { notified_at: ago(3), last_triggered_at: ago(1) };
const triggered = (overrides: Partial<RescueEvaluation> = {}) => evaluation({ status: 'TRIGGER', level: 'PREDICTED_LOW', minutes_to_low: 25, predicted_min_mgdl: 65, clear: false, ...overrides });

describe('now-situation states', () => {
  it.each<[string, string, Partial<NowSituationInput>, string, string | null]>([
    ['praise', '1', {}, 'Od 4 godzin glukoza jest w zakresie.', null],
    ['default when the loop keeps insulin active', '1d', { loop: { system: 'TRIO', snapshots: snapshots({ iob_u: 1 }), plan_rate_u_per_h: 1 } }, '', null],
    ['after a meal', '2', {
      readings: withHistory([120, 126, 133], 120),
      loop: { system: 'TRIO', snapshots: snapshots({ cob_g: 20, iob_u: 1 }), plan_rate_u_per_h: 1 },
      boluses: [{ at: ago(40), units: 2 }],
      carbs: [{ at: ago(40), grams: 30, kind: 'MEAL', source: 'LOOP' }],
    }, '', null],
    ['above 180 and rising, the loop adding after a bolus', '3', {
      readings: withHistory([180, 186, 194], 150),
      smbs: [{ at: ago(10), units: 0.2 }],
      boluses: [{ at: ago(100), units: 1 }],
    }, '', null],
    ['above 250, nothing to explain', '3a', { readings: withHistory([255, 262, 270], 170) }, '', null],
    ['long above 250', '3b', { readings: withHistory([], 280, 3) }, 'Od 2,5 godziny glukoza jest powyżej 250.', 'Warto sprawdzić wkłucie i zmierzyć ketony.'],
    ['high and falling fast, no cause', '3c', { readings: withHistory([230, 215, 198], 230) }, '', null],
    ['long above 250, loop silent', '3d', { readings: withHistory([], 280, 3), loop: { system: 'TRIO', snapshots: snapshots({}, 31), plan_rate_u_per_h: 1 } }, 'a Trio nie przysyła danych.', 'Warto sprawdzić wkłucie i telefon z Trio oraz zmierzyć ketony.'],
    ['falling fast, no forecast', '4', { readings: withHistory([150, 140, 130], 160) }, '', null],
    ['falling fast below 110, no forecast', '4b', { readings: withHistory([120, 108, 96], 125) }, '', null],
    ['forecast with grams', '5', { readings: withHistory([100, 96, 92], 110), alert: alertNow, evaluation: triggered(), dose: dose(4), chart_line: [{ at: ago(-20), value: 75, low: 62, high: 88 }] }, 'wkrótce spaść poniżej 70.', null],
    ['forecast without grams', '5b', { readings: withHistory([140, 135, 130], 150), alert: alertNow, evaluation: triggered({ minutes_to_low: null }), chart_line: [{ at: ago(-30), value: 66 }] }, 'Glukoza może wkrótce spaść poniżej 70.', null],
    ['alarm while the chart stays above 70', '5b', { readings: withHistory([140, 135, 130], 150), alert: alertNow, evaluation: triggered({ minutes_to_low: null }), chart_line: [{ at: ago(-30), value: 110, low: 90, high: 130 }] }, 'Glukoza może wkrótce spaść poniżej 70.', 'Linia na wykresie tego jeszcze nie pokazuje.'],
    ['alarm with grams, no chart line', '5', { readings: withHistory([100, 96, 92], 110), alert: alertNow, evaluation: triggered(), dose: dose(4) }, 'Glukoza może wkrótce spaść poniżej 70.', 'Linia na wykresie tego jeszcze nie pokazuje.'],
    ['below 70', '6', { readings: withHistory([78, 72, 66], 90) }, '', null],
    ['below 70 with active insulin', '6', { readings: withHistory([78, 72, 66], 90), loop: { system: 'TRIO', snapshots: snapshots({ iob_u: 1 }), plan_rate_u_per_h: 1 } }, 'Insulina jeszcze działa, więc spadek może potrwać.', null],
    ['below 70 already rising', '6b', { readings: withHistory([58, 62, 66], 90) }, '', null],
    ['below 70, rising, forecast clears it', '6c', {
      readings: withHistory([58, 62, 66], 90),
      evaluation: evaluation({ predicted_min_mgdl: 66, curve: { name: 'IOB', includes_cob: false, points: [{ at: ago(0), value: 66 }, { at: ago(-30), value: 85 }] } }),
    }, 'Glukoza jest poniżej 70, ale powoli rośnie. Jeśli przestanie rosnąć, podaj węgle.', 'Trio prognozuje, że za 30 minut glukoza wyniesie około 85.'],
    ['below 70, rising from under 60: no waiting', '6', {
      readings: withHistory([54, 56, 58], 90),
      evaluation: evaluation({ predicted_min_mgdl: 58, curve: { name: 'IOB', includes_cob: false, points: [{ at: ago(0), value: 58 }, { at: ago(-30), value: 85 }] } }),
    }, '', null],
    ['below 70, rising, but the loop is silent: no waiting', '6e', {
      readings: withHistory([58, 62, 66], 90),
      loop: { system: 'TRIO', snapshots: snapshots({}, 16), plan_rate_u_per_h: 1 },
      evaluation: evaluation({ predicted_min_mgdl: 66, curve: { name: 'IOB', includes_cob: false, points: [{ at: ago(0), value: 66 }, { at: ago(-30), value: 85 }] } }),
    }, 'Trio nie przysyła danych od 16 minut', null],
    ['below 70, rising, the forecast counting carbs of 10 minutes ago: no waiting, the softened dose', '6b', {
      readings: withHistory([58, 62, 66], 90),
      carbs: [{ at: ago(10), grams: 30, kind: 'MEAL', source: 'LOOP' }],
      evaluation: evaluation({ predicted_min_mgdl: 66, curve: { name: 'COB', includes_cob: true, points: [{ at: ago(0), value: 66 }, { at: ago(-30), value: 85 }] } }),
    }, '', null],
    ['below 70, rising, the forecast counting carbs of 25 minutes ago: waits', '6c', {
      readings: withHistory([58, 62, 66], 90),
      carbs: [{ at: ago(25), grams: 30, kind: 'MEAL', source: 'LOOP' }],
      boluses: [{ at: ago(25), units: 2 }],
      evaluation: evaluation({ predicted_min_mgdl: 66, curve: { name: 'COB', includes_cob: true, points: [{ at: ago(0), value: 66 }, { at: ago(-30), value: 85 }] } }),
    }, 'Jeśli przestanie rosnąć, podaj węgle.', 'Trio prognozuje'],
    ['below 70, rising slowly for too long', '6', {
      readings: withHistory([56, 58, 60, 62, 64, 66], 90),
      evaluation: evaluation({ predicted_min_mgdl: 66, curve: { name: 'IOB', includes_cob: false, points: [{ at: ago(0), value: 66 }, { at: ago(-30), value: 85 }] } }),
    }, '', null],
    ['below 70, rising slowly, no forecast, for too long', '6', { readings: withHistory([56, 58, 60, 62, 64, 66], 90) }, '', null],
    ['below 70 after a steep fall', '6d', { readings: withHistory([110, 90, 65], 110) }, 'Spadek był bardzo szybki. Warto sprawdzić odczyt glukometrem.', 'Jeśli nie da się zmierzyć, podaj węgle.'],
    ['below 70, loop silent', '6e', { readings: withHistory([78, 72, 66], 90), loop: { system: 'TRIO', snapshots: snapshots({}, 31), plan_rate_u_per_h: 1 } }, 'Trio nie przysyła danych od 31 minut, więc nie wiadomo, czy baza jest wstrzymana.', null],
    ['below 70 without ISF or ICR', '6g', { readings: withHistory([78, 72, 66], 90), dose: dose(null) }, 'Podaj szybkie węgle.', 'Bez przeliczników insuliny Mellis nie proponuje ilości węgli.'],
    ['below 54', '7', { readings: withHistory([64, 58, 52], 90), dose: dose(8) }, 'Gdy pacjent nie reaguje, ma drgawki albo nie może przełykać, nie podawaj niczego doustnie. Podaj glukagon i zadzwoń pod 112.', null],
    ['below 54 without ISF or ICR', '7b', { readings: withHistory([64, 58, 52], 90), dose: dose(null) }, 'Podaj od razu szybkie węgle. Gdy pacjent', 'Bez przeliczników insuliny Mellis nie proponuje ilości węgli.'],
    ['own carbs', '8', { readings: withHistory([70, 67, 66], 90), carbs: [entry(4)] }, 'Podano 5 g węgli o 12:36.', null],
    ['own carbs from 70 up', '8', { readings: withHistory([76, 74, 72], 90), carbs: [entry(4)] }, 'Podano 5 g węgli o 12:36. Mellis da znać, jeśli glukoza spadnie poniżej 70.', null],
    ['the other caregiver', '8b', { readings: withHistory([70, 67, 66], 90), carbs: [entry(4, 5, { by_user_id: 'ewa', by_name: 'Ewa' })] }, 'Opiekun Ewa podał 5 g węgli o 12:36.', null],
    ['a loop entry, no tap', '8c', { readings: withHistory([70, 67, 66], 90), carbs: [{ at: ago(4), grams: 5, kind: null, source: 'LOOP' }] }, 'W Trio zapisano 5 g węgli o 12:36.', null],
    ['still below 54 right after carbs', '8g', { readings: withHistory([58, 52, 50], 90), carbs: [entry(5, 8)] }, 'Podaj glukagon i zadzwoń pod 112.', 'Podano 8 g węgli o 12:35.'],
    ['carbs, then no reading', '8j', { readings: withHistory([70, 66], 90, 4, 18), carbs: [entry(20)] }, 'Zmierz glukozę glukometrem.', 'Podano 5 g węgli o 12:20.'],
    ['no reading', '9', { readings: withHistory([120], 120, 4, 24) }, 'Warto sprawdzić sensor i telefon z Trio.', null],
    ['no reading for over an hour', '9', { readings: withHistory([120], 120, 4, 70) }, 'Bez odczytów Mellis nie ostrzeże o spadku.', 'Do czasu odczytów warto mierzyć glukozę glukometrem.'],
    ['old low reading', '9b', { readings: withHistory([66], 90, 4, 16) }, 'Zmierz glukozę glukometrem.', null],
    ['old near-low reading', '9b', { readings: withHistory([78], 90, 4, 16) }, 'Warto zmierzyć glukozę glukometrem.', null],
    ['loop silent', '9c', { loop: { system: 'TRIO', snapshots: snapshots({}, 31), plan_rate_u_per_h: 1 } }, 'Trio nie przysyła danych od 31 minut.', 'Warto sprawdzić telefon z Trio.'],
  ])('%s → %s', (_name, state, overrides, sentence, detail) => {
    const result = decideNowSituation(base(overrides));
    expect(result.state).toBe(state);
    expect(result.sentence).toContain(sentence);
    if (detail === null) expect(result.detail).toBeNull();
    else expect(result.detail).toContain(detail);
  });

  it('an old reading: no "Zapisz węgle", and the carbs with no reading from 70 ask for a meter', () => {
    expect(decideNowSituation(base({ readings: withHistory([66], 90, 4, 16) })).action).toBeNull();
    expect(decideNowSituation(base({ readings: withHistory([78], 90, 4, 16) })).action).toBeNull();
    const stale = decideNowSituation(base({ readings: withHistory([80, 76, 74], 90, 4, 18), carbs: [entry(25)] }));
    expect(stale).toMatchObject({ state: '8j', sentence: 'Warto zmierzyć glukozę glukometrem.', detail: 'Podano 5 g węgli o 12:15.' });
  });

  it('gives the dose, the juice and the action below 70', () => {
    const result = decideNowSituation(base({ readings: withHistory([78, 72, 66], 90) }));
    expect(result.second).toEqual({ kind: 'DOSE', label: 'Podaj', value: '5 g', unit: 'szybkich węgli', note: 'około 50 ml soku' });
    expect(result.action).toMatchObject({ kind: 'GIVEN', grams: 5, style: 'FILLED', label: 'Podano 5 g', other_amount_label: 'Inna ilość' });
    expect(result.glucose?.tone).toBe('RED');
  });

  it('softens the dose while glucose already rises, and for a forecast', () => {
    const rising = decideNowSituation(base({ readings: withHistory([58, 62, 66], 90) }));
    expect(rising.second).toMatchObject({ kind: 'SOFT_DOSE', label: 'Jeśli nie podano węgli', note: null });
    expect(rising.action).toMatchObject({ style: 'OUTLINE' });
    const forecast = decideNowSituation(base({ readings: withHistory([100, 96, 92], 110), alert: alertNow, evaluation: triggered(), dose: dose(4) }));
    expect(forecast.second).toMatchObject({ kind: 'FORECAST_DOSE', label: 'Możesz podać', value: '4 g' });
    expect(forecast.glucose?.tone).toBe('NEUTRAL');
  });

  it('shows the tones', () => {
    expect(decideNowSituation(base({ readings: withHistory([64, 58, 52], 90) })).glucose?.tone).toBe('ON_RED');
    expect(decideNowSituation(base({ readings: withHistory([185, 192, 199], 150) })).glucose?.tone).toBe('AMBER');
    expect(decideNowSituation(base({ readings: withHistory([120], 120, 4, 24) })).glucose?.tone).toBe('STALE');
  });

  it('names the loop in every case', () => {
    const loop = (minutes: number) => ({ system: 'LOOP' as const, snapshots: snapshots({}, minutes), plan_rate_u_per_h: 1 });
    expect(decideNowSituation(base({ loop: loop(31) })).detail).toBe('Warto sprawdzić telefon z Loopem.');
    expect(decideNowSituation(base({ readings: withHistory([70, 67, 66], 90), carbs: [{ at: ago(4), grams: 5, kind: null, source: 'LOOP' }], loop: loop(2) })).sentence).toBe('W Loopie zapisano 5 g węgli o 12:36.');
    expect(decideNowSituation(base({ readings: withHistory([110, 117, 124, 131, 138, 145, 152, 159, 166, 173, 180, 188], 110), boluses: [{ at: ago(191), units: 5 }], loop: { ...loop(2), plan_rate_u_per_h: 0.05, rate_now: { rate_u_per_h: 0.2, since: ago(40) } } })).sentence).toBe('W Loopie nie ma węgli, które tłumaczyłyby ten wzrost.');
  });

  it('says nothing about a loop a patient does not have', () => {
    const result = decideNowSituation(base({ loop: { system: 'UNKNOWN', snapshots: [], plan_rate_u_per_h: null } }));
    expect(result.state).toBe('1d');
  });

  it('uses the patient label, never declined', () => {
    const result = decideNowSituation(base({ readings: withHistory([64, 58, 52], 90), patient_label: 'Ewa' }));
    expect(result.sentence).toContain('Gdy Ewa nie reaguje, ma drgawki albo nie może przełykać');
  });

  it('leaves out "Mellis da znać" until its push exists', () => {
    const result = decideNowSituation(base({ readings: withHistory([70, 67, 66], 90), carbs: [entry(4)], check_push_live: false }));
    expect(result.state).toBe('8');
    expect(result.detail).toBeNull();
  });
});

describe('now-situation priority', () => {
  it('a stale reading beats everything except carbs just given', () => {
    expect(decideNowSituation(base({ readings: withHistory([52], 90, 4, 16), dose: dose(8) })).state).toBe('9b');
    expect(decideNowSituation(base({ readings: withHistory([52], 90, 4, 16), carbs: [entry(14)] })).state).toBe('8j');
    expect(decideNowSituation(base({ readings: withHistory([52], 90, 4, 16), carbs: [entry(40)] })).state).toBe('9b');
  });

  it('below 54 beats a running check, but no new dose for 10 minutes', () => {
    expect(decideNowSituation(base({ readings: withHistory([60, 56, 52], 90), carbs: [entry(5, 8)] })).state).toBe('8g');
    expect(decideNowSituation(base({ readings: withHistory([60, 56, 52], 90), carbs: [entry(12, 8)] })).state).toBe('7');
  });

  it('a check beats a low and hides the dose', () => {
    const result = decideNowSituation(base({ readings: withHistory([70, 67, 66], 90), carbs: [entry(4)] }));
    expect(result.state).toBe('8');
    expect(result.action).toBeNull();
    expect(result.second).toMatchObject({ kind: 'CHECK', label: 'Kolejne sprawdzenie za', value: '11 min' });
  });

  it('a low beats a silent loop, which gets the sentence', () => {
    expect(decideNowSituation(base({ readings: withHistory([78, 72, 66], 90), loop: { system: 'TRIO', snapshots: snapshots({}, 31), plan_rate_u_per_h: 1 } })).state).toBe('6e');
  });

  it('a silent loop beats a forecast', () => {
    expect(decideNowSituation(base({ alert: alertNow, evaluation: triggered(), loop: { system: 'TRIO', snapshots: snapshots({}, 31), plan_rate_u_per_h: 1 } })).state).toBe('9c');
  });

  it('a forecast beats high and fast falling', () => {
    expect(decideNowSituation(base({ readings: withHistory([230, 215, 198], 230), alert: alertNow, evaluation: triggered({ minutes_to_low: null }) })).state).toBe('5b');
  });

  it('a meal beats "above 180" only within 2 hours of the bolus', () => {
    const meal = (bolusAgo: number) => base({
      readings: withHistory([180, 186, 194], 150),
      loop: { system: 'TRIO', snapshots: snapshots({ cob_g: 20, iob_u: 1 }), plan_rate_u_per_h: 1 },
      boluses: [{ at: ago(bolusAgo), units: 2 }],
      carbs: [{ at: ago(bolusAgo), grams: 30, kind: 'MEAL', source: 'LOOP' }],
    });
    expect(decideNowSituation(meal(90)).state).toBe('2');
    expect(decideNowSituation(meal(130)).state).toBe('3');
  });

  it('carbs without a bolus are not the meal state', () => {
    const result = decideNowSituation(base({
      readings: withHistory([120, 126, 133], 120),
      loop: { system: 'TRIO', snapshots: snapshots({ cob_g: 20 }), plan_rate_u_per_h: 1 },
      boluses: [{ at: ago(170), units: 2 }],
      carbs: [{ at: ago(30), grams: 30, kind: 'MEAL', source: 'LOOP' }],
    }));
    expect(result.state).not.toBe('2');
  });

  it('a slow fall changes nothing: the plain in-range sentence stays', () => {
    const result = decideNowSituation(base({ readings: withHistory([150, 145, 140], 155) }));
    expect(result.state).toBe('1d');
  });

  it('a fast fall goes before "nothing to do" after a meal, a slow one does not', () => {
    const meal = (tail: number[]) => base({
      readings: withHistory(tail, 150),
      loop: { system: 'TRIO', snapshots: snapshots({ cob_g: 20, iob_u: 1 }), plan_rate_u_per_h: 1 },
      boluses: [{ at: ago(40), units: 2 }],
      carbs: [{ at: ago(40), grams: 30, kind: 'MEAL', source: 'LOOP' }],
    });
    expect(decideNowSituation(meal([146, 142, 138])).state).toBe('2');
    expect(decideNowSituation(meal([140, 128, 116])).state).toBe('4');
  });

  it('shows the grams the push gave while its alert runs, at any glucose', () => {
    const result = decideNowSituation(base({
      readings: withHistory([140, 135, 130], 150),
      alert: { ...alertNow, grams: 3 },
      evaluation: triggered({ minutes_to_low: null }),
      dose: dose(4),
    }));
    expect(result.state).toBe('5');
    expect(result.second).toMatchObject({ kind: 'FORECAST_DOSE', value: '3 g' });
  });

  it('grams stay once shown for an alert, up to 110, and the sentence with them', () => {
    const later = (value: number, grams_since: string | null) => base({
      readings: withHistory([value, value, value], 105),
      alert: { ...alertNow, grams_since },
      evaluation: triggered({ minutes_to_low: null }),
      dose: dose(4),
      chart_line: [{ at: ago(-30), value: 80, low: 64, high: 96 }],
    });
    expect(decideNowSituation(later(108, null)).state).toBe('5b');
    const kept = decideNowSituation(later(108, ago(10)));
    expect(kept.state).toBe('5');
    expect(kept.sentence).toContain('wkrótce');
    expect(decideNowSituation(later(115, ago(10))).state).toBe('5b');
  });
});

describe('now-situation hysteresis', () => {
  it('a low ends after two readings from 75', () => {
    const state = (tail: number[]) => decideNowSituation(base({ readings: withHistory(tail, 90) })).state;
    expect(state([66, 72, 76])).toBe('6b');
    expect(state([66, 72, 76, 77])).not.toMatch(/^6/);
  });

  it('never says "below 70" at 70–74 during the exit', () => {
    const result = decideNowSituation(base({ readings: withHistory([60, 66, 72], 90) }));
    expect(result.state).toBe('6b');
    expect(result.sentence).not.toContain('poniżej 70');
    expect(result.light).toBeUndefined();
    expect(result.second).toBeNull();
  });

  it('red stays until two readings from 60', () => {
    const state = (tail: number[]) => decideNowSituation(base({ readings: withHistory(tail, 90) })).state;
    expect(state([50, 56, 58])).toBe('7');
    expect(state([50, 61, 58])).toBe('7');
    expect(state([50, 61, 62])).toMatch(/^6/);
  });

  it('"already rising": one flat reading keeps it, a drop of 2 ends it at once', () => {
    expect(risingHeld(series([58, 60, 63, 63]))).toBe(true);
    expect(risingHeld(series([58, 60, 63, 61]))).toBe(false);
    expect(risingHeld(series([58, 60, 63, 63, 63]))).toBe(false);
    expect(risingHeld(series([60, 60, 62]))).toBe(false);
  });

  it('the forecast stays for two readings outside its condition', () => {
    const input = (lastFlag: number) => base({
      readings: withHistory([110, 108, 108, 108], 110),
      alert: { notified_at: ago(20), last_triggered_at: ago(lastFlag) },
      evaluation: evaluation({ status: 'CLEAR', minutes_to_low: null }),
    });
    expect(decideNowSituation(input(3)).state).toBe('5b');
    expect(decideNowSituation(input(8)).state).not.toBe('5b');
  });

  it('holds a calm state for 10 minutes unless the newest reading contradicts it', () => {
    // Fell fast 6 minutes ago, then flat: "Glukoza spada." stays while the reading does not rise.
    const held = decideNowSituation(base({ readings: withHistory([145, 145], 155), loop: { system: 'TRIO', snapshots: snapshots({ iob_u: 1 }), plan_rate_u_per_h: 1 } }));
    expect(held.state).toBe('4');
    const contradicted = decideNowSituation(base({ readings: withHistory([145, 147], 155), loop: { system: 'TRIO', snapshots: snapshots({ iob_u: 1 }), plan_rate_u_per_h: 1 } }));
    expect(contradicted.state).toBe('1d');
  });

  it('a fast fall interrupts a held calm sentence at once', () => {
    const result = decideNowSituation(base({ readings: withHistory([125, 120, 108], 125), loop: { system: 'TRIO', snapshots: snapshots({ iob_u: 1 }), plan_rate_u_per_h: 1 } }));
    expect(result.state).toBe('4b');
  });

  it('an urgent state interrupts a held calm state at once', () => {
    expect(decideNowSituation(base({ readings: withHistory([95, 85, 75, 66], 110) })).state).toMatch(/^6/);
  });

  it('praise returns only 15 minutes after it went', () => {
    // Fell out of praise 20 minutes ago by a brief fall, calm again since.
    const lostLongAgo = withHistory([112, 104, 104, 104, 104, 104], 120, 5);
    const recent = withHistory([112, 104, 104], 120, 5);
    expect(decideNowSituation(base({ readings: lostLongAgo })).state).toBe('1');
    expect(decideNowSituation(base({ readings: recent })).state).toBe('1d');
  });
});

describe('now-situation undo window', () => {
  const justNow = (seconds: number, more: Partial<NowCarbEntry> = {}): NowCarbEntry => ({ ...entry(0, 8), id: 'event-1', at: new Date(NOW.getTime() - seconds * 1000).toISOString(), ...more });

  it('shows "Cofnij" for 5 seconds, even below 54 and with an old reading', () => {
    for (const readings of [withHistory([64, 58, 52], 90), withHistory([66], 90, 4, 16)]) {
      const result = decideNowSituation(base({ readings, carbs: [justNow(2)] }));
      expect(result.state).toBe('8u');
      expect(result.second).toMatchObject({ kind: 'GIVEN', label: 'Podano', value: '8 g' });
      expect(result.sentence).toBe('Węgle zostaną zapisane za 5 sekund.');
      expect(result.detail).toBeNull();
      expect(result.action).toEqual({ kind: 'UNDO', label: 'Cofnij', event_id: 'event-1', until: new Date(NOW.getTime() + 3000).toISOString() });
    }
  });

  it('then the check runs, without a new dose', () => {
    const result = decideNowSituation(base({ readings: withHistory([70, 67, 66], 90), carbs: [justNow(6, { grams: 5 })] }));
    expect(result.state).toBe('8');
    expect(result.action).toBeNull();
  });

  it('a loop entry has no undo', () => {
    expect(decideNowSituation(base({ readings: withHistory([70, 67, 66], 90), carbs: [justNow(2, { source: 'LOOP', kind: null })] })).state).toBe('8c');
  });
});

describe('now-situation check after carbs', () => {
  const readings = (values: number[]) => withHistory(values, 90);
  it('8d: back from a low, overriding the 75 rule', () => {
    const result = decideNowSituation(base({ readings: readings([66, 66, 71, 72, 73, 74]), carbs: [entry(30)] }));
    expect(result.state).not.toMatch(/^6/);
  });

  it('8d: no sentence, the number says glucose is back from 70', () => {
    const result = decideNowSituation(base({ readings: readings([66, 66, 70, 76, 82]), carbs: [entry(16)] }));
    expect(result.state).toBe('8d');
    expect(result.sentence).toBe('');
    expect(result.detail).toBeNull();
  });

  it('carbs given for a forecast: no countdown, Mellis watches for a reading below 70', () => {
    const result = decideNowSituation(base({ readings: readings([84, 84, 85, 85, 86]), carbs: [entry(16)] }));
    expect(result.state).toBe('8');
    expect(result.second).toBeNull();
    expect(result.sentence).toBe('Podano 5 g węgli o 12:24. Mellis da znać, jeśli glukoza spadnie poniżej 70.');
    expect(result.detail).toBeNull();
    expect(result.check).toBeNull();
  });

  it('8i: carbs given for a forecast, no low in the 45-minute watch', () => {
    const result = decideNowSituation(base({ readings: readings([84, 84, 85, 85, 86]), carbs: [entry(50)] }));
    expect(result.state).toBe('8i');
    expect(result.sentence).toBe('');
  });

  it('8f: from 70 but falling, with a second check', () => {
    const result = decideNowSituation(base({ readings: readings([66, 66, 80, 76, 72]), carbs: [entry(16)] }));
    expect(result.state).toBe('8f');
    expect(result.second).toMatchObject({ label: 'Kolejne sprawdzenie za', value: '9 min' });
    expect(result.sentence).toBe('Podano 5 g węgli o 12:24. Jeśli glukoza spadnie poniżej 70 wcześniej, Mellis da znać od razu.');
    expect(result.detail).toBeNull();
  });

  it('8e: still below 70 but rising, with a second check', () => {
    const result = decideNowSituation(base({ readings: readings([60, 60, 60, 63, 66]), carbs: [entry(16)] }));
    expect(result.state).toBe('8e');
    expect(result.sentence).toBe('16 minut po 5 g węgli glukoza nadal jest poniżej 70.');
    expect(result.detail).toBeNull();
  });

  it('still below 70 at the second look and no longer rising: 6f with the new dose at once', () => {
    const result = decideNowSituation(base({ readings: readings([60, 60, 63, 66, 64]), carbs: [entry(21)], dose: dose(4) }));
    expect(result.state).toBe('6f');
    expect(result.sentence).toBe('21 minut po 5 g węgli glukoza nadal jest poniżej 70.');
    expect(result.second).toMatchObject({ kind: 'DOSE', label: 'Podaj', value: '4 g' });
  });

  it('6f: still below 70 and not rising gives a new dose', () => {
    const result = decideNowSituation(base({ readings: readings([64, 64, 64, 64, 64]), carbs: [entry(25)], dose: dose(4) }));
    expect(result.state).toBe('6f');
    expect(result.sentence).toBe('25 minut po 5 g węgli glukoza nadal jest poniżej 70.');
    expect(result.second).toMatchObject({ value: '4 g' });
  });

  it('a meal is not rescue carbs', () => {
    const result = decideNowSituation(base({
      readings: readings([78, 72, 66]),
      carbs: [{ at: ago(4), grams: 40, kind: null, source: 'LOOP' }],
    }));
    expect(result.state).toBe('6');
  });

  it('small carbs with a bolus are not rescue carbs', () => {
    const result = decideNowSituation(base({
      readings: readings([78, 72, 66]),
      carbs: [{ at: ago(4), grams: 10, kind: null, source: 'LOOP' }],
      boluses: [{ at: ago(3), units: 1 }],
    }));
    expect(result.state).toBe('6');
  });

  it('small loop carbs after an alert count at any glucose', () => {
    const result = decideNowSituation(base({
      readings: withHistory([100, 96, 95], 110),
      carbs: [{ at: ago(4), grams: 8, kind: null, source: 'LOOP' }],
      recent_alerts_notified_at: [ago(10)],
    }));
    expect(result.state).toBe('8c');
    expect(result.sentence).toBe('W Trio zapisano 8 g węgli o 12:36. Mellis da znać, jeśli glukoza spadnie poniżej 70.');
    expect(result.detail).toBeNull();
  });
});

describe('now-situation conversation', () => {
  it('has two or three questions for every state, naming the loop', () => {
    for (const state of NOW_SITUATION_STATES) expect(situationQuestions(state, 'TRIO').length).toBeGreaterThanOrEqual(2);
    for (const state of ['1', '1b', '1c', '1d', '8d', '8i'] as const) expect(situationQuestions(state, 'TRIO')).not.toContain('Co się działo w tym czasie?');
    expect(situationQuestions('1e', 'TRIO')).toContain('Co się działo w tym czasie?');
    for (const state of ['2b', '3d', 'P'] as const) expect(situationQuestions(state, 'TRIO')).not.toContain('Kiedy podać insulinę penem?');
    expect(situationQuestions('3e', 'TRIO')).toContain('Kiedy podać insulinę penem?');
    expect(situationQuestions('P', 'TRIO')).toContain('Co sprawdzić, zanim włączę pompę?');
    expect(situationQuestions('6', 'LOOP')).toContain('Czy Loop poda insulinę na te węgle?');
    expect(situationQuestions('3b', 'TRIO')[0]).toBe('Kiedy i jak zmierzyć ketony?');
    expect(situationQuestions('8', 'TRIO')).toContain('Czy Trio uwzględnia te węgle?');
    expect(situationQuestions('6c', 'TRIO')).not.toContain('Czy ta ilość wystarczy?');
    expect(situationQuestions('2c', 'TRIO')).toContain('Jak wysoko może wzrosnąć glukoza?');
    expect(situationQuestions('3f', 'TRIO')).toContain('Dlaczego Trio przewiduje spadek?');
  });

  it('starts with the same picture as the screen', () => {
    const situation = decideNowSituation(base({ readings: withHistory([78, 72, 66], 90) }));
    expect(situationConversationSeed({ situation, iob: 0.66, cob: 0, basal: 0.3, timeZone: 'Europe/Warsaw', now: NOW }))
      .toBe('Z ekranu Teraz, 12:40. Glukoza 66 mg/dL. Propozycja 5 g szybkich węgli. IOB 0,66 j, COB 0 g, baza 0,3 j/h.');
  });
});

describe('now-situation check pushes', () => {
  const given = (minutes: number) => ({ ...entry(minutes), id: 'event-1' });

  it('says nothing while the check runs or when glucose is back', () => {
    expect(decideCheckPush(base({ readings: withHistory([70, 67, 66], 90), carbs: [given(4)] }))).toBeNull();
    expect(decideCheckPush(base({ readings: withHistory([66, 66, 68, 69, 72], 90), carbs: [given(16)] }))).toBeNull();
    expect(decideCheckPush(base({ readings: withHistory([120], 120), carbs: [] }))).toBeNull();
  });

  it('still below 70: with the new dose, once per result', () => {
    const push = decideCheckPush(base({ readings: withHistory([64, 64, 64, 64, 64], 90), carbs: [given(16)], dose: dose(4) }));
    expect(push).toMatchObject({ kind: 'still_low', title: 'Po węglach: 64', body: 'Minęło 15 min, a glukoza nadal jest poniżej 70. Mellis proponuje jeszcze 4 g szybkich węglowodanów.' });
    expect(push?.key).toContain('event-1:still_low');
  });

  it('still below 70 and rising: names the next check', () => {
    const push = decideCheckPush(base({ readings: withHistory([60, 60, 60, 63, 66], 90), carbs: [given(16)] }));
    expect(push).toMatchObject({ kind: 'rising_low', title: 'Po węglach: 66' });
    expect(push?.body).toBe('Minęło 15 min i glukoza rośnie. Więcej węgli nie trzeba. Mellis sprawdzi ją znowu o 12:49.');
  });

  it('below 70 before the check, after carbs from 70 up: at once, once, not for phones with their own low alert', () => {
    const push = decideCheckPush(base({ readings: withHistory([84, 78, 72, 68], 90), carbs: [given(9)] }));
    expect(push).toMatchObject({ kind: 'below_low', key: 'event-1:below_low', title: 'Po węglach: 68', skip_if_low_alert: true });
    expect(push?.body).toBe('Węgle z 12:31 zwykle działają po 10–15 min. Mellis sprawdzi glukozę o 12:54. Do tego czasu nie podawaj kolejnych węgli.');
    // Carbs given while already below 70: the check says it at 15 minutes, as before.
    expect(decideCheckPush(base({ readings: withHistory([70, 67, 66], 90), carbs: [given(4)] }))).toBeNull();
  });

  it('no reading after the check: asks for a meter, after a moment of grace', () => {
    expect(decideCheckPush(base({ readings: withHistory([66], 66, 4, 16), carbs: [given(19)] }))?.body).toBe('Od węgli minęło 15 min, a nowego odczytu nie ma. Zmierz glukozę glukometrem.');
    expect(decideCheckPush(base({ readings: withHistory([66], 66, 4, 16), carbs: [given(17)] }))).toBeNull();
  });

  it('watching after carbs from a forecast: a push when readings stop, and one when they come back', () => {
    const gap = decideCheckPush(base({ readings: withHistory([90], 90, 4, 19), carbs: [given(25)] }));
    expect(gap).toMatchObject({ kind: 'no_reading', key: 'event-1:no_reading', title: 'Po węglach: brak odczytu', body: 'Od 19 min nie ma nowego odczytu. Zmierz glukozę glukometrem.' });
    expect(decideCheckPush(base({ readings: withHistory([90], 90, 4, 12), carbs: [given(25)] }))).toBeNull();
    const back = decideCheckPush(base({ readings: withHistory([90, 95, 99], 90), carbs: [given(25)], sent_check_push_keys: ['event-1:no_reading'] }));
    expect(back).toMatchObject({ kind: 'reading_back', key: 'event-1:reading_back', title: 'Po węglach: 99', body: 'Odczyt wrócił, glukoza rośnie.' });
    expect(decideCheckPush(base({ readings: withHistory([90, 95, 99], 90), carbs: [given(25)], sent_check_push_keys: ['event-1:no_reading'], trend_direction: 'FortyFiveUp' }))?.title).toBe('Po węglach: 99 ↗');
    expect(decideCheckPush(base({ readings: withHistory([90, 95, 99], 90), carbs: [given(25)] }))).toBeNull();
  });
});

describe('now-situation praise', () => {
  const praise = (at: string, overrides: Partial<NowSituationInput> = {}) => decideNowSituation(base({
    now: new Date(at),
    readings: Array.from({ length: 12 * 15 }, (_, index) => ({ at: new Date(Date.parse(at) - (index * 5 + 1) * 60_000).toISOString(), value: 110 + (index % 3) })),
    loop: { system: 'TRIO', snapshots: [{ at: new Date(Date.parse(at) - 120_000).toISOString(), iob_u: 0, cob_g: 0, rate_u_per_h: 1 }], plan_rate_u_per_h: 1 },
    ...overrides,
  }));

  it('after a good night in the morning', () => {
    const result = praise('2026-11-07T07:30:00.000Z');
    expect(result.state).toBe('1b');
    expect(result.sentence).toMatch(/^(Pięknie|Świetnie|Klasa)\. Przez całą noc glukoza była w zakresie\.$/);
  });

  it('after a good day in the evening', () => {
    const result = praise('2026-11-07T18:30:00.000Z');
    expect(result.state).toBe('1c');
    expect(result.sentence).toMatch(/^((Pięknie|Świetnie|Klasa)\. Od 14 godzin glukoza jest w zakresie\.|Od 14 godzin glukoza jest w zakresie\. Brawo 👏)$/);
  });

  it.each<[string, Partial<NowSituationInput>]>([
    ['COB', { loop: { system: 'TRIO', snapshots: snapshots({ cob_g: 3 }), plan_rate_u_per_h: 1 } }],
    ['insulin that would take glucose under 90', { loop: { system: 'TRIO', snapshots: snapshots({ iob_u: 0.5 }), plan_rate_u_per_h: 1 } }],
    ['a long zero basal', { loop: { system: 'TRIO', snapshots: snapshots({ rate_u_per_h: 0 }), plan_rate_u_per_h: 1 } }],
    ['an open alert', { alert: { notified_at: ago(90), last_triggered_at: ago(60) } }],
    ['unknown ISF', { isf_mgdl_per_u: null }],
    ['a low inside the window', { readings: withHistory([120, 120, ...Array(30).fill(120)], 120).map((reading, index, all) => (index === all.length - 20 ? { ...reading, value: 68 } : reading)) }],
    ['a gap in the readings', { readings: withHistory(Array(30).fill(120), 120).filter((_, index, all) => index > all.length - 33 && (index < all.length - 20 || index > all.length - 10)) }],
  ])('none with %s', (_name, overrides) => {
    expect(decideNowSituation(base(overrides)).state).not.toMatch(/^1(b|c)?$/);
  });

  it('goes away after 10 minutes without a reading', () => {
    expect(decideNowSituation(base({ readings: withHistory([], 120, 4, 9) })).state).toBe('1');
    expect(decideNowSituation(base({ readings: withHistory([], 120, 4, 11) })).state).toBe('1d');
  });
});

describe('now-situation texts v2', () => {
  it('counts minutes in the accusative', () => {
    expect([45, 60, 90, 119, 120, 150, 180, 300].map(hoursAccusative)).toEqual(['45 minut', 'godzinę', '1,5 godziny', '1,5 godziny', '2 godziny', '2,5 godziny', '3 godziny', '5 godzin']);
    expect([1, 2, 4, 5, 12, 14, 22, 25, 112].map(minutesAccusative)).toEqual(['Minutę', '2 minuty', '4 minuty', '5 minut', '12 minut', '14 minut', '22 minuty', '25 minut', '112 minut']);
  });
  it('keeps the dose at 70–74 while insulin can still turn the rise around', () => {
    const readings = withHistory([60, 66, 72], 90);
    const lots = decideNowSituation(base({ readings, loop: { system: 'TRIO', snapshots: snapshots({ iob_u: 1 }), plan_rate_u_per_h: 1 } }));
    expect(lots.second).toMatchObject({ label: 'Jeśli nie podano węgli' });
    const none = decideNowSituation(base({ readings }));
    expect(none.state).toBe('6b');
    expect(none.second).toBeNull();
    expect(none.action).toBeNull();
  });
  it('long above 250: one variant from 2 hours, with the ketone threshold (owner decision 5)', () => {
    for (const input of [{ readings: withHistory([], 280, 5) }, { readings: withHistory([], 280, 3), site_changed_at: ago(3 * 24 * 60 + 5) }]) {
      const result = decideNowSituation(base(input));
      expect(result.state).toBe('3b');
      expect(result.sentence).toMatch(/^Od \d(,5 godziny| godzin) glukoza jest powyżej 250\.$/);
      expect(result.detail).toBe('Warto sprawdzić wkłucie i zmierzyć ketony. Przy ketonach od 0,6 mmol/l wymień wkłucie i podaj korektę penem według planu z poradni.');
    }
  });
  it('says who gave the carbs in the undo window on the other phone', () => {
    const given = { id: 'e', at: new Date(NOW.getTime() - 2000).toISOString(), grams: 3, kind: 'HYPO_TREATMENT' as const, source: 'MELLIS' as const, by_user_id: 'ewa', by_name: 'Ewa' };
    expect(decideNowSituation(base({ readings: withHistory([70, 67, 66], 90), carbs: [given] })).sentence).toBe('Opiekun Ewa podał węgle. Mellis zapisze je za 5 sekund.');
  });
  it('names a suspended pump before anything calm', () => {
    const result = decideNowSituation(base({ pump_suspended_since: ago(25) }));
    expect(result.state).toBe('P');
    expect(result.sentence).toBe('Pompa jest wstrzymana od 25 minut.');
    expect(result.detail).toBe('Jeśli wstrzymanie nie było celowe, warto włączyć pompę.');
    expect(decideNowSituation(base({ pump_suspended_since: ago(70) })).detail).toBe('Bez insuliny od ponad godziny rośnie ryzyko ketonów.');
    expect(decideNowSituation(base({ pump_suspended_since: ago(5) })).state).not.toBe('P');
  });
  it('says when a correction did not work', () => {
    const readings = withHistory([], 240, 3);
    const result = decideNowSituation(base({ readings: readings.map((reading) => ({ ...reading, value: Math.max(210, reading.value) })), boluses: [{ at: ago(90), units: 2 }] }));
    expect(result.state).toBe('3e');
    expect(result.sentence).toBe('Półtorej godziny po korekcie glukoza nie spadła.');
    const later = decideNowSituation(base({ readings: readings.map((reading) => ({ ...reading, value: Math.max(210, reading.value) })), boluses: [{ at: ago(125), units: 2 }] }));
    expect(later.sentence).toBe('2 godziny po korekcie glukoza nie spadła.');
  });

  it('a correction told by the time since it, the fall until now, and not while the loop gives less basal', () => {
    // 240 before the correction 70 minutes ago, 225 now.
    const readings = series([...Array(30).fill(240), ...Array(12).fill(232), 225, 225]);
    const result = decideNowSituation(base({ readings, boluses: [{ at: ago(70), units: 2 }] }));
    expect(result.state).toBe('3e');
    expect(result.sentence).toBe('Godzinę po korekcie glukoza spadła tylko o 15.');
    const lessBasal = decideNowSituation(base({ readings, boluses: [{ at: ago(70), units: 2 }], loop: { system: 'TRIO', snapshots: snapshots(), plan_rate_u_per_h: 1, rate_now: { rate_u_per_h: 0.4, since: ago(40) } } }));
    expect(lessBasal.state).not.toBe('3e');
  });
  it('says when logged carbs have no bolus', () => {
    const result = decideNowSituation(base({
      readings: withHistory([130, 135, 140], 125),
      carbs: [{ at: ago(30), grams: 30, kind: null, source: 'LOOP' }],
      dose: { ...dose(5), icr_g_per_u: 10 },
      loop: { system: 'TRIO', snapshots: snapshots({ cob_g: 20, iob_u: 0.2 }), plan_rate_u_per_h: 1 },
    }));
    expect(result.state).toBe('2c');
    expect(result.sentence).toContain('ale nie ma do nich bolusa.');
    expect(result.detail).toBe('Jeśli bolus podano penem, warto go zapisać w Trio.');
  });
  it('still rising long after the meal bolus: 2b only once the loop counts the carbs as nearly absorbed', () => {
    const meal = (cob: number) => decideNowSituation(base({
      readings: withHistory([200, 206, 212, 218], 150),
      boluses: [{ at: ago(100), units: 3 }],
      carbs: [{ at: ago(100), grams: 40, kind: 'MEAL', source: 'LOOP' }],
      loop: { system: 'TRIO', snapshots: snapshots({ cob_g: cob, iob_u: 1 }), plan_rate_u_per_h: 1 },
    }));
    expect(meal(0)).toMatchObject({ state: '2b', sentence: '1,5 godziny po bolusie glukoza nadal rośnie.', detail: 'Warto sprawdzić wkłucie albo czy węgli nie było więcej.' });
    expect(meal(4).state).toBe('2b');
    expect(meal(20).state).toBe('2');
  });
  it('says when a bolus has no carbs', () => {
    const result = decideNowSituation(base({
      boluses: [{ at: ago(30), units: 1 }],
      loop: { system: 'TRIO', snapshots: snapshots({ iob_u: 1 }), plan_rate_u_per_h: 1 },
    }));
    expect(result.state).toBe('1f');
    expect(result.sentence).toBe('W Trio nie ma węgli do bolusa z 12:10.');
    expect(result.detail).toBe('Jeśli ten bolus nie był do jedzenia, glukoza może spaść.');
  });
  it('allows a day line only with nothing going on', () => {
    const quiet = base({});
    const situation = { ...decideNowSituation(quiet), state: '1d' as const, sentence: '' };
    const atNoon = { ...quiet };
    expect(dayLinesAllowed(atNoon, situation)).toBe(true);
    expect(dayLinesAllowed({ ...atNoon, bolus_problem: true }, situation)).toBe(false);
    expect(dayLinesAllowed({ ...atNoon, alert: alertNow }, situation)).toBe(false);
    expect(dayLinesAllowed({ ...atNoon, evaluation: evaluation({ predicted_min_mgdl: null }) }, situation)).toBe(false);
    expect(dayLinesAllowed({ ...atNoon, readings: withHistory([120, 120, 120], 60) }, situation)).toBe(false);
    expect(dayLinesAllowed(atNoon, { ...situation, state: '5' })).toBe(false);
  });
  it('never puts a fact in the sentence: above 180 with nothing to say the line stays empty', () => {
    const plain = decideNowSituation(base({ readings: withHistory([200, 204, 208], 170) }));
    expect(plain.state).toBe('3');
    expect(plain.sentence).toBe('');
    expect(plain.light).toBeUndefined();
    expect(situationConversationSeed({ situation: plain, iob: null, cob: null, basal: null, timeZone: 'Europe/Warsaw', now: NOW })).not.toMatch(/\s$/);
  });
  it('gives the one hummingbird fact two hours a day only, the same on both phones', () => {
    const start = Date.UTC(2026, 10, 7, 0, 0);
    const days = Array.from({ length: 6 }, (_, day) => Array.from({ length: 24 }, (_, hour) => lightFact(new Date(start + (day * 24 + hour) * 3_600_000), 'Europe/Warsaw')).filter(Boolean));
    days.forEach((facts) => expect(facts.length).toBe(2));
    expect(new Set(days.flat())).toEqual(new Set([NOW_LIGHT_FACT]));
    expect(lightFact(new Date(start + 60_000), 'Europe/Warsaw')).toBe(lightFact(new Date(start + 120_000), 'Europe/Warsaw'));
  });
  it('says "spada" only when the sensor arrow falls too', () => {
    // One fall of 12: two readings at the same level first, then the drop.
    const readings = withHistory([142, 142, 130], 142);
    expect(decideNowSituation(base({ readings, trend_direction: 'SingleDown' })).state).toBe('4');
    expect(decideNowSituation(base({ readings, trend_direction: null })).state).toBe('4');
    const flat = decideNowSituation(base({ readings, trend_direction: 'Flat' }));
    expect(flat.state).toBe('1d');
    expect(flat.sentence).not.toContain('spada');
    // A real fall is told against the arrow: over three readings, very fast, or with insulin acting.
    expect(decideNowSituation(base({ readings: withHistory([150, 140, 130], 160), trend_direction: 'Flat' })).state).toBe('4');
    expect(decideNowSituation(base({ readings: withHistory([142, 142, 125], 142), trend_direction: 'Flat' })).state).toBe('4');
    expect(decideNowSituation(base({ readings, trend_direction: 'Flat', loop: { system: 'TRIO', snapshots: snapshots({ iob_u: 1 }), plan_rate_u_per_h: 1 } })).state).toBe('4');
    // A little insulin does not keep it: 130 − 0.2 × 100 stays far above 70.
    expect(decideNowSituation(base({ readings, trend_direction: 'Flat', loop: { system: 'TRIO', snapshots: snapshots({ iob_u: 0.2 }), plan_rate_u_per_h: 1 } })).state).not.toBe('4');
    const acting = decideNowSituation(base({ readings, trend_direction: 'FortyFiveDown', loop: { system: 'TRIO', snapshots: snapshots({ iob_u: 1 }), plan_rate_u_per_h: 1 } }));
    expect(acting.state).toBe('4');
    expect(decideNowSituation(base({ readings: withHistory([120, 108, 96], 125), trend_direction: 'Flat' })).state).toBe('4b');
  });
});

const remote = (minutes: number, units: number, carbs_g: number, by: Partial<NowRemoteBolus> = {}): NowRemoteBolus =>
  ({ at: ago(minutes), units, carbs_g, status: 'SUCCEEDED', by_user_id: 'ewa', by_name: 'Ewa', by_gender: 'f', ...by });
const mine = (minutes: number, units: number, carbs_g = 0) => remote(minutes, units, carbs_g, { by_user_id: 'me', by_name: 'Piotr', by_gender: 'm' });

describe('now-situation v4: another caregiver\'s bolus (owner, 2026-11-08)', () => {
  const high = { readings: withHistory([150, 158, 166, 172, 180, 188], 150), loop: { system: 'TRIO' as const, snapshots: snapshots({ iob_u: 1 }), plan_rate_u_per_h: 1 } };

  it('names who gave it and how long ago, with the form the caregiver chose', () => {
    const input = { ...high, boluses: [{ at: ago(5), units: 0.7 }], remote_boluses: [remote(6, 0.7, 0)] };
    expect(decideNowSituation(base(input)).sentence).toBe('Ewa podała bolus 0,7 j 5 minut temu.');
    expect(decideNowSituation(base({ ...input, remote_boluses: [remote(6, 0.7, 0, { by_name: 'Piotr', by_gender: 'm' })] })).sentence).toBe('Piotr podał bolus 0,7 j 5 minut temu.');
    expect(decideNowSituation(base({ ...input, remote_boluses: [remote(6, 0.7, 0, { by_gender: null })] })).sentence).toBe('Opiekun Ewa podał bolus 0,7 j 5 minut temu.');
    expect(decideNowSituation(base({ ...input, remote_boluses: [remote(6, 0.7, 0, { by_name: null, by_gender: null })] })).sentence).toBe('Drugi opiekun podał bolus 0,7 j 5 minut temu.');
  });

  it('adds the carbs of the same command', () => {
    const result = decideNowSituation(base({ ...high, boluses: [{ at: ago(2), units: 0.7 }], remote_boluses: [remote(2, 0.7, 5)] }));
    expect(result.sentence).toBe('Ewa podała bolus 0,7 j na 5 g węgli 2 minuty temu.');
  });

  it('a bolus no one sent from Mellis is "poza Mellis"', () => {
    expect(decideNowSituation(base({ ...high, boluses: [{ at: ago(0.5), units: 1 }] })).sentence).toBe('Bolus 1 j z 12:39 podano poza Mellis.');
    expect(decideNowSituation(base({ ...high, boluses: [{ at: ago(1), units: 1 }] })).sentence).toBe('Bolus 1 j z 12:39 podano poza Mellis.');
    expect(decideNowSituation(base({ ...high, boluses: [{ at: ago(14), units: 1 }, { at: ago(4), units: 0.5 }] })).sentence).toBe('Dwa bolusy, razem 1,5 j, ostatni z 12:36, podano poza Mellis.');
  });

  it('says nothing about the reader\'s own bolus, nor after 20 minutes', () => {
    expect(decideNowSituation(base({ ...high, boluses: [{ at: ago(5), units: 0.7 }], remote_boluses: [mine(5, 0.7)] })).sentence).not.toContain('bolus');
    expect(decideNowSituation(base({ ...high, boluses: [{ at: ago(21), units: 0.7 }], remote_boluses: [remote(21, 0.7, 0)] })).sentence).not.toContain('bolus');
  });

  it('a failed try then the same dose again is one bolus, not two (2026-11-15)', () => {
    // 13:52 0.6 delivered; 14:09:15 0.8 PARTIAL (carbs saved, bolus rejected); 14:09:50 0.8 retry delivered.
    const result = decideNowSituation(base({
      ...high,
      boluses: [{ at: ago(18), units: 0.6 }, { at: ago(1), units: 0.8 }],
      remote_boluses: [remote(18, 0.6, 5), remote(1.6, 0.8, 7, { status: 'PARTIAL' }), remote(1, 0.8, 0)],
    }));
    expect(result.sentence).toBe('Ewa podała dwa bolusy, razem 1,4 j, ostatni minutę temu.');
  });

  it('two boluses of one caregiver: the total and the newest', () => {
    const result = decideNowSituation(base({ ...high, boluses: [{ at: ago(15), units: 0.5 }, { at: ago(5), units: 0.7 }], remote_boluses: [remote(15, 0.5, 0), remote(5, 0.7, 0)] }));
    expect(result.sentence).toBe('Ewa podała dwa bolusy, razem 1,2 j, ostatni 5 minut temu.');
  });

  it('five boluses of one caregiver: "bolusów"', () => {
    const times = [18, 14, 10, 6, 2];
    const result = decideNowSituation(base({ ...high, boluses: times.map((t) => ({ at: ago(t), units: 0.2 })), remote_boluses: times.map((t) => remote(t, 0.2, 0)) }));
    expect(result.sentence).toContain('5 bolusów');
  });

  it('a bolus the loop confirmed but Nightscout does not have yet', () => {
    expect(decideNowSituation(base({ ...high, remote_boluses: [remote(3, 0.7, 0)] })).sentence).toBe('Ewa podała bolus 0,7 j 3 minuty temu.');
  });

  it('with no carbs for it, the bolus line leads and the carbs follow', () => {
    const result = decideNowSituation(base({ boluses: [{ at: ago(10), units: 1 }], remote_boluses: [remote(10, 1, 0)], loop: { system: 'TRIO', snapshots: snapshots({ iob_u: 1 }), plan_rate_u_per_h: 1 } }));
    expect(result.sentence).toBe('Ewa podała bolus 1 j 10 minut temu.');
    expect(result.detail).toBe('W Trio nie ma do niego węgli. Jeśli ten bolus nie był do jedzenia, glukoza może spaść.');
  });

  it('below 70 the low leads and the bolus waits under it', () => {
    const result = decideNowSituation(base({ readings: withHistory([78, 72, 66], 90), boluses: [{ at: ago(10), units: 1 }], remote_boluses: [remote(10, 1, 0)] }));
    expect(result.state).toMatch(/^6/);
    expect(result.sentence).not.toContain('bolus');
  });

  it('carbs another caregiver gave use the chosen form too', () => {
    const result = decideNowSituation(base({ readings: withHistory([70, 67, 66], 90), carbs: [entry(4, 5, { by_user_id: 'ewa', by_name: 'Ewa', by_gender: 'f' })] }));
    expect(result.sentence).toBe('Ewa podała 5 g węgli o 12:36.');
  });
});

describe('now-situation v3 (teraz-sentence-review, 2026-11-08)', () => {
  /** Forecast points 5 minutes apart from now on. */
  const ahead = (values: number[]) => values.map((value, index) => ({ at: ago(-(index + 1) * 5), value }));
  const trio = (overrides: Partial<{ iob_u: number; cob_g: number; rate_u_per_h: number | null }>, rate_now: { rate_u_per_h: number; since: string } | null = null, plan = 0.05) =>
    ({ system: 'TRIO' as const, snapshots: snapshots({ rate_u_per_h: null, ...overrides }), plan_rate_u_per_h: plan, rate_now });

  it('screenshot 1: 188 rising, basal raised, no carbs: what Trio does and that nothing explains the rise', () => {
    const readings = withHistory([110, 117, 124, 131, 138, 145, 152, 159, 166, 173, 180, 188], 110);
    const input = { readings, boluses: [{ at: ago(191), units: 5 }], loop: trio({ iob_u: 1.16 }, { rate_u_per_h: 0.2, since: ago(40) }) };
    const result = decideNowSituation(base(input));
    expect(result.state).toBe('3');
    expect(result.sentence).toBe('W Trio nie ma węgli, które tłumaczyłyby ten wzrost.');
    expect(result.detail).toBeNull();
    // Without the running basal nothing tells what Trio does: then no sentence, never a fact.
    const blind = decideNowSituation(base({ ...input, loop: trio({ iob_u: 1.16 }) }));
    expect(blind.sentence).toBe('');
    expect(blind.light).toBeUndefined();
  });

  it('screenshot 2: a bolus a minute ago is never told back as "still working"', () => {
    const input = {
      readings: withHistory([150, 158, 166, 172, 180, 188], 150),
      boluses: [{ at: ago(1), units: 0.6 }],
      // The reader sent it from Mellis: nothing about their own bolus.
      remote_boluses: [mine(1, 0.6, 5)],
      carbs: [{ at: ago(1), grams: 5, kind: 'MEAL' as const, source: 'LOOP' as const }],
      loop: trio({ iob_u: 1.16 }),
    };
    const result = decideNowSituation(base(input));
    expect(result.state).toBe('2d');
    expect(result.sentence).toBe('');
    expect(result.detail).toBeNull();
    // v4: not even with the insulin peak from the loop's settings.
    expect(decideNowSituation(base({ ...input, insulin_peak_minutes: 75 })).sentence).toBe('');
  });

  it('screenshot 3: 222 rising fast right after a meal: no hummingbird', () => {
    const result = decideNowSituation(base({
      readings: withHistory([150, 160, 170, 180, 188, 196, 205, 222], 140),
      boluses: [{ at: ago(1), units: 1.6 }],
      remote_boluses: [mine(1, 1.6, 15)],
      carbs: [{ at: ago(1), grams: 15, kind: 'MEAL', source: 'LOOP' }],
      loop: trio({ iob_u: 2.7, cob_g: 10 }),
      forecast_peak_mgdl: 260,
    }));
    expect(result.state).toBe('2d');
    expect(result.sentence).toBe('');
    expect(result.light).toBeUndefined();
  });

  it('screenshot 4: 259 with zero basal: why Trio gives none, and when it is below 180 again', () => {
    const curve = ahead([255, 250, 244, 238, 230, 222, 214, 205, 196, 188, 181, 176, 172]);
    const input = {
      readings: withHistory([240, 252, 260, 265, 263, 259], 200, 3),
      boluses: [{ at: ago(43), units: 1.2 }, { at: ago(70), units: 1.6 }],
      carbs: [{ at: ago(43), grams: 10, kind: 'MEAL' as const, source: 'LOOP' as const }, { at: ago(70), grams: 15, kind: 'MEAL' as const, source: 'LOOP' as const }],
      loop: trio({ iob_u: 2.9, cob_g: 14 }, { rate_u_per_h: 0, since: ago(25) }),
      loop_curve: curve,
      chart_line: curve,
    };
    const result = decideNowSituation(base(input));
    expect(result.state).toBe('3f');
    expect(result.sentence).toBe('Trio nie podaje bazy, bo przewiduje spadek.');
    // v4: no forecast number under it.
    expect(result.detail).toBeNull();
    // A status older than the newest bolus says nothing about the forecast.
    expect(decideNowSituation(base({ ...input, boluses: [...input.boluses, { at: ago(0.5), units: 0.1 }] })).state).not.toBe('3f');
  });

  it('a correction that works says nothing (v4)', () => {
    const curve = ahead([224, 215, 205, 190, 175, 160, 140, 120, 100, 88, 85]);
    const result = decideNowSituation(base({
      readings: withHistory([260, 255, 250, 245, 240, 232], 260, 3),
      boluses: [{ at: ago(45), units: 1 }],
      loop: trio({ iob_u: 0.8 }),
      loop_curve: curve,
      chart_line: curve,
    }));
    expect(result.state).toBe('3g');
    expect(result.sentence).toBe('');
  });

  it('above 250 and rising for half an hour although Trio adds insulin, no carbs: the site and ketones', () => {
    const result = decideNowSituation(base({
      readings: withHistory([240, 246, 252, 258, 264, 270, 277], 230),
      smbs: [{ at: ago(10), units: 0.3 }],
      loop: trio({ iob_u: 0.5 }),
    }));
    expect(result.sentence).toBe('Trio dodaje insulinę, a glukoza nie spada.');
    expect(result.detail).toBe('Warto sprawdzić wkłucie i zmierzyć ketony.');
  });

  it('back in range after 40 minutes above 180 says nothing (v4)', () => {
    const result = decideNowSituation(base({ readings: withHistory([190, 192, 194, 192, 190, 188, 186, 184, 176, 175], 150) }));
    expect(result.state).toBe('1e');
    expect(result.sentence).toBe('');
  });

  it('praise is an opening word and a short body, the word changing between episodes (owner, 2026-11-09)', () => {
    const result = decideNowSituation(base({}));
    expect(result.state).toBe('1');
    expect(result.sentence).toMatch(/^((Pięknie|Świetnie|Klasa)\. Od 4 godzin glukoza jest w zakresie\.|Od 4 godzin glukoza jest w zakresie\. Brawo 👏)$/);
    // Runs that start in other hours take the other words, one in four closes with "Brawo 👏" (owner, 2026-11-12);
    // the same run keeps its word.
    const opening = (sentence: string) => (sentence.endsWith(' Brawo 👏') ? 'Brawo 👏' : sentence.split(' ')[0]);
    const sentences = [0, 1, 2, 3].map((hours) => decideNowSituation(base({ readings: withHistory([120, 120, 120], 120, 4 + hours) })).sentence);
    expect(new Set(sentences.map(opening))).toEqual(new Set(['Pięknie.', 'Świetnie.', 'Klasa.', 'Brawo 👏']));
    expect(sentences).toContain(`Od ${sentences.find((s) => s.endsWith('Brawo 👏'))!.split(' ')[1]} godzin glukoza jest w zakresie. Brawo 👏`);
    expect(opening(decideNowSituation(base({ now: new Date(NOW.getTime() + 60_000) })).sentence)).toBe(opening(result.sentence));
  });

  it('praise only from 4 hours, and not for a run further apart than 50', () => {
    expect(decideNowSituation(base({ readings: withHistory([120, 120, 120], 120, 3) })).state).toBe('1d');
    expect(decideNowSituation(base({ readings: withHistory([170, 165, 160, 155], 110) })).state).not.toMatch(/^1(b|c)?$/);
  });

  it('no opening word for 12 hours after a reading below 54', () => {
    const readings = [...withHistory([], 120, 10), ...series([50], 11 * 60)].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    const result = decideNowSituation(base({ readings }));
    expect(result.state).toBe('1');
    expect(result.sentence).toBe('Od 9 godzin glukoza jest w zakresie.');
  });
});

describe('now-situation v5: planned meal and the bar button (owner, 2026-11-09)', () => {
  // NOW is 12:40 in Warsaw.
  const meal = (minutesFromNow: number, more: Partial<{ id: string; title: string; items: string[]; answered: boolean }> = {}) => ({
    id: more.id ?? 'meal-1', title: more.title ?? 'obiad', planned_at: ago(-minutesFromNow), items: more.items ?? ['Zupa pomidorowa', 'Pierogi ruskie', 'Kompot'], answered: more.answered ?? false,
  });
  const calm = { loop: { system: 'TRIO' as const, snapshots: snapshots({ iob_u: 1 }), plan_rate_u_per_h: 1 } };

  it('half an hour before: the time, the title as the plan gives it, two dishes, and the meal\'s button', () => {
    const result = decideNowSituation(base({ ...calm, planned_meals: [meal(20)] }));
    expect(result.sentence).toBe('Obiad jest o 13:00.');
    expect(result.detail).toBe('Zupa pomidorowa i pierogi ruskie.');
    expect(result.link).toEqual({ kind: 'MEAL_PLAN_ENTRY', entry_id: 'meal-1', label: 'Obiad' });
  });

  it('never declines the title; an abbreviation keeps its capitals', () => {
    expect(decideNowSituation(base({ ...calm, planned_meals: [meal(10, { title: 'Zupa i podwieczorek', items: [] })] })).sentence).toBe('Zupa i podwieczorek jest o 12:50.');
    expect(decideNowSituation(base({ ...calm, planned_meals: [meal(10, { title: 'II śniadanie', items: [] })] })).sentence).toBe('II śniadanie jest o 12:50.');
  });

  it('says nothing earlier than 30 minutes before, nor once carbs or a bolus were entered for it', () => {
    expect(decideNowSituation(base({ ...calm, planned_meals: [meal(40)] })).sentence).toBe('');
    expect(decideNowSituation(base({ ...calm, planned_meals: [meal(20)], carbs: [{ at: ago(5), grams: 20, kind: 'MEAL', source: 'LOOP' }] })).sentence).not.toContain('obiad');
    expect(decideNowSituation(base({ ...calm, planned_meals: [meal(20)], boluses: [{ at: ago(5), units: 1 }], remote_boluses: [] })).sentence).not.toContain('obiad');
    // An SMB-sized bolus is not the meal's.
    expect(decideNowSituation(base({ ...calm, planned_meals: [meal(20)], remote_boluses: [mine(5, 0.2)] })).sentence).toBe('Obiad jest o 13:00.');
    expect(decideNowSituation(base({ ...calm, planned_meals: [meal(20)], remote_boluses: [mine(5, 0.5)] })).sentence).toBe('');
  });

  it('after the meal with nothing entered: from 25 to 90 minutes, from 100 mg/dL, unless a caregiver answered', () => {
    const late = (minutesAfter: number, more: Partial<NowSituationInput> = {}) => decideNowSituation(base({ ...calm, planned_meals: [meal(-minutesAfter)], ...more }));
    expect(late(30).sentence).toBe('Do posiłku z 12:10 nie ma wpisu węgli.');
    expect(late(30).link).toEqual({ kind: 'MEAL_PLAN_ENTRY', entry_id: 'meal-1', label: 'Obiad' });
    expect(late(10).sentence).toBe('');
    expect(late(95).sentence).toBe('');
    expect(late(30, { readings: withHistory([96, 96, 96], 96) }).sentence).toBe('');
    expect(decideNowSituation(base({ ...calm, planned_meals: [meal(-30, { answered: true })] })).sentence).toBe('');
  });

  it('a low or a forecast keeps the line; the forecast gets the meal\'s button only for a meal still ahead', () => {
    const low = decideNowSituation(base({ readings: withHistory([78, 72, 66], 90), planned_meals: [meal(20)] }));
    expect(low.sentence).not.toContain('obiad');
    const forecast = { readings: withHistory([140, 135, 130], 150), alert: alertNow, evaluation: triggered({ minutes_to_low: null }), chart_line: [{ at: ago(-30), value: 66 }] };
    const ahead = decideNowSituation(base({ ...forecast, planned_meals: [meal(20)] }));
    expect(ahead.state).toBe('5b');
    expect(ahead.sentence).not.toContain('obiad');
    expect(ahead.link).toEqual({ kind: 'MEAL_PLAN_ENTRY', entry_id: 'meal-1', label: 'Obiad' });
    expect(decideNowSituation(base({ ...forecast, planned_meals: [meal(-20)] })).link).toBeNull();
  });

  it('another caregiver\'s bolus keeps the line, with the meal\'s button', () => {
    const result = decideNowSituation(base({ ...calm, boluses: [{ at: ago(5), units: 0.7 }], remote_boluses: [remote(6, 0.7, 0)], planned_meals: [meal(10)] }));
    expect(result.sentence).toBe('Ewa podała bolus 0,7 j 5 minut temu.');
    expect(result.link?.kind).toBe('MEAL_PLAN_ENTRY');
  });

  it('a conversation only where nothing else can be opened; no button in calm or beside an action', () => {
    expect(decideNowSituation(base({ readings: withHistory([], 280, 3) })).link).toEqual({ kind: 'CONVERSATION', label: 'Rozmowa o tym' });
    expect(decideNowSituation(base({})).link).toBeNull();
    expect(decideNowSituation(base({ ...calm })).link).toBeNull();
    const withAction = decideNowSituation(base({ readings: withHistory([100, 96, 92], 110), alert: alertNow, evaluation: triggered(), dose: dose(4), chart_line: [{ at: ago(-20), value: 75, low: 62, high: 88 }], planned_meals: [meal(20)] }));
    if (withAction.action) expect(withAction.link).toBeNull();
  });

  it('meal-eaten.v1: no meal question on Teraz, not even after a low with a meal\'s insulin', () => {
    const check = decideNowSituation(base({ readings: withHistory([70, 67, 66], 90), carbs: [entry(4)] }));
    expect(check.state).toBe('8');
    expect(check.second).toMatchObject({ kind: 'CHECK', label: 'Kolejne sprawdzenie za' });
    expect(check.link).toBeNull();
  });

  it('without a plan read nothing changes', () => {
    expect(decideNowSituation(base({ ...calm })).sentence).toBe('');
  });
});
