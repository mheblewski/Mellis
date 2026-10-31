import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import type { LiveActivityPushSender } from '@modules/notifications/infrastructure/apns-push-notification-provider';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import type { EnabledLiveActivitySubscription, LiveActivityReadings, LiveActivitySubscription } from '@infra/db/postgres-live-activity.repository';
import {
  buildLiveActivityContentState,
  LIVE_ACTIVITY_STALE_AFTER_SECONDS,
  type LiveActivityContentState,
  liveActivityEndAps,
  liveActivityStartAps,
  liveActivityUpdateAps,
} from './live-activity-state';

export interface LiveActivityStore {
  listEnabled(): Promise<EnabledLiveActivitySubscription[]>;
  listDisabledWithActivity(): Promise<LiveActivitySubscription[]>;
  markUpdated(deviceId: string, readings: LiveActivityReadings, now: Date): Promise<void>;
  markStartRequested(deviceId: string, readings: LiveActivityReadings, now: Date): Promise<void>;
  forgetActivity(deviceId: string, updateToken: string, now: Date): Promise<void>;
  forgetStartToken(deviceId: string, startToken: string, now: Date): Promise<void>;
}

export interface LiveActivityPusherDeps {
  store: LiveActivityStore;
  sender: LiveActivityPushSender;
  dashboard: (patientId: string, now: Date) => Promise<DashboardResponse>;
  patientName: (patientId: string) => Promise<string>;
  log: (event: Record<string, unknown>) => void;
}

/** iOS ends an activity after 8 h: a new one starts a little before, so the lock screen never goes empty. */
export const LIVE_ACTIVITY_RENEW_AFTER_MS = (7 * 60 + 45) * 60_000;
/** A start (or an activity the phone saw end) waits this long before the next start: never a burst of activities. */
export const LIVE_ACTIVITY_START_RETRY_MS = 30 * 60_000;
/**
 * Two patients: at most one update push a minute per phone, each carrying both patients' newest readings. A reading of
 * the other patient that comes within a minute of the last push waits for the next tick after that minute (worst
 * case ~75 s late: 60 s plus one 15 s tick), so two sensors never double the push rate (two 1-minute sensors stay at one
 * push a minute; two 5-minute sensors give at most two pushes per 5 minutes, one when they come close together).
 * Never held back: a glucose under 70 on either patient, the first push after a change of what the activity shows,
 * starts and ends. One patient: unchanged, a push for every new reading.
 */
export const LIVE_ACTIVITY_TWO_PATIENT_MIN_INTERVAL_MS = 60_000;
const URGENT_BELOW_MG_DL = 70;

/**
 * The stale nudge (2026-10-31, owner: the Live Activity dimmed ~5 min after the widgets). iOS redraws an activity only
 * when an update arrives or, lazily and often minutes late, when its `stale-date` passes; the extension's own age check
 * (StaleReading) runs only on a redraw. So when a shown patient's newest reading turns stale
 * (LIVE_ACTIVITY_STALE_AFTER_SECONDS) and no newer one came, the worker sends one update with the same content: the
 * extension redraws and dims at once, as the widgets' per-minute timeline does. Sent from this slack after the mark
 * (clock differences between server and phone; the reading time in the content is whole seconds), on the first tick
 * after it (ticks every 15 s). Computed from the row alone (the push is due while `last_push_at` is before the mark),
 * so it is sent once per reading and survives worker restarts; a newer reading is an ordinary push instead.
 */
export const LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS = 10_000;
/** A nudge not sent within this long after the mark (worker down, APNs failing) is given up: iOS's stale-date has dimmed it. */
export const LIVE_ACTIVITY_STALE_NUDGE_WINDOW_MS = 10 * 60_000;

/**
 * Keeps every switched-on phone's glucose Live Activity current (live-activity.v1): a push for each new reading, one more when
 * the newest reading turns stale (the stale nudge, dims it on time), a new activity (push-to-start) before iOS ends the old one or after it ended, and an end for phones switched off. Runs on
 * the worker's timer; one dashboard read per patient per tick. Never throws.
 */
export class LiveActivityPusher {
  constructor(private readonly deps: LiveActivityPusherDeps) {}

  async tick(now: Date = new Date()): Promise<void> {
    try {
      await this.endSwitchedOff(now);
      const subscriptions = await this.deps.store.listEnabled();
      const dashboards = new Map<string, Promise<DashboardResponse | null>>();
      const names = new Map<string, Promise<string>>();
      const read = (patientId: string) => {
        let dashboard = dashboards.get(patientId);
        if (!dashboard) {
          dashboard = this.deps.dashboard(patientId, now).catch(() => null);
          dashboards.set(patientId, dashboard);
        }
        return dashboard;
      };
      const name = (patientId: string) => {
        let value = names.get(patientId);
        if (!value) {
          value = this.deps.patientName(patientId).catch(() => 'Mellis');
          names.set(patientId, value);
        }
        return value;
      };
      for (const subscription of subscriptions) {
        const ids = shownPatients(subscription);
        const shown: Array<{ id: string; dashboard: DashboardResponse }> = [];
        for (const id of ids) {
          const data = await read(id);
          if (data) shown.push({ id, dashboard: data });
        }
        // The first patient's data is needed; a second one that cannot be read now is left out of this push.
        if (shown.length === 0 || shown[0].id !== ids[0]) continue;
        await this.push(subscription, shown, name, now);
      }
    } catch (error) {
      this.deps.log({ event: 'live_activity_tick_failed', error: errorCode(error) });
    }
  }

  private async push(
    subscription: EnabledLiveActivitySubscription,
    shown: Array<{ id: string; dashboard: DashboardResponse }>,
    name: (patientId: string) => Promise<string>,
    now: Date,
  ): Promise<void> {
    const [first, ...others] = shown;
    const two = others.length > 0;
    // One patient keeps exactly the 088 content (patient fields only when it is not the row's own patient any more,
    // e.g. the first of two lost access and the second is shown alone).
    const needsNames = two || first.id !== subscription.patient_id;
    const state = buildLiveActivityContentState(first.dashboard, now, {
      islandEnabled: subscription.island_enabled,
      patient: needsNames ? { id: first.id, name: await name(first.id) } : undefined,
      others: two ? await Promise.all(others.map(async (other) => ({ id: other.id, name: await name(other.id), dashboard: other.dashboard }))) : undefined,
      islandMode: subscription.island_mode,
      islandLeft: subscription.island_left_patient_id,
    });
    const readings: LiveActivityReadings = Object.fromEntries(shown.map((patient) => [patient.id, patient.dashboard.glucose?.observed_at ?? null]));
    const startedMs = subscription.activity_started_at ? Date.parse(subscription.activity_started_at) : NaN;
    const needsStart = !subscription.update_token || (Number.isFinite(startedMs) && now.getTime() - startedMs >= LIVE_ACTIVITY_RENEW_AFTER_MS);

    if (needsStart) {
      if (!subscription.start_token) return;
      const requestedMs = subscription.start_requested_at ? Date.parse(subscription.start_requested_at) : NaN;
      if (Number.isFinite(requestedMs) && now.getTime() - requestedMs < LIVE_ACTIVITY_START_RETRY_MS) return;
      if (subscription.update_token) {
        await this.send(subscription.update_token, liveActivityEndAps(state, now)).catch(() => undefined);
      }
      try {
        const attributes = { patientID: first.id, patientName: await name(first.id) };
        await this.send(subscription.start_token, liveActivityStartAps(state, attributes, now, two ? await name(others[0].id) : undefined));
        await this.deps.store.markStartRequested(subscription.device_id, readings, now);
        this.deps.log({ event: 'live_activity_started', device: shortId(subscription.device_id), renewed: Boolean(subscription.update_token), patients: shown.length });
      } catch (error) {
        if (isGoneToken(error)) await this.deps.store.forgetStartToken(subscription.device_id, subscription.start_token, now);
        this.deps.log({ event: 'live_activity_start_failed', device: shortId(subscription.device_id), error: errorCode(error) });
      }
      return;
    }

    const last = lastReadings(subscription);
    const showsChanged = Object.keys(last).some((id) => !(id in readings));
    const newReading = Object.entries(readings).some(([id, at]) => at !== null && !sameInstant(at, last[id] ?? null));
    const nudge = !showsChanged && !newReading && staleNudgeDue(readings, subscription.last_push_at, now);
    if (!showsChanged && !newReading && !nudge) return;
    if (two && !showsChanged && Object.keys(subscription.last_readings ?? {}).length > 0 && !isUrgent(state)) {
      const lastPushMs = subscription.last_push_at ? Date.parse(subscription.last_push_at) : NaN;
      if (Number.isFinite(lastPushMs) && now.getTime() - lastPushMs < LIVE_ACTIVITY_TWO_PATIENT_MIN_INTERVAL_MS) return;
    }
    const token = subscription.update_token as string;
    try {
      await this.send(token, liveActivityUpdateAps(state, now));
      await this.deps.store.markUpdated(subscription.device_id, readings, now);
      if (nudge) this.deps.log({ event: 'live_activity_stale_nudge', device: shortId(subscription.device_id), patients: shown.length });
    } catch (error) {
      if (isGoneToken(error)) await this.deps.store.forgetActivity(subscription.device_id, token, now);
      this.deps.log({ event: 'live_activity_update_failed', device: shortId(subscription.device_id), error: errorCode(error) });
    }
  }

  private async endSwitchedOff(now: Date): Promise<void> {
    for (const subscription of await this.deps.store.listDisabledWithActivity()) {
      const token = subscription.update_token as string;
      await this.send(token, liveActivityEndAps(null, now)).catch(() => undefined);
      await this.deps.store.forgetActivity(subscription.device_id, token, now);
    }
  }

  /**
   * Priority 10 for every push, the stale nudge too: priority 5 is delivered when iOS sees fit (minutes late, the very
   * delay the nudge removes). It is at most one extra push per gap in the readings (none while readings come), next to
   * one per reading, so it barely touches the Live Activity update budget. No alert, no relevance score (one activity).
   */
  private send(token: string, aps: Record<string, unknown>): Promise<void> {
    return this.deps.sender.sendLiveActivity(token, aps, { priority: 10 });
  }
}

/** The patients the row may show now (listEnabled checked access); a row from an older store: its one patient. */
function shownPatients(subscription: EnabledLiveActivitySubscription): string[] {
  return subscription.shown_patient_ids?.length ? subscription.shown_patient_ids : [subscription.patient_id];
}

/** What the activity shows: last_readings (094), or the one patient's last_reading_at (rows before it, island changes). */
function lastReadings(subscription: LiveActivitySubscription): Record<string, string> {
  const map = subscription.last_readings ?? {};
  if (Object.keys(map).length > 0) return map;
  return subscription.last_reading_at ? { [subscription.patient_id]: subscription.last_reading_at } : {};
}

/**
 * A shown patient's newest reading turned stale after the last push (and within the window): the activity still shows it
 * as fresh until it is redrawn. Once sent, `last_push_at` is after the mark, so the same reading is never nudged again.
 */
export function staleNudgeDue(readings: LiveActivityReadings, lastPushAt: string | null, now: Date): boolean {
  const lastPushMs = lastPushAt ? Date.parse(lastPushAt) : NaN;
  return Object.values(readings).some((at) => {
    const readingMs = at ? Date.parse(at) : NaN;
    if (!Number.isFinite(readingMs)) return false;
    const markMs = readingMs + LIVE_ACTIVITY_STALE_AFTER_SECONDS * 1000;
    const nowMs = now.getTime();
    if (nowMs < markMs + LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS || nowMs >= markMs + LIVE_ACTIVITY_STALE_NUDGE_WINDOW_MS) return false;
    return !Number.isFinite(lastPushMs) || lastPushMs < markMs;
  });
}

function isUrgent(state: LiveActivityContentState): boolean {
  return [state.glucose, ...(state.others ?? []).map((other) => other.glucose)].some((value) => value !== null && value !== undefined && value < URGENT_BELOW_MG_DL);
}

function sameInstant(a: string, b: string | null): boolean {
  return b !== null && Date.parse(a) === Date.parse(b);
}

function isGoneToken(error: unknown): boolean {
  return error instanceof PushNotificationProviderError && (error.code === 'DEVICE_TOKEN_INVALID' || error.code === 'DEVICE_TOKEN_UNREGISTERED');
}

function errorCode(error: unknown): string {
  return error instanceof PushNotificationProviderError ? error.code : error instanceof Error ? error.name : 'UNKNOWN';
}

function shortId(deviceId: string): string {
  return deviceId.slice(0, 8);
}
