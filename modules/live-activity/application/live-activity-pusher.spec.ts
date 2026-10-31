import { describe, expect, it } from 'vitest';
import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import type { EnabledLiveActivitySubscription, LiveActivitySubscription } from '@infra/db/postgres-live-activity.repository';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import {
  LiveActivityPusher,
  LIVE_ACTIVITY_RENEW_AFTER_MS,
  LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS,
  LIVE_ACTIVITY_STALE_NUDGE_WINDOW_MS,
  LIVE_ACTIVITY_TWO_PATIENT_MIN_INTERVAL_MS,
  staleNudgeDue,
  type LiveActivityStore,
} from './live-activity-pusher';
import { buildLiveActivityContentState, LIVE_ACTIVITY_STALE_AFTER_SECONDS, liveActivityUpdateAps } from './live-activity-state';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-27T10:00:00.000Z');

function dashboard(readingAt = '2026-10-27T09:58:00.000Z'): DashboardResponse {
  return {
    patient_id: PATIENT,
    generated_at: NOW.toISOString(),
    glucose: { value: 142, unit: 'mg/dL', direction: 'FortyFiveUp', observed_at: readingAt, delta: 4 },
    readings: [
      { at: '2026-10-27T07:00:00.000Z', value: 99 },
      { at: '2026-10-27T09:53:00.000Z', value: 138 },
      { at: readingAt, value: 142 },
    ],
    time_in_range: null,
    pump: { battery_percent: 64.4, reservoir_units: 112.25, reservoir_full_units: 200, last_read_at: NOW.toISOString() },
    loop: { iob_units: 1.354, cob_grams: 22.4, observed_at: NOW.toISOString() },
    insulin: { boluses: [{ at: '2026-10-27T09:00:00.000Z', units: 3.2 }, { at: '2026-10-27T06:00:00.000Z', units: 4 }], smbs: [], basal: [] },
    site_changed_at: '2026-10-25T10:00:00.000Z',
    sensor_started_at: null,
  };
}

function subscription(overrides: Partial<EnabledLiveActivitySubscription> = {}): EnabledLiveActivitySubscription {
  return {
    device_id: 'device-a', patient_id: PATIENT, user_id: 'user', enabled: true, island_enabled: true,
    start_token: 'start-token', activity_id: 'activity-1', update_token: 'update-token',
    activity_started_at: new Date(NOW.getTime() - 60 * 60_000).toISOString(), start_requested_at: null,
    last_reading_at: '2026-10-27T09:53:00.000Z', last_push_at: null,
    patient_ids: [PATIENT], island_mode: 'both', island_left_patient_id: null, last_readings: {},
    shown_patient_ids: [PATIENT],
    ...overrides,
  };
}

/** The second patient: low and falling (Kuba), read at 09:59. */
function secondDashboard(value = 64, readingAt = '2026-10-27T09:59:00.000Z'): DashboardResponse {
  return {
    ...dashboard(readingAt),
    patient_id: SECOND,
    glucose: { value, unit: 'mg/dL', direction: 'SingleDown', observed_at: readingAt, delta: -6 },
    loop: { iob_units: 0.42, cob_grams: 0, observed_at: NOW.toISOString() },
  };
}

/** Both patients on one phone, the activity showing both readings already unless overridden. */
function twoPatients(overrides: Partial<EnabledLiveActivitySubscription> = {}): EnabledLiveActivitySubscription {
  return subscription({
    patient_ids: [PATIENT, SECOND],
    shown_patient_ids: [PATIENT, SECOND],
    last_readings: { [PATIENT]: '2026-10-27T09:58:00.000Z', [SECOND]: '2026-10-27T09:54:00.000Z' },
    last_push_at: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    ...overrides,
  });
}

function harness(
  rows: EnabledLiveActivitySubscription[],
  options: { failWith?: PushNotificationProviderError; disabled?: LiveActivitySubscription[]; first?: DashboardResponse; second?: DashboardResponse } = {},
) {
  const sent: Array<{ token: string; aps: Record<string, unknown> }> = [];
  const calls: string[] = [];
  const store: LiveActivityStore = {
    listEnabled: async () => rows,
    listDisabledWithActivity: async () => options.disabled ?? [],
    markUpdated: async (device, readings) => { calls.push(`updated ${device} ${Object.values(readings).join(' ')}`); },
    markStartRequested: async (device) => { calls.push(`start-requested ${device}`); },
    forgetActivity: async (device, token) => { calls.push(`forget-activity ${device} ${token}`); },
    forgetStartToken: async (device, token) => { calls.push(`forget-start ${device} ${token}`); },
  };
  let dashboardReads = 0;
  const pusher = new LiveActivityPusher({
    store,
    sender: {
      sendLiveActivity: async (token, aps) => {
        if (options.failWith) throw options.failWith;
        sent.push({ token, aps });
      },
    },
    dashboard: async (patientId) => { dashboardReads += 1; return patientId === SECOND ? (options.second ?? secondDashboard()) : (options.first ?? dashboard()); },
    patientName: async (patientId) => (patientId === SECOND ? 'Kuba' : 'Zosia'),
    log: () => undefined,
  });
  return { pusher, sent, calls, reads: () => dashboardReads };
}

describe('buildLiveActivityContentState', () => {
  it('carries the reading, IOB/COB, equipment and 2 h of chart in seconds', () => {
    const state = buildLiveActivityContentState(dashboard(), NOW);
    expect(state).toMatchObject({ glucose: 142, direction: 'FortyFiveUp', delta: 4, iob: 1.35, cob: 22, reservoir: 112.3, battery: 64, sensorStartedAt: null });
    expect(state.readingAt).toBe(Date.parse('2026-10-27T09:58:00.000Z') / 1000);
    expect(state.siteChangedAt).toBe(Date.parse('2026-10-25T10:00:00.000Z') / 1000);
    // Only the last 2 h.
    expect(state.readings.map(([, value]) => value)).toEqual([138, 142]);
    expect(state.boluses).toEqual([[Date.parse('2026-10-27T09:00:00.000Z') / 1000, 3.2]]);
    expect(JSON.stringify(state).length).toBeLessThan(4096);
    // One patient: the 088 content, nothing an older app would not know.
    expect(state).not.toHaveProperty('others');
    expect(state).not.toHaveProperty('patientID');
  });

  it('two patients: the second as a small glance, no chart, island mode and the left side', () => {
    const state = buildLiveActivityContentState(dashboard(), NOW, {
      patient: { id: PATIENT, name: 'Zosia' },
      others: [{ id: SECOND, name: 'Kuba', dashboard: secondDashboard() }],
      islandMode: 'closer',
      islandLeft: SECOND,
    });
    expect(state).toMatchObject({ patientID: PATIENT, patientName: 'Zosia', glucose: 142, islandMode: 'closer', islandLeft: SECOND, readings: [], boluses: [] });
    expect(state.others).toEqual([
      { id: SECOND, name: 'Kuba', glucose: 64, direction: 'SingleDown', delta: -6, readingAt: Date.parse('2026-10-27T09:59:00.000Z') / 1000, iob: 0.42 },
    ]);
    expect(JSON.stringify({ aps: liveActivityUpdateAps(state, NOW) }).length).toBeLessThan(1024);
  });

  it('two patients: an unknown left side falls back to the first; stale only when both readings are old', () => {
    const state = buildLiveActivityContentState(dashboard(), NOW, {
      patient: { id: PATIENT, name: 'Zosia' },
      others: [{ id: SECOND, name: 'Kuba', dashboard: secondDashboard() }],
      islandLeft: '33333333-3333-4333-8333-333333333333',
    });
    expect(state).toMatchObject({ islandMode: 'both', islandLeft: PATIENT });
    expect(liveActivityUpdateAps(state, NOW)['stale-date']).toBe(Date.parse('2026-10-27T09:59:00.000Z') / 1000 + 960);
  });
});

describe('LiveActivityPusher', () => {
  it('pushes a new reading to the running activity, stale 16 min after it (the widgets\' rule)', async () => {
    const { pusher, sent, calls } = harness([subscription()]);
    await pusher.tick(NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0].token).toBe('update-token');
    expect(sent[0].aps).toMatchObject({ event: 'update', 'stale-date': Date.parse('2026-10-27T09:58:00.000Z') / 1000 + 960 });
    expect(calls).toEqual(['updated device-a 2026-10-27T09:58:00.000Z']);
  });

  it('carries the phone\'s "Dynamic Island" switch', async () => {
    const { pusher, sent } = harness([subscription({ island_enabled: false })]);
    await pusher.tick(NOW);
    expect((sent[0].aps['content-state'] as Record<string, unknown>).islandEnabled).toBe(false);
  });

  it('sends nothing when the activity already shows the newest reading', async () => {
    const { pusher, sent } = harness([subscription({ last_reading_at: '2026-10-27T09:58:00.000Z' })]);
    await pusher.tick(NOW);
    expect(sent).toEqual([]);
  });

  it('reads each patient once for all their phones', async () => {
    const { pusher, sent, reads } = harness([subscription(), subscription({ device_id: 'device-b', update_token: 'other' })]);
    await pusher.tick(NOW);
    expect(sent.map((push) => push.token)).toEqual(['update-token', 'other']);
    expect(reads()).toBe(1);
  });

  it('starts a new activity before iOS ends the old one and ends the old one', async () => {
    const old = new Date(NOW.getTime() - LIVE_ACTIVITY_RENEW_AFTER_MS).toISOString();
    const { pusher, sent, calls } = harness([subscription({ activity_started_at: old })]);
    await pusher.tick(NOW);
    expect(sent.map((push) => [push.token, push.aps.event])).toEqual([['update-token', 'end'], ['start-token', 'start']]);
    expect(sent[1].aps).toMatchObject({ 'attributes-type': 'GlucoseActivityAttributes', attributes: { patientID: PATIENT, patientName: 'Zosia' } });
    expect((sent[1].aps.alert as Record<string, unknown>).title).toBe('Zosia');
    expect(sent[1].aps).not.toHaveProperty('sound');
    expect(calls).toEqual(['start-requested device-a']);
  });

  it('starts one when there is no activity, but not again while the last start is fresh', async () => {
    const none = harness([subscription({ update_token: null, activity_id: null, activity_started_at: null })]);
    await none.pusher.tick(NOW);
    expect(none.sent.map((push) => push.aps.event)).toEqual(['start']);

    const waiting = harness([subscription({ update_token: null, start_requested_at: new Date(NOW.getTime() - 10 * 60_000).toISOString() })]);
    await waiting.pusher.tick(NOW);
    expect(waiting.sent).toEqual([]);
  });

  it('without a push-to-start token it waits for the app', async () => {
    const { pusher, sent } = harness([subscription({ update_token: null, start_token: null })]);
    await pusher.tick(NOW);
    expect(sent).toEqual([]);
  });

  it('forgets an activity whose token APNs no longer knows', async () => {
    const { pusher, calls } = harness([subscription()], { failWith: new PushNotificationProviderError('DEVICE_TOKEN_UNREGISTERED', 'gone', false) });
    await pusher.tick(NOW);
    expect(calls).toEqual(['forget-activity device-a update-token']);
  });

  it('keeps the activity on a temporary APNs failure', async () => {
    const { pusher, calls } = harness([subscription()], { failWith: new PushNotificationProviderError('APNS_RETRYABLE', 'busy', true) });
    await pusher.tick(NOW);
    expect(calls).toEqual([]);
  });

  it('ends the activity of a phone switched off', async () => {
    const { pusher, sent, calls } = harness([], { disabled: [subscription({ enabled: false })] });
    await pusher.tick(NOW);
    expect(sent.map((push) => [push.token, push.aps.event])).toEqual([['update-token', 'end']]);
    expect(calls).toEqual(['forget-activity device-a update-token']);
  });

  describe('two patients', () => {
    it('pushes when the second patient has a new reading, with both in the content', async () => {
      const { pusher, sent, calls, reads } = harness([twoPatients()]);
      await pusher.tick(NOW);
      expect(sent).toHaveLength(1);
      const state = sent[0].aps['content-state'] as Record<string, unknown>;
      expect(state).toMatchObject({ patientID: PATIENT, patientName: 'Zosia', glucose: 142, islandMode: 'both', islandLeft: PATIENT });
      expect((state.others as Array<Record<string, unknown>>)[0]).toMatchObject({ id: SECOND, name: 'Kuba', glucose: 64 });
      expect(calls).toEqual(['updated device-a 2026-10-27T09:58:00.000Z 2026-10-27T09:59:00.000Z']);
      expect(reads()).toBe(2);
    });

    it('sends nothing while both readings are already shown', async () => {
      const { pusher, sent } = harness([twoPatients({ last_readings: { [PATIENT]: '2026-10-27T09:58:00.000Z', [SECOND]: '2026-10-27T09:59:00.000Z' } })]);
      await pusher.tick(NOW);
      expect(sent).toEqual([]);
    });

    it('holds a second push within a minute of the last one, unless a glucose is under 70', async () => {
      const recent = new Date(NOW.getTime() - LIVE_ACTIVITY_TWO_PATIENT_MIN_INTERVAL_MS + 20_000).toISOString();
      const held = harness([twoPatients({ last_push_at: recent })], { second: secondDashboard(95) });
      await held.pusher.tick(NOW);
      expect(held.sent).toEqual([]);

      const later = harness([twoPatients({ last_push_at: new Date(NOW.getTime() - LIVE_ACTIVITY_TWO_PATIENT_MIN_INTERVAL_MS).toISOString() })], { second: secondDashboard(95) });
      await later.pusher.tick(NOW);
      expect(later.sent).toHaveLength(1);

      const low = harness([twoPatients({ last_push_at: recent })], { second: secondDashboard(64) });
      await low.pusher.tick(NOW);
      expect(low.sent).toHaveLength(1);
    });

    it('a change of what the activity shows is pushed at once', async () => {
      const recent = new Date(NOW.getTime() - 10_000).toISOString();
      const { pusher, sent } = harness([twoPatients({ last_push_at: recent, last_readings: {}, last_reading_at: null })], { second: secondDashboard(95) });
      await pusher.tick(NOW);
      expect(sent).toHaveLength(1);
    });

    it('a patient the person lost access to drops out: one patient again, pushed at once', async () => {
      const { pusher, sent } = harness([twoPatients({ shown_patient_ids: [PATIENT], last_readings: { [PATIENT]: '2026-10-27T09:58:00.000Z', [SECOND]: '2026-10-27T09:59:00.000Z' } })]);
      await pusher.tick(NOW);
      expect(sent).toHaveLength(1);
      const state = sent[0].aps['content-state'] as Record<string, unknown>;
      expect(state).not.toHaveProperty('others');
      expect((state.readings as unknown[]).length).toBeGreaterThan(0);
    });

    it('the first patient dropping out shows the second in the same activity (no restart)', async () => {
      const { pusher, sent } = harness([twoPatients({ shown_patient_ids: [SECOND] })]);
      await pusher.tick(NOW);
      expect(sent.map((push) => push.aps.event)).toEqual(['update']);
      expect(sent[0].aps['content-state']).toMatchObject({ patientID: SECOND, patientName: 'Kuba', glucose: 64 });
    });

    it('a push-to-start names both patients', async () => {
      const { pusher, sent } = harness([twoPatients({ update_token: null, activity_id: null, activity_started_at: null })]);
      await pusher.tick(NOW);
      expect(sent[0].aps).toMatchObject({ event: 'start', attributes: { patientID: PATIENT, patientName: 'Zosia' }, alert: { title: 'Zosia i Kuba' } });
    });
  });
});

describe('stale nudge (dims the activity when its reading turns stale, as the widgets do)', () => {
  /** The reading the activity shows: 16 min before 10:00, so it turns stale at 10:00:00. */
  const READING = '2026-10-27T09:44:00.000Z';
  const MARK_MS = Date.parse(READING) + LIVE_ACTIVITY_STALE_AFTER_SECONDS * 1000;
  const at = (offsetMs: number) => new Date(MARK_MS + offsetMs);
  const shown = (overrides: Partial<EnabledLiveActivitySubscription> = {}) =>
    subscription({ last_reading_at: READING, last_readings: { [PATIENT]: READING }, last_push_at: '2026-10-27T09:44:20.000Z', ...overrides });

  it('the stale mark is the widgets\' one: 16 min after the reading (iOS "over 15 whole minutes")', () => {
    expect(LIVE_ACTIVITY_STALE_AFTER_SECONDS).toBe(16 * 60);
    expect(MARK_MS).toBe(Date.parse('2026-10-27T10:00:00.000Z'));
  });

  it('is not sent before the mark plus the slack', async () => {
    for (const offset of [-60_000, -1, 0, LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS - 1]) {
      const { pusher, sent } = harness([shown()], { first: dashboard(READING) });
      await pusher.tick(at(offset));
      expect(sent, `offset ${offset}`).toEqual([]);
    }
  });

  it('is sent once the reading is stale: the same content, its stale-date already passed, priority as every update', async () => {
    const now = at(LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS);
    const { pusher, sent, calls } = harness([shown()], { first: dashboard(READING) });
    await pusher.tick(now);
    expect(sent).toHaveLength(1);
    expect(sent[0].token).toBe('update-token');
    expect(sent[0].aps).toMatchObject({ event: 'update', timestamp: Math.floor(now.getTime() / 1000), 'stale-date': MARK_MS / 1000 });
    expect(sent[0].aps['content-state']).toEqual(buildLiveActivityContentState(dashboard(READING), now));
    expect(calls).toEqual([`updated device-a ${READING}`]);
  });

  it('only once per reading: after it went out (last_push_at past the mark) nothing more', async () => {
    const after = harness([shown({ last_push_at: at(LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS + 2_000).toISOString() })], { first: dashboard(READING) });
    for (const offset of [30_000, 60_000, 5 * 60_000]) await after.pusher.tick(at(offset));
    expect(after.sent).toEqual([]);
  });

  it('survives a worker restart: a new pusher decides from the row alone', async () => {
    const before = harness([shown()], { first: dashboard(READING) });
    await before.pusher.tick(at(-30_000));
    expect(before.sent).toEqual([]);
    // The worker restarts 3 min after the mark: the nudge is still due (nothing in memory needed) ...
    const restarted = harness([shown()], { first: dashboard(READING) });
    await restarted.pusher.tick(at(3 * 60_000));
    expect(restarted.sent).toHaveLength(1);
    // ... and a restart after it went out sends nothing again.
    const again = harness([shown({ last_push_at: at(3 * 60_000).toISOString() })], { first: dashboard(READING) });
    await again.pusher.tick(at(3 * 60_000 + 15_000));
    expect(again.sent).toEqual([]);
  });

  it('a newer reading replaces it: an ordinary push, and no nudge for the old reading', async () => {
    const newer = '2026-10-27T09:59:30.000Z';
    const fresh = harness([shown()], { first: dashboard(newer) });
    await fresh.pusher.tick(at(LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS));
    expect(fresh.sent).toHaveLength(1);
    expect(fresh.sent[0].aps).toMatchObject({ 'stale-date': Date.parse(newer) / 1000 + 16 * 60 });
    expect(fresh.calls).toEqual([`updated device-a ${newer}`]);
    // Shown now: the old reading's mark has passed, the new one's not; nothing is due.
    const shownNewer = harness([shown({ last_reading_at: newer, last_readings: { [PATIENT]: newer }, last_push_at: at(LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS).toISOString() })], { first: dashboard(newer) });
    await shownNewer.pusher.tick(at(60_000));
    expect(shownNewer.sent).toEqual([]);
  });

  it('a reading already stale when it was pushed needs none (it was drawn dimmed)', async () => {
    const { pusher, sent } = harness([shown({ last_push_at: at(5_000).toISOString() })], { first: dashboard(READING) });
    await pusher.tick(at(30_000));
    expect(sent).toEqual([]);
  });

  it('is given up after the window (iOS\'s stale-date has dimmed it by then)', async () => {
    const { pusher, sent } = harness([shown()], { first: dashboard(READING) });
    await pusher.tick(at(LIVE_ACTIVITY_STALE_NUDGE_WINDOW_MS));
    expect(sent).toEqual([]);
  });

  it('phones switched off get no nudge (only their end)', async () => {
    const { pusher, sent } = harness([], { disabled: [shown({ enabled: false })], first: dashboard(READING) });
    await pusher.tick(at(LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS));
    expect(sent.map((push) => push.aps.event)).toEqual(['end']);
  });

  it('two patients: at each patient\'s own mark, with both in the content', async () => {
    const other = '2026-10-27T09:58:00.000Z';
    const row = twoPatients({ last_readings: { [PATIENT]: READING, [SECOND]: other }, last_push_at: '2026-10-27T09:58:20.000Z' });
    const { pusher, sent } = harness([row], { first: dashboard(READING), second: secondDashboard(95, other) });
    await pusher.tick(at(LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS));
    expect(sent).toHaveLength(1);
    const state = sent[0].aps['content-state'] as Record<string, unknown>;
    expect(state).toMatchObject({ patientID: PATIENT, readingAt: Date.parse(READING) / 1000 });
    expect((state.others as Array<Record<string, unknown>>)[0]).toMatchObject({ id: SECOND, readingAt: Date.parse(other) / 1000 });
    // The activity as a whole is stale only when both are (each half dims on its own in the app).
    expect(sent[0].aps['stale-date']).toBe(Date.parse(other) / 1000 + 16 * 60);
    // The second patient's mark (10:14) gets its own nudge later.
    expect(staleNudgeDue(row.last_readings, at(LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS).toISOString(), new Date(Date.parse(other) + 16 * 60_000 + 10_000))).toBe(true);
  });

  it('staleNudgeDue: due between mark + slack and the window, only when the last push was before the mark', () => {
    const readings = { [PATIENT]: READING };
    const before = '2026-10-27T09:50:00.000Z';
    expect(staleNudgeDue(readings, before, at(LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS - 1))).toBe(false);
    expect(staleNudgeDue(readings, before, at(LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS))).toBe(true);
    expect(staleNudgeDue(readings, before, at(LIVE_ACTIVITY_STALE_NUDGE_WINDOW_MS - 1))).toBe(true);
    expect(staleNudgeDue(readings, before, at(LIVE_ACTIVITY_STALE_NUDGE_WINDOW_MS))).toBe(false);
    expect(staleNudgeDue(readings, at(0).toISOString(), at(20_000))).toBe(false);
    expect(staleNudgeDue(readings, null, at(20_000))).toBe(true);
    expect(staleNudgeDue({ [PATIENT]: null }, before, at(20_000))).toBe(false);
  });

  it('the reading time is the dashboard\'s glucose.observed_at (what the widgets dim by), not the loop or generated time', async () => {
    const { pusher, sent } = harness([shown()], { first: { ...dashboard(READING), generated_at: at(0).toISOString(), loop: { iob_units: 1, cob_grams: 0, observed_at: at(0).toISOString() } } });
    await pusher.tick(at(LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS));
    expect((sent[0].aps['content-state'] as Record<string, unknown>).readingAt).toBe(Date.parse(READING) / 1000);
  });
});
