import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';

/**
 * Pump battery pushes (battery-alerts.v1, owner 2026-11-02), "Bateria pompy" in "Powiadomienia o sprzęcie". Two pushes
 * per charge at most: one when the battery first goes under 25% and one when it goes under 15% (critical). A battery
 * first seen under 15% gets only the critical one. Neither comes again until the battery is charged or replaced (the
 * reading rose by 10 points or more). A pump status older than 6 h is not acted on. On by default, like the reservoir.
 */
export const BATTERY_ALERT_POLICY = {
  version: 'battery-alerts.v1',
  warning_below: 25,
  critical_below: 15,
  recharge_rise_points: 10,
  max_pump_status_age_ms: 6 * 60 * 60_000,
} as const;

export type BatteryLevel = 'warning' | 'critical';

export interface BatteryAlertState {
  patient_id: string;
  notified_level: BatteryLevel | null;
  notified_at: string | null;
  last_percent: number | null;
  revision: number;
}

export interface BatteryObservation {
  percent: number | null;
  /** When the loop app last read the pump. */
  read_at: string | null;
}

export interface BatteryAlertDecision {
  /** The state to store (null: nothing changed). */
  next: Omit<BatteryAlertState, 'patient_id' | 'revision'> | null;
  push: BatteryLevel | null;
  recharged: boolean;
}

const RANK = { normal: 0, warning: 1, critical: 2 } as const;

export function batteryLevel(percent: number): BatteryLevel | 'normal' {
  if (percent < BATTERY_ALERT_POLICY.critical_below) return 'critical';
  if (percent < BATTERY_ALERT_POLICY.warning_below) return 'warning';
  return 'normal';
}

export function decideBatteryAlert(state: BatteryAlertState | null, observation: BatteryObservation, now: Date): BatteryAlertDecision {
  const percent = observation.percent;
  const readAt = observation.read_at ? Date.parse(observation.read_at) : Number.NaN;
  const fresh = Number.isFinite(readAt) && now.getTime() - readAt <= BATTERY_ALERT_POLICY.max_pump_status_age_ms;
  if (percent === null || !fresh) return { next: null, push: null, recharged: false };

  const level = batteryLevel(percent);
  const last = state?.last_percent ?? null;
  const recharged = !!state?.notified_level && last !== null && percent >= last + BATTERY_ALERT_POLICY.recharge_rise_points;

  let notified = recharged ? null : state?.notified_level ?? null;
  let notifiedAt = recharged ? null : state?.notified_at ?? null;
  let push: BatteryLevel | null = null;
  if (level !== 'normal' && RANK[level] > RANK[notified ?? 'normal']) {
    push = level;
    notified = level;
    notifiedAt = now.toISOString();
  }
  // The lowest reading since the last push is the base for "charged": a slow drift up by a point or two is not a charge.
  const lastPercent = notified && !push && last !== null ? Math.min(last, percent) : percent;

  const next = { notified_level: notified, notified_at: notifiedAt, last_percent: lastPercent };
  const unchanged = state
    && state.notified_level === next.notified_level
    && state.notified_at === next.notified_at
    && state.last_percent === next.last_percent;
  return { next: unchanged ? null : next, push, recharged };
}

/** "Słaba bateria pompy" / "Zostało 22%. Naładuj lub wymień baterię." (pump type unknown: AAA or rechargeable). */
export function batteryPushText(level: BatteryLevel, percent: number): { title: string; body: string } {
  const value = `${Math.round(percent)}%`;
  return level === 'critical'
    ? { title: 'Bateria pompy prawie pusta', body: `Zostało ${value}. Naładuj lub wymień baterię jak najszybciej.` }
    : { title: 'Słaba bateria pompy', body: `Zostało ${value}. Naładuj lub wymień baterię.` };
}

export interface BatteryAlertStore {
  /** Patients with at least one phone that has "Bateria pompy" on. */
  listPatientsWithBatteryDevices(): Promise<string[]>;
  listBatteryDevices(patientId: string): Promise<Array<{ device_id: string; push_token: string }>>;
  getBatteryState(patientId: string): Promise<BatteryAlertState | null>;
  /** Stores the state if nobody changed it since `revision` was read (-1: no row yet); false when someone did. */
  saveBatteryState(patientId: string, revision: number, next: NonNullable<BatteryAlertDecision['next']>): Promise<boolean>;
  deactivatePushToken(pushToken: string): Promise<void>;
}

export interface BatteryAlertPush {
  sendBatteryAlert(input: { patientId: string; pushToken: string; level: BatteryLevel; notifiedAt: string; title: string; body: string }): Promise<void>;
}

export class BatteryAlertService {
  constructor(private readonly deps: {
    store: BatteryAlertStore;
    push: BatteryAlertPush;
    dashboard: (patientId: string, now: Date) => Promise<DashboardResponse>;
    log: (event: Record<string, unknown>) => void;
  }) {}

  async run(now: Date): Promise<void> {
    let patients: string[];
    try {
      patients = await this.deps.store.listPatientsWithBatteryDevices();
    } catch (error) {
      this.deps.log({ event: 'battery_alerts_unavailable', error_code: errorCode(error) });
      return;
    }
    for (const patientId of patients) {
      try {
        await this.evaluate(patientId, now);
      } catch (error) {
        this.deps.log({ event: 'battery_alert_failed', patient_id: patientId, error_code: errorCode(error) });
      }
    }
  }

  async evaluate(patientId: string, now: Date): Promise<BatteryLevel | null> {
    const pump = (await this.deps.dashboard(patientId, now)).pump;
    const observation: BatteryObservation = { percent: pump?.battery_percent ?? null, read_at: pump?.last_read_at ?? null };
    const state = await this.deps.store.getBatteryState(patientId);
    const decision = decideBatteryAlert(state, observation, now);
    if (!decision.next) return null;
    // The claim comes first: a second worker (or this one after a restart) sees the level as pushed already.
    if (!(await this.deps.store.saveBatteryState(patientId, state?.revision ?? -1, decision.next))) return null;
    if (decision.recharged) this.deps.log({ event: 'battery_recharged', patient_id: patientId, percent: observation.percent });
    if (!decision.push) return null;

    const text = batteryPushText(decision.push, observation.percent as number);
    const devices = await this.deps.store.listBatteryDevices(patientId);
    let delivered = 0;
    for (const device of devices) {
      try {
        await this.deps.push.sendBatteryAlert({ patientId, pushToken: device.push_token, level: decision.push, notifiedAt: decision.next.notified_at as string, ...text });
        delivered += 1;
      } catch (error) {
        if (error instanceof PushNotificationProviderError && (error.code === 'DEVICE_TOKEN_INVALID' || error.code === 'DEVICE_TOKEN_UNREGISTERED')) {
          await this.deps.store.deactivatePushToken(device.push_token).catch(() => undefined);
        }
        this.deps.log({ event: 'battery_alert_send_failed', patient_id: patientId, error_code: errorCode(error) });
      }
    }
    this.deps.log({ event: 'battery_alert_sent', patient_id: patientId, level: decision.push, percent: observation.percent, devices: devices.length, delivered });
    return decision.push;
  }
}

function errorCode(error: unknown): string {
  if (error instanceof PushNotificationProviderError) return error.code;
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return 'UNKNOWN';
}
