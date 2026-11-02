import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';

/**
 * Infusion site pushes (site-alerts.v1, owner 2026-11-02), "Wkłucie" in "Powiadomienia o sprzęcie". Two pushes per
 * site: "Czas zmienić wkłucie" when the newest "Site Change" in Nightscout is older than 48 hours (the app colours the
 * site yellow then) and "Wymień wkłucie teraz" after 72 (red). Each comes once; a site first seen past 72 hours gets
 * only the second. A newer "Site Change" starts the count again. A site older than 7
 * days is not pushed (the change was most likely not logged). On by default, like the reservoir.
 */
export const SITE_ALERT_POLICY = {
  version: 'site-alerts.v1',
  change_after_ms: 48 * 60 * 60_000,
  /** The second push: "Wymień wkłucie teraz" (owner 2026-11-02). */
  change_now_after_ms: 72 * 60 * 60_000,
  max_age_ms: 7 * 24 * 60 * 60_000,
} as const;

export interface SiteAlertState {
  patient_id: string;
  /** The "Site Change" the last push was about. */
  notified_site_changed_at: string | null;
  notified_at: string | null;
  revision: number;
}

export interface SiteAlertDecision {
  next: Omit<SiteAlertState, 'patient_id' | 'revision'> | null;
  /** Whole hours since the change, when a push is due; `now` for the second one (72 hours). */
  push: { hours: number; now: boolean } | null;
}

export function decideSiteAlert(state: SiteAlertState | null, siteChangedAt: string | null, now: Date): SiteAlertDecision {
  const changedAt = siteChangedAt ? Date.parse(siteChangedAt) : Number.NaN;
  if (!Number.isFinite(changedAt)) return { next: null, push: null };
  const age = now.getTime() - changedAt;
  if (age < SITE_ALERT_POLICY.change_after_ms || age > SITE_ALERT_POLICY.max_age_ms) return { next: null, push: null };
  const now72 = age >= SITE_ALERT_POLICY.change_now_after_ms;
  const notifiedFor = state?.notified_site_changed_at ? Date.parse(state.notified_site_changed_at) : Number.NaN;
  if (Number.isFinite(notifiedFor) && notifiedFor === changedAt) {
    // This site was pushed already: once more only for the 72-hour push, if the last one came before 72 hours.
    const notifiedAt = state?.notified_at ? Date.parse(state.notified_at) : Number.NaN;
    const secondDone = Number.isFinite(notifiedAt) && notifiedAt - changedAt >= SITE_ALERT_POLICY.change_now_after_ms;
    if (!now72 || secondDone) return { next: null, push: null };
  }
  return {
    next: { notified_site_changed_at: new Date(changedAt).toISOString(), notified_at: now.toISOString() },
    push: { hours: Math.floor(age / 3_600_000), now: now72 },
  };
}

/** "Czas zmienić wkłucie" / "Wkłucie ma już 2 dni i 3 godz. Zmień je dziś."; after 72 hours "Wymień wkłucie teraz" /
 * "Wkłucie ma już 3 dni. Wymień je teraz." */
export function sitePushText(hours: number, now = false): { title: string; body: string } {
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const dayWord = days === 1 ? 'dzień' : 'dni';
  const age = rest === 0 ? `${days} ${dayWord}` : `${days} ${dayWord} i ${rest} godz.`;
  const ageText = `Wkłucie ma już ${age}${age.endsWith('.') ? '' : '.'}`;
  return now ? { title: 'Wymień wkłucie teraz', body: `${ageText} Wymień je teraz.` } : { title: 'Czas zmienić wkłucie', body: `${ageText} Zmień je dziś.` };
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
    const decision = decideSiteAlert(state, siteChangedAt, now);
    if (!decision.next || !decision.push) return false;
    // The claim comes first: a second worker (or this one after a restart) sees the site as pushed already.
    if (!(await this.deps.store.saveSiteState(patientId, state?.revision ?? -1, decision.next))) return false;

    const text = sitePushText(decision.push.hours, decision.push.now);
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
