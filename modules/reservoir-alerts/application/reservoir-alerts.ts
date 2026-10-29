import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import { formatReservoirDuration, type ReservoirLevel } from '@modules/dashboard/application/reservoir-level';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';

/**
 * Reservoir pushes (reservoir-alerts.v1, owner 2026-10-29). Two pushes per fill at most: one when the reservoir first
 * turns yellow (under 24 h of insulin at the patient's average use, reservoir-level.v1) and one when it turns red
 * (under 8 h). A reservoir first seen red gets only the red one. Neither comes again until the reservoir is refilled:
 * Nightscout has an "Insulin Change" newer than the last push, or the reading rose by 10 U or more. A pump status older
 * than 6 h is not acted on (the pump may be off or replaced). Sent to the phones with "Zbiornik insuliny" on.
 */
export const RESERVOIR_ALERT_POLICY = {
  version: 'reservoir-alerts.v1',
  refill_rise_units: 10,
  max_pump_status_age_ms: 6 * 60 * 60_000,
  tick_ms: 5 * 60_000,
} as const;

export type NotifiedReservoirLevel = Exclude<ReservoirLevel, 'normal'>;

export interface ReservoirAlertState {
  patient_id: string;
  notified_level: NotifiedReservoirLevel | null;
  notified_at: string | null;
  last_units: number | null;
  reservoir_changed_at: string | null;
  revision: number;
}

export interface ReservoirObservation {
  units: number | null;
  level: ReservoirLevel | null;
  hours_left: number | null;
  /** Newest "Insulin Change" in Nightscout; null when unknown. */
  changed_at: string | null;
  /** When the loop app last read the pump. */
  read_at: string | null;
}

export interface ReservoirAlertDecision {
  /** The state to store (null: nothing changed). */
  next: Omit<ReservoirAlertState, 'patient_id' | 'revision'> | null;
  /** The level to push now, if any. */
  push: NotifiedReservoirLevel | null;
  refilled: boolean;
}

const RANK: Record<ReservoirLevel, number> = { normal: 0, warning: 1, alarm: 2 };

export function decideReservoirAlert(state: ReservoirAlertState | null, observation: ReservoirObservation, now: Date): ReservoirAlertDecision {
  const units = observation.units;
  const level = observation.level;
  const readAt = observation.read_at ? Date.parse(observation.read_at) : Number.NaN;
  const fresh = Number.isFinite(readAt) && now.getTime() - readAt <= RESERVOIR_ALERT_POLICY.max_pump_status_age_ms;
  if (units === null || level === null || !fresh) return { next: null, push: null, refilled: false };

  const notifiedAt = state?.notified_at ? Date.parse(state.notified_at) : Number.NaN;
  const changedAt = observation.changed_at ? Date.parse(observation.changed_at) : Number.NaN;
  const changedAfterPush = Number.isFinite(changedAt) && Number.isFinite(notifiedAt) && changedAt > notifiedAt;
  const rose = state?.last_units !== null && state?.last_units !== undefined && units >= state.last_units + RESERVOIR_ALERT_POLICY.refill_rise_units;
  const refilled = !!state?.notified_level && (changedAfterPush || rose);

  let notified = refilled ? null : state?.notified_level ?? null;
  let notifiedAtIso = refilled ? null : state?.notified_at ?? null;
  let push: NotifiedReservoirLevel | null = null;
  if (level !== 'normal' && RANK[level] > (notified ? RANK[notified] : 0)) {
    push = level;
    notified = level;
    notifiedAtIso = now.toISOString();
  }

  const next = {
    notified_level: notified,
    notified_at: notifiedAtIso,
    last_units: units,
    reservoir_changed_at: observation.changed_at ?? state?.reservoir_changed_at ?? null,
  };
  const unchanged = state
    && state.notified_level === next.notified_level
    && state.notified_at === next.notified_at
    && state.last_units === next.last_units
    && sameInstant(state.reservoir_changed_at, next.reservoir_changed_at);
  return { next: unchanged ? null : next, push, refilled };
}

/** The push's title and body: "Insuliny w zbiorniku zostało na ok. 8 godz. (12 j)". */
export function reservoirPushText(level: NotifiedReservoirLevel, units: number, hoursLeft: number | null): { title: string; body: string } {
  const amount = `${formatUnits(units)} j`;
  const body = hoursLeft !== null
    ? `Insuliny w zbiorniku zostało ${formatReservoirDuration(hoursLeft)} (${amount}).`
    : `W zbiorniku zostało ${amount} insuliny.`;
  return { title: level === 'alarm' ? 'Wymień zbiornik insuliny' : 'Kończy się insulina w zbiorniku', body };
}

export interface ReservoirAlertStore {
  /** Patients with at least one phone that has "Zbiornik insuliny" on (and may get glucose alerts). */
  listPatientsWithReservoirDevices(): Promise<string[]>;
  listReservoirDevices(patientId: string): Promise<Array<{ device_id: string; push_token: string }>>;
  getState(patientId: string): Promise<ReservoirAlertState | null>;
  /** Stores the state if nobody changed it since `revision` was read (-1: no row yet); false when someone did. */
  saveState(patientId: string, revision: number, next: NonNullable<ReservoirAlertDecision['next']>, notified: { units: number; hours_left: number | null } | null): Promise<boolean>;
  deactivatePushToken(pushToken: string): Promise<void>;
}

export interface ReservoirAlertPush {
  sendReservoirAlert(input: { patientId: string; pushToken: string; level: NotifiedReservoirLevel; notifiedAt: string; title: string; body: string }): Promise<void>;
}

export class ReservoirAlertService {
  constructor(private readonly deps: {
    store: ReservoirAlertStore;
    push: ReservoirAlertPush;
    dashboard: (patientId: string, now: Date) => Promise<{ dashboard: DashboardResponse; changedAt: string | null }>;
    log: (event: Record<string, unknown>) => void;
  }) {}

  async run(now: Date): Promise<void> {
    let patients: string[];
    try {
      patients = await this.deps.store.listPatientsWithReservoirDevices();
    } catch (error) {
      this.deps.log({ event: 'reservoir_alerts_unavailable', error_code: errorCode(error) });
      return;
    }
    for (const patientId of patients) {
      try {
        await this.evaluate(patientId, now);
      } catch (error) {
        this.deps.log({ event: 'reservoir_alert_failed', patient_id: patientId, error_code: errorCode(error) });
      }
    }
  }

  async evaluate(patientId: string, now: Date): Promise<NotifiedReservoirLevel | null> {
    const { dashboard, changedAt } = await this.deps.dashboard(patientId, now);
    const pump = dashboard.pump;
    const observation: ReservoirObservation = {
      units: pump?.reservoir_units ?? null,
      level: pump?.reservoir_level ?? null,
      hours_left: pump?.reservoir_hours_left ?? null,
      changed_at: changedAt,
      read_at: pump?.last_read_at ?? null,
    };
    const state = await this.deps.store.getState(patientId);
    const decision = decideReservoirAlert(state, observation, now);
    if (!decision.next) return null;
    const notified = decision.push ? { units: observation.units as number, hours_left: observation.hours_left } : null;
    // The claim comes first: a second worker (or this one after a restart) sees the level as pushed already.
    if (!(await this.deps.store.saveState(patientId, state?.revision ?? -1, decision.next, notified))) return null;
    if (decision.refilled) this.deps.log({ event: 'reservoir_refilled', patient_id: patientId, units: observation.units });
    if (!decision.push) return null;

    const text = reservoirPushText(decision.push, observation.units as number, observation.hours_left);
    const devices = await this.deps.store.listReservoirDevices(patientId);
    let delivered = 0;
    for (const device of devices) {
      try {
        await this.deps.push.sendReservoirAlert({ patientId, pushToken: device.push_token, level: decision.push, notifiedAt: decision.next.notified_at as string, ...text });
        delivered += 1;
      } catch (error) {
        if (error instanceof PushNotificationProviderError && (error.code === 'DEVICE_TOKEN_INVALID' || error.code === 'DEVICE_TOKEN_UNREGISTERED')) {
          await this.deps.store.deactivatePushToken(device.push_token).catch(() => undefined);
        }
        this.deps.log({ event: 'reservoir_alert_send_failed', patient_id: patientId, error_code: errorCode(error) });
      }
    }
    this.deps.log({ event: 'reservoir_alert_sent', patient_id: patientId, level: decision.push, units: observation.units, hours_left: observation.hours_left, devices: devices.length, delivered });
    return decision.push;
  }
}

function formatUnits(units: number): string {
  const rounded = Math.round(units * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', ',');
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

function errorCode(error: unknown): string {
  if (error instanceof PushNotificationProviderError) return error.code;
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return 'UNKNOWN';
}
