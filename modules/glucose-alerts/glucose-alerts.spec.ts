import { describe, expect, it, vi } from 'vitest';
import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import {
  activeGlucoseKinds,
  crossedGlucoseKinds,
  decideGlucoseAlert,
  highRunOf,
  sensorWarmupPushText,
  glucosePushText,
  GlucoseAlertService,
  noDataPushText,
  type GlucoseAlertDevice,
  type GlucoseAlertState,
  type GlucoseAlertStore,
  type GlucoseObservation,
} from './application/glucose-alerts';

const NOW = new Date('2026-11-02T18:00:00.000Z');
const PATIENT = '11111111-1111-4111-8111-111111111111';

function minutesAgo(minutes: number, from = NOW): string {
  return new Date(from.getTime() - minutes * 60_000).toISOString();
}

function reading(value: number, direction: string | null, delta: number | null, extra: Partial<GlucoseObservation> = {}): GlucoseObservation {
  return { value, observed_at: minutesAgo(1), direction, delta, iob_units: 1.25, cob_grams: 15, ...extra };
}

function state(partial: Partial<GlucoseAlertState> = {}): GlucoseAlertState {
  return { patient_id: PATIENT, last_reading_at: null, sent: {}, no_data_sent_at: null, revision: 2, ...partial };
}

describe('activeGlucoseKinds (glucose-alerts.v1)', () => {
  it('follows the bands and the arrow', () => {
    expect(activeGlucoseKinds({ value: 65, direction: 'Flat', delta: 0 })).toEqual(['low']);
    expect(activeGlucoseKinds({ value: 65, direction: 'DoubleDown', delta: -20 })).toEqual(['low', 'fast_fall']);
    expect(activeGlucoseKinds({ value: 75, direction: 'FortyFiveDown', delta: -6 })).toEqual(['falling']);
    expect(activeGlucoseKinds({ value: 75, direction: 'Flat', delta: -1 })).toEqual([]);
    // Under 80 the change decides, not the arrow (owner 2026-11-15): −5 or more in 5 minutes.
    expect(activeGlucoseKinds({ value: 75, direction: 'FortyFiveDown', delta: -4 })).toEqual([]);
    expect(activeGlucoseKinds({ value: 75, direction: 'Flat', delta: -5 })).toEqual(['falling']);
    expect(activeGlucoseKinds({ value: 70, direction: 'SingleDown', delta: -12 })).toEqual(['falling']);
    expect(activeGlucoseKinds({ value: 80, direction: 'SingleDown', delta: -12 })).toEqual([]);
    expect(activeGlucoseKinds({ value: 160, direction: 'SingleUp', delta: 12 })).toEqual([]);
    // Above 160 nothing per reading (owner 2026-11-15): crossings and the run above 180 say it.
    expect(activeGlucoseKinds({ value: 260, direction: 'Flat', delta: 5 })).toEqual([]);
    expect(activeGlucoseKinds({ value: 181, direction: 'SingleUp', delta: 12 })).toEqual([]);
    expect(activeGlucoseKinds({ value: 190, direction: 'DoubleUp', delta: 20 })).toEqual(['fast_rise']);
    expect(activeGlucoseKinds({ value: 120, direction: 'DoubleUp', delta: 20 })).toEqual(['fast_rise']);
  });

  it('takes the arrow from the 5-minute change without a direction', () => {
    expect(activeGlucoseKinds({ value: 120, direction: null, delta: -18 })).toEqual(['fast_fall']);
    expect(activeGlucoseKinds({ value: 120, direction: null, delta: 18 })).toEqual(['fast_rise']);
  });
});

const PHONE: GlucoseAlertDevice = { device_id: 'a', push_token: 'ta', kinds_off: [], low_repeat_minutes: 15, repeat_minutes: 30 };

function phone(partial: Partial<GlucoseAlertDevice> = {}): GlucoseAlertDevice {
  return { ...PHONE, ...partial };
}

function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
}

/** A reading 1 minute before `when`, judged at `when`. */
function decideAt(previous: GlucoseAlertState | null, minutes: number, value: number, direction: string, delta: number, devices = [PHONE]) {
  const when = at(minutes);
  return decideGlucoseAlert(previous, reading(value, direction, delta, { observed_at: minutesAgo(1, when) }), devices, when);
}

function saved(decision: { next: Omit<GlucoseAlertState, 'patient_id' | 'revision'> | null }): GlucoseAlertState {
  return state({ ...decision.next! });
}

describe('decideGlucoseAlert', () => {
  it('pushes a new reading once and repeats only after the phone\'s interval', () => {
    const first = decideAt(null, 0, 65, 'FortyFiveDown', -4);
    expect(first).toMatchObject({ type: 'glucose', pushes: [{ kind: 'low' }] });
    // The same reading again: already judged.
    expect(decideGlucoseAlert(saved(first), reading(65, 'FortyFiveDown', -4, { observed_at: minutesAgo(1) }), [PHONE], NOW)).toEqual({ type: 'none', next: null });

    const quiet = decideAt(saved(first), 5, 63, 'Flat', -1);
    expect(quiet.type).toBe('none');
    expect(quiet.next?.last_reading_at).toBe(minutesAgo(1, at(5)));
    expect(decideAt(saved(quiet), 15, 62, 'Flat', 0)).toMatchObject({ type: 'glucose', pushes: [{ kind: 'low' }] });
  });

  it('repeats every reading on a phone set to 5 minutes, even when judged a few seconds early', () => {
    const fast = phone({ low_repeat_minutes: 5 });
    const first = decideAt(null, 0, 65, 'Flat', -2, [fast]);
    expect(first).toMatchObject({ type: 'glucose', pushes: [{ kind: 'low' }] });
    const early = new Date(at(5).getTime() - 20_000);
    expect(decideGlucoseAlert(saved(first), reading(64, 'Flat', -1, { observed_at: minutesAgo(1, early) }), [fast], early))
      .toMatchObject({ type: 'glucose', pushes: [{ kind: 'low' }] });
  });

  it('keeps the interval per phone', () => {
    const often = phone({ device_id: 'b', push_token: 'tb', low_repeat_minutes: 5 });
    const first = decideAt(null, 0, 65, 'Flat', -2, [PHONE, often]);
    expect(first.type === 'glucose' && first.pushes.map((push) => push.device.device_id)).toEqual(['a', 'b']);
    const second = decideAt(saved(first), 5, 64, 'Flat', -1, [PHONE, often]);
    expect(second.type === 'glucose' && second.pushes.map((push) => push.device.device_id)).toEqual(['b']);
  });

  it('gives a phone the strongest kind it has on', () => {
    const noFast = phone({ kinds_off: ['fast'] });
    expect(decideAt(null, 0, 190, 'DoubleUp', 20, [PHONE, noFast])).toMatchObject({
      type: 'glucose',
      pushes: [{ kind: 'fast_rise' }, { kind: 'high' }],
    });
    expect(decideAt(null, 0, 120, 'DoubleUp', 20, [noFast]).type).toBe('none');
  });

  it('counts every kind due on the reading as told, so the next reading does not push the weaker one', () => {
    const first = decideAt(null, 0, 190, 'DoubleUp', 20);
    expect(first).toMatchObject({ type: 'glucose', pushes: [{ kind: 'fast_rise' }] });
    expect(decideAt(saved(first), 5, 200, 'SingleUp', 10).type).toBe('none');
  });

  it('pushes an escalation at once but keeps a weaker kind quiet after a stronger one', () => {
    const high = decideAt(null, 0, 185, 'SingleUp', 11);
    const veryHigh = decideAt(saved(high), 10, 255, 'SingleUp', 12);
    expect(veryHigh).toMatchObject({ type: 'glucose', pushes: [{ kind: 'very_high' }] });
    // 180's own interval is over, but 250 was pushed 25 minutes ago.
    expect(decideAt(saved(veryHigh), 35, 240, 'FortyFiveUp', 6).type).toBe('none');
  });

  it('keeps "Glukoza spada" quiet right after a low (back in range says it instead)', () => {
    const low = decideAt(null, 0, 68, 'FortyFiveUp', 5);
    expect(decideAt(saved(low), 10, 74, 'FortyFiveDown', -5)).toMatchObject({ type: 'glucose', pushes: [{ kind: 'in_range' }] });
    const noInRange = phone({ kinds_off: ['in_range'] });
    const lowOnly = decideAt(null, 0, 68, 'FortyFiveUp', 5, [noInRange]);
    expect(decideAt(saved(lowOnly), 10, 74, 'FortyFiveDown', -5, [noInRange]).type).toBe('none');
  });

  it('forgets a phone that is no longer on', () => {
    const first = decideAt(null, 0, 65, 'Flat', 0);
    const without = decideAt(saved(first), 5, 64, 'Flat', 0, []);
    expect(without.next?.sent).toEqual({});
  });

  it('gives the reading due at 10 minutes half a minute to arrive', () => {
    const lastReading = reading(120, 'Flat', 0, { observed_at: minutesAgo(10) });
    const judged = state({ last_reading_at: lastReading.observed_at });
    expect(decideGlucoseAlert(judged, lastReading, [PHONE], NOW).type).toBe('none');
    expect(decideGlucoseAlert(judged, lastReading, [PHONE], new Date(NOW.getTime() + 29_000)).type).toBe('none');
    expect(decideGlucoseAlert(judged, lastReading, [PHONE], new Date(NOW.getTime() + 30_000))).toMatchObject({ type: 'no_data', minutes: 10 });

    // The due reading arrives inside that half minute: no warning, it is judged as usual.
    const arrived = reading(121, 'Flat', 1, { observed_at: NOW.toISOString() });
    expect(decideGlucoseAlert(judged, arrived, [PHONE], new Date(NOW.getTime() + 20_000)).type).not.toBe('no_data');
  });

  it('says full 5 minutes on any tick and tells each mark once', () => {
    const lastReading = reading(120, 'Flat', 0, { observed_at: minutesAgo(0) });
    const judged = state({ last_reading_at: lastReading.observed_at });
    const decide = (previous: GlucoseAlertState, minutes: number) => decideGlucoseAlert(previous, lastReading, [PHONE], at(minutes));

    // The tick is once a minute: the worst one for the first push still says 10, not 11.
    const first = decide(judged, 11.49);
    expect(first).toMatchObject({ type: 'no_data', minutes: 10 });
    expect(decide(saved(first), 12)).toEqual({ type: 'none', next: null });
    expect(decide(saved(first), 15.4)).toEqual({ type: 'none', next: null });
    // Under 5 minutes after that late first push, but the 15 is due: it goes, and says 15, not 16.
    const second = decide(saved(first), 16.4);
    expect(second).toMatchObject({ type: 'no_data', minutes: 15 });
    expect(decide(saved(second), 21)).toMatchObject({ type: 'no_data', minutes: 20 });
    // 20, 30, then every 15 minutes (role review 2026-11-15).
    const third = decide(saved(second), 21);
    expect(decide(saved(third), 26)).toEqual({ type: 'none', next: null });
    const thirty = decide(saved(third), 31);
    expect(thirty).toMatchObject({ type: 'no_data', minutes: 30 });
    expect(decide(saved(thirty), 41)).toEqual({ type: 'none', next: null });
    expect(decide(saved(thirty), 46)).toMatchObject({ type: 'no_data', minutes: 45 });
    expect(decide(judged, 65.5)).toMatchObject({ type: 'no_data', minutes: 60 });
  });

  it('does not repeat "Brak danych" half a minute after a first push that came late', () => {
    const lastReading = reading(120, 'Flat', 0, { observed_at: minutesAgo(0) });
    const first = decideGlucoseAlert(state({ last_reading_at: lastReading.observed_at }), lastReading, [PHONE], at(14.9));
    expect(first).toMatchObject({ type: 'no_data', minutes: 10 });
    expect(decideGlucoseAlert(saved(first), lastReading, [PHONE], at(15.6))).toEqual({ type: 'none', next: null });
    expect(decideGlucoseAlert(saved(first), lastReading, [PHONE], at(18.5))).toMatchObject({ type: 'no_data', minutes: 15 });
  });

  it('warns about no readings after 10 minutes, then every 5 minutes, and again for a new gap', () => {
    const lastReading = reading(120, 'Flat', 0, { observed_at: minutesAgo(9) });
    expect(decideGlucoseAlert(state({ last_reading_at: lastReading.observed_at }), lastReading, [PHONE], NOW).type).toBe('none');

    const gap = reading(120, 'Flat', 0, { observed_at: minutesAgo(10.5) });
    const first = decideGlucoseAlert(state({ last_reading_at: gap.observed_at }), gap, [PHONE], NOW);
    expect(first).toMatchObject({ type: 'no_data', minutes: 10 });

    expect(decideGlucoseAlert(saved(first), gap, [PHONE], at(4))).toEqual({ type: 'none', next: null });
    expect(decideGlucoseAlert(saved(first), gap, [PHONE], at(5))).toMatchObject({ type: 'no_data', minutes: 15 });

    // Readings came back, then stopped again: the old push is for the old gap.
    const newGap = reading(130, 'Flat', 0, { observed_at: minutesAgo(11, at(60)) });
    expect(decideGlucoseAlert(state({ ...first.next!, last_reading_at: newGap.observed_at }), newGap, [PHONE], at(60))).toMatchObject({ type: 'no_data', minutes: 10 });
  });

  it('says nothing without any reading in the last 24 h', () => {
    expect(decideGlucoseAlert(state(), null, [PHONE], NOW)).toEqual({ type: 'none', next: null });
  });
});

describe('push text', () => {
  it('has the icon, glucose and change as the title (no arrow), and rośnie / spada from the change in the body', () => {
    expect(glucosePushText('falling', reading(76, 'FortyFiveDown', -8)).title).toBe('⚠️ 76 (−8)');
    expect(glucosePushText('low', reading(65, 'FortyFiveDown', -4))).toEqual({ title: '❗ 65 (−4)', body: 'Glukoza poniżej 70 i spada.\nIOB 1,3 j · COB 15 g' });
    expect(glucosePushText('low', reading(66, 'FortyFiveUp', 6)).body).toBe('Glukoza poniżej 70 i rośnie.\nIOB 1,3 j · COB 15 g');
    // A flat arrow with a small change still says which way (2026-11-02: "Glukoza nisko" had no direction).
    expect(glucosePushText('low', reading(64, 'Flat', -2)).body).toBe('Glukoza poniżej 70 i spada.\nIOB 1,3 j · COB 15 g');
    expect(glucosePushText('low', reading(66, 'Flat', 0))).toEqual({ title: '❗ 66 (0)', body: 'Glukoza poniżej 70.\nIOB 1,3 j · COB 15 g' });
    expect(glucosePushText('falling', reading(76, 'SingleDown', -11))).toEqual({ title: '⚠️ 76 (−11)', body: 'Glukoza poniżej 80 i spada.\nIOB 1,3 j · COB 15 g' });
    expect(glucosePushText('rising', reading(165, 'FortyFiveUp', 7)).body).toBe('Glukoza powyżej 160 i rośnie.\nIOB 1,3 j · COB 15 g');
    expect(glucosePushText('high', reading(185, 'SingleUp', 11))).toEqual({ title: '⚠️ 185 (+11)', body: 'Glukoza powyżej 180 i rośnie.\nIOB 1,3 j · COB 15 g' });
    expect(glucosePushText('very_high', reading(255, 'SingleUp', 11)).body).toBe('Glukoza powyżej 250 i rośnie.\nIOB 1,3 j · COB 15 g');
  });

  it('keeps the arrow only for a fast change', () => {
    expect(glucosePushText('fast_fall', reading(140, 'DoubleDown', -19))).toEqual({ title: '⚠️ 140 ⇊ (−19)', body: 'Glukoza szybko spada.\nIOB 1,3 j · COB 15 g' });
    expect(glucosePushText('fast_rise', reading(140, 'DoubleUp', 19, { iob_units: null, cob_grams: null }))).toEqual({ title: '⚠️ 140 ⇈ (+19)', body: 'Glukoza szybko rośnie.' });
    // The level first outside 80–180, so "spada" at 220 does not read like a low (role review 2026-11-21).
    const first = (kind: 'fast_rise' | 'fast_fall', value: number, delta: number) => glucosePushText(kind, reading(value, delta > 0 ? 'DoubleUp' : 'DoubleDown', delta)).body.split('\n')[0];
    expect(first('fast_fall', 220, -19)).toBe('Glukoza powyżej 180 i szybko spada.');
    expect(first('fast_fall', 270, -19)).toBe('Glukoza powyżej 250 i szybko spada.');
    expect(first('fast_fall', 75, -19)).toBe('Glukoza poniżej 80 i szybko spada.');
    expect(first('fast_fall', 50, -19)).toBe('Glukoza poniżej 54 i szybko spada.');
    expect(first('fast_rise', 200, 18)).toBe('Glukoza powyżej 180 i szybko rośnie.');
    expect(first('fast_rise', 260, 18)).toBe('Glukoza powyżej 250 i szybko rośnie.');
    expect(first('fast_rise', 62, 12)).toBe('Glukoza poniżej 70 i szybko rośnie.');
    expect(first('fast_rise', 75, 18)).toBe('Glukoza szybko rośnie.');
  });

  it('says how long there were no readings', () => {
    expect(noDataPushText(10)).toEqual({ title: 'Brak odczytów z sensora', body: 'Ostatni odczyt 10 min temu. Sprawdź sensor i telefon, który odbiera odczyty.' });
    expect(noDataPushText(29).body).toBe('Ostatni odczyt 29 min temu. Sprawdź sensor i telefon, który odbiera odczyty.');
    expect(noDataPushText(30).body).toBe('Ostatni odczyt 30 min temu. Sprawdź sensor i telefon, który odbiera odczyty. Zmierz glukozę glukometrem.');
    expect(noDataPushText(60)).toEqual({ title: 'Brak odczytów z sensora', body: 'Ostatni odczyt 1 godz. temu. Sprawdź sensor i telefon, który odbiera odczyty. Zmierz glukozę glukometrem.' });
    expect(noDataPushText(65)).toEqual({ title: 'Brak odczytów z sensora', body: 'Ostatni odczyt 1 godz. 5 min temu. Sprawdź sensor i telefon, który odbiera odczyty. Zmierz glukozę glukometrem.' });
    expect(noDataPushText(20, true).body).toBe('Ostatni odczyt 20 min temu. Telefon z pętlą działa, więc sprawdź sensor.');
    expect(noDataPushText(45, true).body).toBe('Ostatni odczyt 45 min temu. Telefon z pętlą działa, więc sprawdź sensor. Zmierz glukozę glukometrem.');
  });
});

describe('GlucoseAlertService', () => {
  function dashboard(glucose: DashboardResponse['glucose']): DashboardResponse {
    return {
      patient_id: PATIENT, generated_at: NOW.toISOString(), glucose, readings: [], time_in_range: null, pump: null,
      loop: { iob_units: 0.5, cob_grams: 0, observed_at: NOW.toISOString() }, insulin: null, site_changed_at: null, sensor_started_at: null,
    };
  }

  function setup(devices: GlucoseAlertDevice[], saveOk = true) {
    let saved: GlucoseAlertState | null = null;
    const store: GlucoseAlertStore = {
      listPatientsWithGlucoseAlertDevices: vi.fn(async () => [PATIENT]),
      listGlucoseAlertDevices: vi.fn(async () => devices),
      getState: vi.fn(async () => saved),
      saveState: vi.fn(async (_patientId, _revision, next) => {
        if (!saveOk) return false;
        saved = { patient_id: PATIENT, revision: (saved?.revision ?? -1) + 1, ...next };
        return true;
      }),
      deactivatePushToken: vi.fn(async () => undefined),
    };
    const push = { sendGlucoseAlert: vi.fn(async () => undefined) };
    return { store, push, log: vi.fn() };
  }

  it('sends each phone its own kind, never time-sensitive, and once per reading', async () => {
    const { store, push, log } = setup([
      phone(),
      phone({ device_id: 'b', push_token: 'tb', kinds_off: ['low'] }),
      phone({ device_id: 'c', push_token: 'tc', kinds_off: ['low', 'fast'] }),
    ]);
    const service = new GlucoseAlertService({
      store, push, log,
      dashboard: async () => dashboard({ value: 62, unit: 'mg/dL', direction: 'DoubleDown', observed_at: minutesAgo(1), delta: -19 }),
    });
    await service.run(NOW);
    expect(push.sendGlucoseAlert).toHaveBeenCalledTimes(2);
    expect(push.sendGlucoseAlert).toHaveBeenNthCalledWith(1, expect.objectContaining({ pushToken: 'ta', kind: 'low', title: '❗ 62 (−19)', body: 'Glukoza poniżej 70 i spada.\nIOB 0,5 j · COB 0 g' }));
    expect(push.sendGlucoseAlert).toHaveBeenNthCalledWith(2, expect.objectContaining({ pushToken: 'tb', kind: 'fast_fall', title: '⚠️ 62 ⇊ (−19)', body: 'Glukoza poniżej 70 i szybko spada.\nIOB 0,5 j · COB 0 g' }));
    await service.run(NOW);
    expect(push.sendGlucoseAlert).toHaveBeenCalledTimes(2);
  });

  it('tells the push about below 54 for 20 minutes, for the quiet hours (quiet-hours.v1)', async () => {
    const { store, push, log } = setup([phone()]);
    const readings = [60, 52, 50, 49, 48, 47].map((value, i) => ({ at: minutesAgo(1 + (5 - i) * 5), value }));
    const service = new GlucoseAlertService({
      store, push, log,
      dashboard: async () => ({ ...dashboard({ value: 47, unit: 'mg/dL', direction: 'Flat', observed_at: minutesAgo(1), delta: -1 }), readings } as DashboardResponse),
    });
    await service.run(NOW);
    expect(push.sendGlucoseAlert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'very_low', quiet: { urgentLowSustained: true } }));
  });

  it('pushes nothing when another worker claimed the reading', async () => {
    const { store, push, log } = setup([phone()], false);
    const service = new GlucoseAlertService({
      store, push, log,
      dashboard: async () => dashboard({ value: 62, unit: 'mg/dL', direction: 'Flat', observed_at: minutesAgo(1), delta: 0 }),
    });
    await service.run(NOW);
    expect(push.sendGlucoseAlert).not.toHaveBeenCalled();
  });

  describe('a phone that also gets the rescue carb alert (role review 2026-11-09)', () => {
    const low = () => dashboard({ value: 62, unit: 'mg/dL', direction: 'Flat', observed_at: minutesAgo(0.5), delta: -4 });

    it('waits until the reading is a minute old, then leaves the low to the rescue alert that reached the phone', async () => {
      const { store, push, log } = setup([phone({ rescue_on: true }), phone({ device_id: 'b', push_token: 'tb' })]);
      store.rescuePushedSince = vi.fn(async () => true);
      let reading = low();
      const service = new GlucoseAlertService({ store, push, log, dashboard: async () => reading });
      await service.run(NOW);
      expect(push.sendGlucoseAlert).not.toHaveBeenCalled();
      expect(store.saveState).not.toHaveBeenCalled();
      reading = dashboard({ value: 62, unit: 'mg/dL', direction: 'Flat', observed_at: minutesAgo(1.5), delta: -4 });
      await service.run(NOW);
      expect(push.sendGlucoseAlert).toHaveBeenCalledTimes(1);
      expect(push.sendGlucoseAlert).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'tb', kind: 'low' }));
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'glucose_alert_left_to_rescue' }));
    });

    it('sends the low when no rescue alert reached a phone (carbs just given, alert declined)', async () => {
      const { store, push, log } = setup([phone({ rescue_on: true })]);
      store.rescuePushedSince = vi.fn(async () => false);
      const service = new GlucoseAlertService({ store, push, log, dashboard: async () => dashboard({ value: 62, unit: 'mg/dL', direction: 'Flat', observed_at: minutesAgo(1.5), delta: -4 }) });
      await service.run(NOW);
      expect(push.sendGlucoseAlert).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'ta', kind: 'low' }));
    });

    it('sends the low when the rescue read fails', async () => {
      const { store, push, log } = setup([phone({ rescue_on: true })]);
      store.rescuePushedSince = vi.fn(async () => { throw new Error('db down'); });
      const service = new GlucoseAlertService({ store, push, log, dashboard: async () => dashboard({ value: 62, unit: 'mg/dL', direction: 'Flat', observed_at: minutesAgo(1.5), delta: -4 }) });
      await service.run(NOW);
      expect(push.sendGlucoseAlert).toHaveBeenCalledTimes(1);
    });

    it('sends at once when the rescue alert has judged the reading already (signal after the sync, 2026-11-14)', async () => {
      const { store, push, log } = setup([phone({ rescue_on: true })]);
      store.rescuePushedSince = vi.fn(async () => false);
      const service = new GlucoseAlertService({ store, push, log, dashboard: async () => low() });
      // Judged before this reading was observed: still waits.
      await service.run(NOW, { rescueJudgedAt: new Date(NOW.getTime() - 60_000) });
      expect(push.sendGlucoseAlert).not.toHaveBeenCalled();
      await service.run(NOW, { rescueJudgedAt: new Date(NOW.getTime() - 5_000) });
      expect(push.sendGlucoseAlert).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'ta', kind: 'low' }));
    });

    it('still leaves the low to a rescue alert that reached the phone when judged at once', async () => {
      const { store, push, log } = setup([phone({ rescue_on: true })]);
      store.rescuePushedSince = vi.fn(async () => true);
      const service = new GlucoseAlertService({ store, push, log, dashboard: async () => low() });
      await service.run(NOW, { rescueJudgedAt: NOW });
      expect(push.sendGlucoseAlert).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'glucose_alert_left_to_rescue' }));
    });

    it('leaves "poniżej 80" only to the rescue alert of the same reading (owner 2026-11-15)', async () => {
      const readAt = Date.parse(minutesAgo(1.5));
      for (const [rescueAt, expected] of [[readAt - 4 * 60_000, 1], [readAt + 12_000, 0]] as const) {
        const { store, push, log } = setup([phone({ rescue_on: true })]);
        store.rescuePushedSince = vi.fn(async (_patientId: string, sinceIso: string) => rescueAt >= Date.parse(sinceIso));
        const service = new GlucoseAlertService({ store, push, log, dashboard: async () => dashboard({ value: 74, unit: 'mg/dL', direction: 'FortyFiveDown', observed_at: minutesAgo(1.5), delta: -11 }) });
        await service.run(NOW);
        expect(push.sendGlucoseAlert).toHaveBeenCalledTimes(expected);
        if (expected) expect(push.sendGlucoseAlert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'falling', body: 'Glukoza poniżej 80 i spada.\nIOB 0,5 j · COB 0 g' }));
      }
    });

    it('does not hold a phone without rescue alerts', async () => {
      const { store, push, log } = setup([phone()]);
      store.rescuePushedSince = vi.fn(async () => true);
      const service = new GlucoseAlertService({ store, push, log, dashboard: async () => low() });
      await service.run(NOW);
      expect(push.sendGlucoseAlert).toHaveBeenCalledTimes(1);
      expect(store.rescuePushedSince).not.toHaveBeenCalled();
    });
  });

  it('sends "Brak danych" to phones with it on and drops a dead token', async () => {
    const { store, push, log } = setup([
      phone(),
      phone({ device_id: 'b', push_token: 'tb', kinds_off: ['no_data'] }),
    ]);
    push.sendGlucoseAlert.mockRejectedValueOnce(new PushNotificationProviderError('DEVICE_TOKEN_UNREGISTERED', 'gone', false));
    const service = new GlucoseAlertService({
      store, push, log,
      dashboard: async () => dashboard({ value: 120, unit: 'mg/dL', direction: 'Flat', observed_at: minutesAgo(20.5), delta: 0 }),
    });
    await service.run(NOW);
    expect(push.sendGlucoseAlert).toHaveBeenCalledTimes(1);
    expect(push.sendGlucoseAlert).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'ta', kind: 'no_data', title: 'Brak odczytów z sensora', body: 'Ostatni odczyt 20 min temu. Telefon z pętlą działa, więc sprawdź sensor.' }));
    expect(store.deactivatePushToken).toHaveBeenCalledWith('ta');
  });

  it('asks about the phone too when the loop stopped uploading', async () => {
    const { store, push, log } = setup([phone()]);
    const service = new GlucoseAlertService({
      store, push, log,
      dashboard: async () => ({ ...dashboard({ value: 120, unit: 'mg/dL', direction: 'Flat', observed_at: minutesAgo(20.5), delta: 0 }), loop: { iob_units: 0.5, cob_grams: 0, observed_at: minutesAgo(20.5) } }),
    });
    await service.run(NOW);
    expect(push.sendGlucoseAlert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'no_data', body: 'Ostatni odczyt 20 min temu. Sprawdź sensor i telefon, który odbiera odczyty.' }));
  });

  it('judges a reading that came late instead of saying "Brak danych", and says how old it is (audit 2026-11-02)', async () => {
    const { store, push, log } = setup([phone()]);
    const service = new GlucoseAlertService({
      store, push, log,
      dashboard: async () => dashboard({ value: 62, unit: 'mg/dL', direction: 'Flat', observed_at: minutesAgo(12), delta: -3 }),
    });
    await service.run(NOW);
    expect(push.sendGlucoseAlert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'low', body: 'Glukoza poniżej 70 i spada.\nIOB 0,5 j · COB 0 g\nPomiar sprzed 12 min.' }));
  });

  it('tries a failed send again on the next minute, only for the phone it did not reach (audit 2026-11-02)', async () => {
    const { store, push, log } = setup([phone(), phone({ device_id: 'b', push_token: 'tb' })]);
    push.sendGlucoseAlert.mockRejectedValueOnce(new PushNotificationProviderError('APNS_RETRYABLE', 'busy', true));
    const service = new GlucoseAlertService({
      store, push, log,
      dashboard: async () => dashboard({ value: 62, unit: 'mg/dL', direction: 'Flat', observed_at: minutesAgo(1), delta: -2 }),
    });
    await service.run(NOW);
    expect(push.sendGlucoseAlert.mock.calls.map(([input]) => input.pushToken)).toEqual(['ta', 'tb']);
    await service.run(new Date(NOW.getTime() + 60_000));
    expect(push.sendGlucoseAlert.mock.calls.map(([input]) => input.pushToken)).toEqual(['ta', 'tb', 'ta']);
    await service.run(new Date(NOW.getTime() + 120_000));
    expect(push.sendGlucoseAlert).toHaveBeenCalledTimes(3);
    expect(store.deactivatePushToken).not.toHaveBeenCalled();
  });

  it('keeps a phone on after a 400 (it may be this server\'s setup), stops it only on 410', async () => {
    const { store, push, log } = setup([phone()]);
    push.sendGlucoseAlert.mockRejectedValueOnce(new PushNotificationProviderError('DEVICE_TOKEN_INVALID', 'not for topic', false));
    const service = new GlucoseAlertService({
      store, push, log,
      dashboard: async () => dashboard({ value: 62, unit: 'mg/dL', direction: 'Flat', observed_at: minutesAgo(1), delta: 0 }),
    });
    await service.run(NOW);
    expect(store.deactivatePushToken).not.toHaveBeenCalled();
  });
});

describe('back in range (glucose-alerts.v1)', () => {
  const phone = (partial: Partial<GlucoseAlertDevice> = {}): GlucoseAlertDevice => ({ device_id: 'a', push_token: 'ta', kinds_off: [], low_repeat_minutes: 15, repeat_minutes: 30, ...partial });
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
  const decideAt = (previous: GlucoseAlertState | null, minutes: number, value: number, direction: string, delta: number, devices = [phone()]) => {
    const when = at(minutes);
    return decideGlucoseAlert(previous, reading(value, direction, delta, { observed_at: minutesAgo(1, when) }), devices, when);
  };
  const saved = (decision: { next: Omit<GlucoseAlertState, 'patient_id' | 'revision'> | null }) => state({ ...decision.next! });

  it('says "Glukoza w zakresie" once after a low the phone was told about', () => {
    const low = decideAt(null, 0, 65, 'FortyFiveDown', -4);
    const still = decideAt(saved(low), 5, 68, 'FortyFiveUp', 3);
    expect(still.type).toBe('none');
    const back = decideAt(saved(still), 10, 74, 'FortyFiveUp', 6);
    expect(back).toMatchObject({ type: 'glucose', pushes: [{ kind: 'in_range' }] });
    expect(decideAt(saved(back), 15, 82, 'FortyFiveUp', 8).type).toBe('none');
  });

  it('says it after a high, and not after a rise over 160 that never went over 180', () => {
    const high = decideAt(null, 0, 190, 'SingleUp', 11);
    expect(decideAt(saved(high), 5, 176, 'FortyFiveDown', -6)).toMatchObject({ type: 'glucose', pushes: [{ kind: 'in_range' }] });
    const rising = decideAt(null, 0, 170, 'FortyFiveUp', 6);
    expect(decideAt(saved(rising), 5, 150, 'FortyFiveDown', -6).type).toBe('none');
  });

  it('waits behind a fast change and respects the switch', () => {
    const high = decideAt(null, 0, 185, 'SingleUp', 11);
    const fast = decideAt(saved(high), 5, 175, 'DoubleDown', -20);
    expect(fast).toMatchObject({ type: 'glucose', pushes: [{ kind: 'fast_fall' }] });
    expect(decideAt(saved(fast), 10, 168, 'FortyFiveDown', -7)).toMatchObject({ type: 'glucose', pushes: [{ kind: 'in_range' }] });
    const off = phone({ kinds_off: ['in_range'] });
    const lowOff = decideAt(null, 0, 65, 'Flat', 0, [off]);
    expect(decideAt(saved(lowOff), 5, 75, 'FortyFiveUp', 6, [off]).type).toBe('none');
  });

  it('has the green check and the meaning as the title, the reading in the body', () => {
    expect(glucosePushText('in_range', reading(120, 'FortyFiveUp', 3))).toEqual({ title: '✅ 120 (+3)', body: 'Glukoza wróciła do zakresu.\nIOB 1,3 j · COB 15 g' });
  });

describe('crossings of 160 and 180 (owner 2026-11-02)', () => {
  it('pushes each crossing once, whatever the trend and the repeat window', () => {
    expect(crossedGlucoseKinds({ value: 163, delta: 4 })).toEqual(['rising']);
    expect(crossedGlucoseKinds({ value: 183, delta: 6 })).toEqual(['high']);
    expect(crossedGlucoseKinds({ value: 185, delta: 30 })).toEqual(['high', 'rising']);
    expect(crossedGlucoseKinds({ value: 170, delta: 2 })).toEqual([]);
    expect(crossedGlucoseKinds({ value: 170, delta: null })).toEqual([]);

    // 163 with +4: under the +5 rule, but it crossed 160.
    const first = decideAt(null, 0, 163, 'Flat', 4, [PHONE]);
    expect(first).toMatchObject({ type: 'glucose', pushes: [{ kind: 'rising' }] });
    // Staying above 160 slowly: nothing more.
    expect(decideAt(saved(first), 5, 166, 'Flat', 3, [PHONE]).type).toBe('none');
    // Over 180 within the repeat window: the crossing still comes.
    expect(decideAt(saved(first), 10, 182, 'Flat', 4, [PHONE])).toMatchObject({ type: 'glucose', pushes: [{ kind: 'high' }] });
    // A phone with "Glukoza wysoko" off gets no crossing of 180.
    expect(decideAt(saved(first), 10, 182, 'Flat', 4, [phone({ kinds_off: ['high'] })]).type).toBe('none');
  });
});
});

describe('under 80 (owner 2026-11-15)', () => {
  it('pushes going under 80 once, then only a fall of 5 or more', () => {
    expect(crossedGlucoseKinds({ value: 79, delta: -2 })).toEqual(['falling']);
    expect(crossedGlucoseKinds({ value: 74, delta: -11 })).toEqual(['falling']);
    expect(crossedGlucoseKinds({ value: 66, delta: -15 })).toEqual([]);
    expect(crossedGlucoseKinds({ value: 78, delta: -1 })).toEqual([]);

    // 15 Nov 19:37–20:32: 85, then 74 ↘, then an hour of 71–77 on "→".
    const crossed = decideAt(null, 0, 74, 'FortyFiveDown', -11);
    expect(crossed).toMatchObject({ type: 'glucose', pushes: [{ kind: 'falling' }] });
    let last = crossed;
    for (const [minutes, value, delta] of [[5, 73, -1], [10, 72, -1], [15, 74, 2], [20, 72, -2], [25, 73, 1], [30, 75, 2], [35, 74, -1], [40, 71, -3], [45, 76, 5]] as const) {
      last = decideAt(saved(last), minutes, value, 'Flat', delta);
      expect(last.type).toBe('none');
    }
    // A fall of 5 later on: pushed again.
    expect(decideAt(saved(last), 50, 71, 'Flat', -5)).toMatchObject({ type: 'glucose', pushes: [{ kind: 'falling' }] });
    // Every reading that falls by 5 or more, whatever the phone's low interval.
    expect(decideAt(saved(crossed), 5, 70, 'Flat', -5)).toMatchObject({ type: 'glucose', pushes: [{ kind: 'falling' }] });
    const fivePhone = phone({ repeat_minutes: 5, low_repeat_minutes: 5 });
    const firstFive = decideAt(null, 0, 79, 'Flat', -3, [fivePhone]);
    expect(firstFive).toMatchObject({ type: 'glucose', pushes: [{ kind: 'falling' }] });
    expect(decideAt(saved(firstFive), 5, 74, 'Flat', -5, [fivePhone])).toMatchObject({ type: 'glucose', pushes: [{ kind: 'falling' }] });
    expect(decideAt(saved(firstFive), 5, 77, 'Flat', -2, [fivePhone]).type).toBe('none');
  });
});

describe('a run above 180 (owner 2026-11-15)', () => {
  /** Readings every 5 minutes, each judged with the history up to it; returns the kind pushed per reading. */
  function replay(values: number[], device = PHONE, start: GlucoseAlertState | null = null) {
    let current = start;
    const history: Array<{ at: string; value: number }> = [];
    return values.map((value, i) => {
      const when = at(i * 5);
      const observedAt = minutesAgo(1, when);
      const delta = i > 0 ? value - values[i - 1]! : null;
      history.push({ at: observedAt, value });
      const decision = decideGlucoseAlert(current, { ...reading(value, 'Flat', delta ?? 0, { observed_at: observedAt }), delta, history: [...history] }, [device], when);
      if (decision.next) current = state({ ...decision.next });
      return decision.type === 'glucose' ? { kind: decision.pushes[0]!.kind, text: glucosePushText(decision.pushes[0]!.kind, { ...reading(value, 'Flat', delta ?? 0), delta, iob_units: null, cob_grams: null }, decision.pushes[0]!.detail).body } : null;
    });
  }

  it('says the crossings, "i rośnie" every 15 minutes, the top and back in range (15 Nov 16:00)', () => {
    const values = [150, 162, 179, 186, 194, 211, 221, 232, 244, 248, 246, 240, 236, 230, 220, 205, 190, 179];
    const pushes = replay(values).map((push, i) => push && `${values[i]} ${push.kind}: ${push.text}`).filter(Boolean);
    expect(pushes).toEqual([
      '162 rising: Glukoza powyżej 160 i rośnie.',
      '186 high: Glukoza powyżej 180 i rośnie.',
      '221 still_rising: Glukoza powyżej 180 i rośnie.',
      '248 still_rising: Glukoza powyżej 180 i rośnie.',
      '220 peak: Glukoza powyżej 180, ale spada. Najwyżej było 248.',
      '179 in_range: Glukoza wróciła do zakresu.',
    ]);
  });

  it('says once that glucose has stayed above 180 for an hour, then hourly', () => {
    const values = [170, 185, 188, ...Array.from({ length: 26 }, (_, i) => 190 + (i % 3))];
    const pushes = replay(values).map((push, i) => push && `${i * 5} ${push.kind}: ${push.text}`).filter(Boolean);
    expect(pushes).toEqual([
      '5 high: Glukoza powyżej 180 i rośnie.',
      '65 stuck: Glukoza od godziny powyżej 180 i nie spada.',
      '125 stuck: Glukoza od 2 godz. powyżej 180 i nie spada. Sprawdź wkłucie.',
    ]);
  });

  it('crosses 250 at once, says the top that fell by a tenth, and stays quiet on the switch', () => {
    const values = [175, 190, 205, 220, 240, 252, 258, 260, 255, 248, 245, 262, 275, 280, 270, 262, 258, 250, 245];
    const kinds = replay(values).map((push) => push?.kind ?? null);
    // 252 → 245 → 262 is one crossing of 250 (not 10 below it in between).
    // 260 → 245 is not a tenth of the top: no push about it; 280 → 250 → 245 is.
    expect(kinds.filter(Boolean)).toEqual(['high', 'still_rising', 'very_high', 'still_rising', 'stuck', 'peak']);
    expect(replay(values, phone({ kinds_off: ['high'] })).map((push) => push?.kind ?? null).filter(Boolean)).toEqual(['very_high']);
  });

  it('says the top only after two falling readings and a fall of a tenth of it (owner 2026-11-21)', () => {
    const peakAt = (values: number[]) => replay(values).map((push, i) => (push?.kind === 'peak' ? values[i] : null)).filter((v) => v !== null);
    // 200 → 182 is under a tenth (20): sensor noise, nothing until back in range.
    expect(peakAt([170, 185, 195, 200, 198, 196, 194, 192, 190, 188, 186, 184, 182, 179])).toEqual([]);
    // 240 → 212 is enough, but 214 → 216 → 212 did not fall twice; 216 → 212 → 208 did.
    expect(peakAt([170, 190, 205, 220, 240, 230, 214, 216, 212, 208])).toEqual([208]);
  });

  it('pushes a crossing again only after glucose was 10 back on the other side', () => {
    expect(replay([150, 162, 158, 163, 149, 165]).map((push) => push?.kind ?? null)).toEqual([null, 'rising', null, null, null, 'rising']);
    expect(replay([85, 79, 82, 78, 92, 79]).map((push) => push?.kind ?? null)).toEqual([null, 'falling', null, null, null, 'falling']);
  });

  it('keeps the run through a dip to 171–180 (186 → 179 → 185 → 200 → 240)', () => {
    const kinds = replay([170, 186, 179, 185, 200, 215, 240]).map((push) => push?.kind ?? null);
    expect(kinds).toEqual([null, 'high', 'in_range', null, 'still_rising', null, null]);
  });

  it('follows nothing for a phone not told about the run (no history, or turned on above 180)', () => {
    expect(highRunOf([{ at: minutesAgo(10), value: 170 }, { at: minutesAgo(5), value: 190 }])?.top).toBe(190);
    expect(highRunOf([{ at: minutesAgo(5), value: 175 }])).toBeNull();
    expect(replay([200, 205, 215, 230, 245]).filter(Boolean)).toEqual([]);
  });
});

describe('after "Glukoza w zakresie" (role review 2026-11-15)', () => {
  it('pushes a new low at once after back in range, whatever the low interval', () => {
    const hourly = phone({ low_repeat_minutes: 60 });
    const low = decideAt(null, 0, 65, 'Flat', -3, [hourly]);
    const back = decideAt(saved(low), 5, 72, 'Flat', 7, [hourly]);
    expect(back).toMatchObject({ type: 'glucose', pushes: [{ kind: 'in_range' }] });
    expect(decideAt(saved(back), 10, 66, 'Flat', -6, [hourly])).toMatchObject({ type: 'glucose', pushes: [{ kind: 'low' }] });
    // Without back in range in between the interval holds.
    expect(decideAt(saved(low), 5, 64, 'Flat', -1, [hourly]).type).toBe('none');
  });
});

describe('role review round 2 (owner 2026-11-15)', () => {
  it('pushes under 54 at once and every 5 minutes, whatever the low interval', () => {
    const hourly = phone({ low_repeat_minutes: 60 });
    const low = decideAt(null, 0, 62, 'Flat', -4, [hourly]);
    expect(low).toMatchObject({ type: 'glucose', pushes: [{ kind: 'low' }] });
    const veryLow = decideAt(saved(low), 5, 52, 'Flat', -10, [hourly]);
    expect(veryLow).toMatchObject({ type: 'glucose', pushes: [{ kind: 'very_low' }] });
    expect(glucosePushText('very_low', reading(52, 'Flat', -10))).toEqual({ title: '❗ 52 (−10)', body: 'Glukoza poniżej 54 i spada.\nIOB 1,3 j · COB 15 g' });
    expect(decideAt(saved(veryLow), 10, 50, 'Flat', -2, [hourly])).toMatchObject({ type: 'glucose', pushes: [{ kind: 'very_low' }] });
    // Back over 54 but under 70: the low's hour holds.
    expect(decideAt(saved(veryLow), 10, 58, 'Flat', 6, [hourly]).type).toBe('none');
    // The switch "Glukoza nisko" covers it.
    expect(decideAt(null, 0, 50, 'Flat', -3, [phone({ kinds_off: ['low'] })]).type).toBe('none');
  });

  it('has no icon on the top, and asks to check the site after 2 h (ketones over 250)', () => {
    expect(glucosePushText('peak', reading(236, 'Flat', -4), { top: 248 }).title).toBe('236 (−4)');
    expect(glucosePushText('peak', reading(183, 'FortyFiveDown', -7), { top: 195 }).body).toBe('Glukoza powyżej 180, ale spada. Najwyżej było 195.\nIOB 1,3 j · COB 15 g');
    expect(glucosePushText('peak', reading(262, 'FortyFiveDown', -8), { top: 280 }).body.split('\n')[0]).toBe('Glukoza powyżej 250, ale spada. Najwyżej było 280.');
    expect(glucosePushText('stuck', reading(205, 'Flat', 1), { minutes: 60 }).body).toBe('Glukoza od godziny powyżej 180 i nie spada.\nIOB 1,3 j · COB 15 g');
    expect(glucosePushText('stuck', reading(205, 'Flat', 1), { minutes: 120 }).body).toBe('Glukoza od 2 godz. powyżej 180 i nie spada. Sprawdź wkłucie.\nIOB 1,3 j · COB 15 g');
    expect(glucosePushText('stuck', reading(265, 'Flat', 1), { minutes: 180 }).body).toBe('Glukoza od 3 godz. powyżej 180 i nie spada. Sprawdź wkłucie i ketony.\nIOB 1,3 j · COB 15 g');
  });

  it('says once that a new sensor is warming up, then nothing until 2 h after its start', () => {
    const lastReading = reading(120, 'Flat', 0, { observed_at: minutesAgo(0), sensor_started_at: at(3).toISOString() });
    const judged = state({ last_reading_at: lastReading.observed_at });
    const decide = (previous: GlucoseAlertState, minutes: number) => decideGlucoseAlert(previous, lastReading, [PHONE], at(minutes));
    const warmup = decide(judged, 11);
    expect(warmup).toMatchObject({ type: 'no_data', warmup: true });
    expect(sensorWarmupPushText()).toEqual({ title: 'Nowy sensor się rozgrzewa', body: 'Powiadomienia o glikemii wrócą z pierwszym odczytem.' });
    for (const minutes of [16, 31, 61, 121]) expect(decide(saved(warmup), minutes).type).toBe('none');
    // Two hours after the start without a reading: the gap is told again.
    expect(decide(saved(warmup), 124)).toMatchObject({ type: 'no_data', minutes: 120 });
    // A sensor started before the last reading is not a warm-up.
    const old = reading(120, 'Flat', 0, { observed_at: minutesAgo(0), sensor_started_at: at(-30).toISOString() });
    expect(decideGlucoseAlert(judged, old, [PHONE], at(11))).toMatchObject({ type: 'no_data', minutes: 10 });
    expect(decideGlucoseAlert(judged, old, [PHONE], at(11))).not.toHaveProperty('warmup');
  });
});

