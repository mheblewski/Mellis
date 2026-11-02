import { describe, expect, it, vi } from 'vitest';
import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import {
  activeGlucoseKinds,
  decideGlucoseAlert,
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
    expect(activeGlucoseKinds({ value: 70, direction: 'SingleDown', delta: -12 })).toEqual(['falling']);
    expect(activeGlucoseKinds({ value: 80, direction: 'SingleDown', delta: -12 })).toEqual([]);
    expect(activeGlucoseKinds({ value: 160, direction: 'SingleUp', delta: 12 })).toEqual([]);
    expect(activeGlucoseKinds({ value: 161, direction: 'FortyFiveUp', delta: 6 })).toEqual(['rising']);
    expect(activeGlucoseKinds({ value: 181, direction: 'SingleUp', delta: 12 })).toEqual(['high']);
    expect(activeGlucoseKinds({ value: 251, direction: 'SingleUp', delta: 12 })).toEqual(['very_high']);
    expect(activeGlucoseKinds({ value: 260, direction: 'Flat', delta: 1 })).toEqual([]);
    expect(activeGlucoseKinds({ value: 190, direction: 'DoubleUp', delta: 20 })).toEqual(['fast_rise', 'high']);
    expect(activeGlucoseKinds({ value: 120, direction: 'DoubleUp', delta: 20 })).toEqual(['fast_rise']);
  });

  it('takes the arrow from the 5-minute change without a direction', () => {
    expect(activeGlucoseKinds({ value: 120, direction: null, delta: -18 })).toEqual(['fast_fall']);
    expect(activeGlucoseKinds({ value: 170, direction: null, delta: 6 })).toEqual(['rising']);
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
    const fast = phone({ low_repeat_minutes: 5, repeat_minutes: 5 });
    const first = decideAt(null, 0, 185, 'SingleUp', 11, [fast]);
    expect(first).toMatchObject({ type: 'glucose', pushes: [{ kind: 'high' }] });
    const early = new Date(at(5).getTime() - 20_000);
    expect(decideGlucoseAlert(saved(first), reading(190, 'SingleUp', 10, { observed_at: minutesAgo(1, early) }), [fast], early))
      .toMatchObject({ type: 'glucose', pushes: [{ kind: 'high' }] });
  });

  it('keeps the interval per phone', () => {
    const often = phone({ device_id: 'b', push_token: 'tb', repeat_minutes: 5 });
    const first = decideAt(null, 0, 185, 'SingleUp', 11, [PHONE, often]);
    expect(first.type === 'glucose' && first.pushes.map((push) => push.device.device_id)).toEqual(['a', 'b']);
    const second = decideAt(saved(first), 5, 190, 'SingleUp', 10, [PHONE, often]);
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

  it('keeps "Glukoza spada" quiet right after a low', () => {
    const low = decideAt(null, 0, 68, 'FortyFiveUp', 5);
    expect(decideAt(saved(low), 10, 74, 'FortyFiveDown', -5).type).toBe('none');
  });

  it('forgets a phone that is no longer on', () => {
    const first = decideAt(null, 0, 65, 'Flat', 0);
    const without = decideAt(saved(first), 5, 64, 'Flat', 0, []);
    expect(without.next?.sent).toEqual({});
  });

  it('warns about no readings after 10 minutes, then every 5 minutes, and again for a new gap', () => {
    const lastReading = reading(120, 'Flat', 0, { observed_at: minutesAgo(9) });
    expect(decideGlucoseAlert(state({ last_reading_at: lastReading.observed_at }), lastReading, [PHONE], NOW).type).toBe('none');

    const gap = reading(120, 'Flat', 0, { observed_at: minutesAgo(10) });
    const first = decideGlucoseAlert(state({ last_reading_at: gap.observed_at }), gap, [PHONE], NOW);
    expect(first).toMatchObject({ type: 'no_data', minutes: 10 });

    expect(decideGlucoseAlert(saved(first), gap, [PHONE], at(4))).toEqual({ type: 'none', next: null });
    expect(decideGlucoseAlert(saved(first), gap, [PHONE], at(5))).toMatchObject({ type: 'no_data', minutes: 15 });

    // Readings came back, then stopped again: the old push is for the old gap.
    const newGap = reading(130, 'Flat', 0, { observed_at: minutesAgo(11, at(60)) });
    expect(decideGlucoseAlert(state({ ...first.next!, last_reading_at: newGap.observed_at }), newGap, [PHONE], at(60))).toMatchObject({ type: 'no_data', minutes: 11 });
  });

  it('says nothing without any reading in the last 24 h', () => {
    expect(decideGlucoseAlert(state(), null, [PHONE], NOW)).toEqual({ type: 'none', next: null });
  });
});

describe('push text', () => {
  it('has the icon, glucose, arrow and change as the title and IOB/COB under the meaning', () => {
    expect(glucosePushText('low', reading(65, 'FortyFiveDown', -4))).toEqual({ title: '❗ 65 ↘ −4', body: 'Glukoza nisko, spada\nIOB 1,3 j · COB 15 g' });
    expect(glucosePushText('low', reading(66, 'FortyFiveUp', 6)).body).toBe('Glukoza nisko, rośnie\nIOB 1,3 j · COB 15 g');
    expect(glucosePushText('low', reading(66, 'Flat', 0)).title).toBe('❗ 66 → ±0');
    expect(glucosePushText('low', reading(66, 'Flat', 0)).body).toBe('Glukoza nisko\nIOB 1,3 j · COB 15 g');
    expect(glucosePushText('falling', reading(76, 'SingleDown', -11))).toEqual({ title: '⚠️ 76 ↓ −11', body: 'Glukoza spada\nIOB 1,3 j · COB 15 g' });
    expect(glucosePushText('rising', reading(165, 'FortyFiveUp', 7)).body).toBe('Glukoza rośnie\nIOB 1,3 j · COB 15 g');
    expect(glucosePushText('high', reading(185, 'SingleUp', 11))).toEqual({ title: '⚠️ 185 ↑ +11', body: 'Glukoza wysoko, rośnie\nIOB 1,3 j · COB 15 g' });
    expect(glucosePushText('very_high', reading(255, 'SingleUp', 11)).body).toBe('Glukoza bardzo wysoko, rośnie\nIOB 1,3 j · COB 15 g');
  });

  it('puts the fast change in the title and the glucose in the body', () => {
    expect(glucosePushText('fast_fall', reading(140, 'DoubleDown', -19))).toEqual({ title: 'Glukoza szybko spada', body: '140 ⇊ −19\nIOB 1,3 j · COB 15 g' });
    expect(glucosePushText('fast_rise', reading(140, 'DoubleUp', 19, { iob_units: null, cob_grams: null }))).toEqual({ title: 'Glukoza szybko rośnie', body: '140 ⇈ +19' });
  });

  it('says how long there were no readings', () => {
    expect(noDataPushText(10)).toEqual({ title: 'Brak danych', body: 'Brak pomiarów od 10 min.' });
    expect(noDataPushText(60)).toEqual({ title: 'Brak danych', body: 'Brak pomiarów od 1 godz.' });
    expect(noDataPushText(65)).toEqual({ title: 'Brak danych', body: 'Brak pomiarów od 1 godz. 5 min.' });
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

  it('sends each phone its own kind, urgent for a low, and once per reading', async () => {
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
    expect(push.sendGlucoseAlert).toHaveBeenNthCalledWith(1, expect.objectContaining({ pushToken: 'ta', kind: 'low', urgent: true, title: '❗ 62 ⇊ −19' }));
    expect(push.sendGlucoseAlert).toHaveBeenNthCalledWith(2, expect.objectContaining({ pushToken: 'tb', kind: 'fast_fall', urgent: true, title: 'Glukoza szybko spada', body: '62 ⇊ −19\nIOB 0,5 j · COB 0 g' }));
    await service.run(NOW);
    expect(push.sendGlucoseAlert).toHaveBeenCalledTimes(2);
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

  it('sends "Brak danych" to phones with it on and drops a dead token', async () => {
    const { store, push, log } = setup([
      phone(),
      phone({ device_id: 'b', push_token: 'tb', kinds_off: ['no_data'] }),
    ]);
    push.sendGlucoseAlert.mockRejectedValueOnce(new PushNotificationProviderError('DEVICE_TOKEN_UNREGISTERED', 'gone', false));
    const service = new GlucoseAlertService({
      store, push, log,
      dashboard: async () => dashboard({ value: 120, unit: 'mg/dL', direction: 'Flat', observed_at: minutesAgo(12), delta: 0 }),
    });
    await service.run(NOW);
    expect(push.sendGlucoseAlert).toHaveBeenCalledTimes(1);
    expect(push.sendGlucoseAlert).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'ta', kind: 'no_data', urgent: false, title: 'Brak danych', body: 'Brak pomiarów od 12 min.' }));
    expect(store.deactivatePushToken).toHaveBeenCalledWith('ta');
  });
});
