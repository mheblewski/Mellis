import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import { isValidTimeZone } from '@modules/context/application/time-range-normalization';
import { makeLocalMinuteOfDay } from '@modules/evidence-tools/daily-insulin-totals';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import { resolveHomeTimeZone } from '@shared/primitives/home-time-zone';

/**
 * Infusion site pushes (site-alerts.v2, owner 2026-11-04), "Wkłucie" in "Powiadomienia o sprzęcie". A site is due after
 * 72 hours, and the pushes follow the patient's day, not a share of those hours:
 * - due from 9:00 to 22:00: at 7:00 that day ("Dziś wymiana wkłucia") and when it is due ("Wkłucie ma już 3 dni");
 * - due from 7:00 to 9:00: only at 7:00;
 * - due before 7:00: at 19:00 the evening before, and at 7:00 if it was not changed;
 * - due after 22:00: at 19:00 that evening, and at 7:00 the next day if it was not changed.
 * Nothing goes out from 22:00 to 7:00; a push that was late waits for the morning. A site first seen past due gets only
 * the second push. A newer "Site Change" starts the count again. A site older than 7 days is not pushed (the change was
 * most likely not logged). On by default, like the reservoir.
 */
export const SITE_ALERT_POLICY = {
  version: 'site-alerts.v2',
  /** The app colours the site red then. */
  change_now_after_ms: 72 * 60 * 60_000,
  max_age_ms: 7 * 24 * 60 * 60_000,
  morning_minute: 7 * 60,
  evening_minute: 19 * 60,
  /** Due before this hour, one push at 7:00 is enough. */
  one_push_before_minute: 9 * 60,
  night_from_minute: 22 * 60,
} as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const WEEKDAYS: Record<string, string> = {
  Mon: 'w poniedziałek',
  Tue: 'we wtorek',
  Wed: 'w środę',
  Thu: 'w czwartek',
  Fri: 'w piątek',
  Sat: 'w sobotę',
  Sun: 'w niedzielę',
};

export interface SiteAlertState {
  patient_id: string;
  /** The "Site Change" the last push was about. */
  notified_site_changed_at: string | null;
  notified_at: string | null;
  revision: number;
}

export interface SiteAlertDecision {
  next: Omit<SiteAlertState, 'patient_id' | 'revision'> | null;
  /** Whole hours since the change, when a push is due; `now` once the site is past 72 hours. */
  push: { hours: number; now: boolean } | null;
}

function minuteOfDay(timeZone: string): (ms: number) => number {
  const localMinute = makeLocalMinuteOfDay(isValidTimeZone(timeZone) ? timeZone : resolveHomeTimeZone());
  return (ms) => localMinute(ms) as number;
}

/** The moment `minute` strikes on the local day of `ms`; the second step corrects a clock change in between. */
function atLocalMinute(ms: number, minute: number, minuteOf: (ms: number) => number): number {
  const moved = ms + (minute - minuteOf(ms)) * MINUTE_MS;
  return moved + (minute - minuteOf(moved)) * MINUTE_MS;
}

/** When a site's pushes are planned; `second` is null when the push at 7:00 is the only one. */
export function planSitePushes(changedAtMs: number, timeZone: string): { due: number; first: number; second: number | null } {
  const minuteOf = minuteOfDay(timeZone);
  const { morning_minute: morning, evening_minute: evening, one_push_before_minute: onePushBefore, night_from_minute: night } = SITE_ALERT_POLICY;
  const due = changedAtMs + SITE_ALERT_POLICY.change_now_after_ms;
  const minute = minuteOf(due);
  if (minute < morning) return { due, first: atLocalMinute(due - 12 * HOUR_MS, evening, minuteOf), second: atLocalMinute(due, morning, minuteOf) };
  if (minute < onePushBefore) return { due, first: atLocalMinute(due, morning, minuteOf), second: null };
  if (minute < night) return { due, first: atLocalMinute(due, morning, minuteOf), second: due };
  return { due, first: atLocalMinute(due, evening, minuteOf), second: atLocalMinute(due + 12 * HOUR_MS, morning, minuteOf) };
}

export function decideSiteAlert(state: SiteAlertState | null, siteChangedAt: string | null, now: Date, timeZone: string): SiteAlertDecision {
  const changedAt = siteChangedAt ? Date.parse(siteChangedAt) : Number.NaN;
  if (!Number.isFinite(changedAt)) return { next: null, push: null };
  const nowMs = now.getTime();
  const age = nowMs - changedAt;
  if (age > SITE_ALERT_POLICY.max_age_ms) return { next: null, push: null };
  const plan = planSitePushes(changedAt, timeZone);
  if (nowMs < plan.first) return { next: null, push: null };
  const minute = minuteOfDay(timeZone)(nowMs);
  if (minute < SITE_ALERT_POLICY.morning_minute || minute >= SITE_ALERT_POLICY.night_from_minute) return { next: null, push: null };
  const notifiedFor = state?.notified_site_changed_at ? Date.parse(state.notified_site_changed_at) : Number.NaN;
  if (Number.isFinite(notifiedFor) && notifiedFor === changedAt) {
    // This site was pushed already: once more only for the planned second push, if the last one came before the site was due.
    const notifiedAt = state?.notified_at ? Date.parse(state.notified_at) : Number.NaN;
    const secondDone = Number.isFinite(notifiedAt) && notifiedAt >= plan.due;
    if (plan.second === null || nowMs < plan.second || secondDone) return { next: null, push: null };
  }
  return {
    next: { notified_site_changed_at: new Date(changedAt).toISOString(), notified_at: now.toISOString() },
    push: { hours: Math.floor(age / HOUR_MS), now: nowMs >= plan.due },
  };
}

function clockText(minute: number): string {
  return `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}`;
}

/**
 * Before the site is due "Dziś wymiana wkłucia" / "Wkłucie skończy 3 dni o 19:40."; for a time at night
 * "Dziś wieczorem wymiana wkłucia" with a hint to change it this evening and check glucose 1–2 h later. Once due "Wkłucie ma już 3 dni" /
 * "Założone w poniedziałek o 19:40. Zmień je teraz."
 */
export function sitePushText(siteChangedAt: string, now: Date, timeZone: string): { title: string; body: string } {
  const zone = isValidTimeZone(timeZone) ? timeZone : resolveHomeTimeZone();
  const minuteOf = minuteOfDay(zone);
  const changedAt = Date.parse(siteChangedAt);
  const due = changedAt + SITE_ALERT_POLICY.change_now_after_ms;
  const nowMs = now.getTime();
  if (nowMs < due) {
    const minute = minuteOf(due);
    const clock = clockText(minute);
    if (minute < SITE_ALERT_POLICY.morning_minute) {
      return { title: 'Dziś wieczorem wymiana wkłucia', body: `Wkłucie skończy 3 dni o ${clock} w nocy. Najlepiej zmień je dziś wieczorem i sprawdź glukozę po 1–2 godz.` };
    }
    if (minute >= SITE_ALERT_POLICY.night_from_minute) {
      return { title: 'Dziś wieczorem wymiana wkłucia', body: `Wkłucie skończy 3 dni o ${clock}. Najlepiej zmień je dziś wieczorem i sprawdź glukozę po 1–2 godz.` };
    }
    return { title: 'Dziś wymiana wkłucia', body: `Wkłucie skończy 3 dni o ${clock}.` };
  }
  const days = Math.floor((nowMs - changedAt) / (24 * HOUR_MS));
  const weekday = WEEKDAYS[new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(new Date(changedAt))];
  const action = nowMs - due < HOUR_MS ? 'Zmień je teraz.' : minuteOf(nowMs) < 10 * 60 ? 'Zmień je dziś rano.' : 'Zmień je dziś.';
  return { title: `Wkłucie ma już ${days} dni`, body: `Założone ${weekday} o ${clockText(minuteOf(changedAt))}. ${action}` };
}

export interface SiteAlertStore {
  /** Patients with at least one phone that has "Wkłucie" on. */
  listPatientsWithSiteDevices(): Promise<string[]>;
  listSiteDevices(patientId: string): Promise<Array<{ device_id: string; push_token: string }>>;
  getSiteState(patientId: string): Promise<SiteAlertState | null>;
  /** Stores the state if nobody changed it since `revision` was read (-1: no row yet); false when someone did. */
  saveSiteState(patientId: string, revision: number, next: NonNullable<SiteAlertDecision['next']>): Promise<boolean>;
  deactivatePushToken(pushToken: string): Promise<void>;
}

export interface SiteAlertPush {
  sendSiteAlert(input: { patientId: string; pushToken: string; siteChangedAt: string; now: boolean; title: string; body: string }): Promise<void>;
}

export class SiteAlertService {
  constructor(private readonly deps: {
    store: SiteAlertStore;
    push: SiteAlertPush;
    dashboard: (patientId: string, now: Date) => Promise<DashboardResponse>;
    timeZone: (patientId: string) => Promise<string>;
    log: (event: Record<string, unknown>) => void;
  }) {}

  async run(now: Date): Promise<void> {
    let patients: string[];
    try {
      patients = await this.deps.store.listPatientsWithSiteDevices();
    } catch (error) {
      this.deps.log({ event: 'site_alerts_unavailable', error_code: errorCode(error) });
      return;
    }
    for (const patientId of patients) {
      try {
        await this.evaluate(patientId, now);
      } catch (error) {
        this.deps.log({ event: 'site_alert_failed', patient_id: patientId, error_code: errorCode(error) });
      }
    }
  }

  async evaluate(patientId: string, now: Date): Promise<boolean> {
    const siteChangedAt = (await this.deps.dashboard(patientId, now)).site_changed_at;
    const state = await this.deps.store.getSiteState(patientId);
    const timeZone = await this.deps.timeZone(patientId);
    const decision = decideSiteAlert(state, siteChangedAt, now, timeZone);
    if (!decision.next || !decision.push) return false;
    // The claim comes first: a second worker (or this one after a restart) sees the site as pushed already.
    if (!(await this.deps.store.saveSiteState(patientId, state?.revision ?? -1, decision.next))) return false;

    const text = sitePushText(decision.next.notified_site_changed_at as string, now, timeZone);
    const devices = await this.deps.store.listSiteDevices(patientId);
    let delivered = 0;
    for (const device of devices) {
      try {
        await this.deps.push.sendSiteAlert({ patientId, pushToken: device.push_token, siteChangedAt: decision.next.notified_site_changed_at as string, now: decision.push.now, ...text });
        delivered += 1;
      } catch (error) {
        if (error instanceof PushNotificationProviderError && (error.code === 'DEVICE_TOKEN_INVALID' || error.code === 'DEVICE_TOKEN_UNREGISTERED')) {
          await this.deps.store.deactivatePushToken(device.push_token).catch(() => undefined);
        }
        this.deps.log({ event: 'site_alert_send_failed', patient_id: patientId, error_code: errorCode(error) });
      }
    }
    this.deps.log({ event: 'site_alert_sent', patient_id: patientId, hours: decision.push.hours, now: decision.push.now, devices: devices.length, delivered });
    return true;
  }
}

function errorCode(error: unknown): string {
  if (error instanceof PushNotificationProviderError) return error.code;
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return 'UNKNOWN';
}
