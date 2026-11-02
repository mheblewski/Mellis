import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import { trendArrow } from '@modules/remote-commands/application/bolus-reminders';

/**
 * Glucose pushes (glucose-alerts.v1, owner 2026-11-02), "Powiadomienia o glikemii" in the phone's settings, off by
 * default. Each new reading is judged once, while it is under 10 minutes old:
 * - under 70: red "❗", "Glukoza nisko" (", rośnie" / ", spada" by the arrow);
 * - 70–79 and falling: yellow "⚠️", "Glukoza spada";
 * - over 160 / 180 / 250 and rising: yellow "⚠️", "Glukoza rośnie" / "Glukoza wysoko, rośnie" / "Glukoza bardzo wysoko, rośnie";
 * - two arrows (⇈ / ⇊): "Glukoza szybko rośnie / spada" as the title;
 * - no reading for 10 minutes: "Brak danych", then every 5 minutes while none comes.
 * Rising and falling follow the arrow the app shows (Nightscout's direction, else the 5-minute change). A phone gets at
 * most one push per reading (the first kind of PRIORITY it has on). A kind comes again on a phone only after that
 * phone's repeat interval ("Powtarzaj co", 5–60 minutes, one for a low and one for the rest; 15 and 30 by default),
 * and not while a stronger kind of the same direction was pushed to it in that interval.
 */
export const GLUCOSE_ALERT_POLICY = {
  version: 'glucose-alerts.v1',
  low_below: 70,
  falling_below: 80,
  rising_above: 160,
  high_above: 180,
  very_high_above: 250,
  no_data_after_ms: 10 * 60_000,
  no_data_repeat_ms: 5 * 60_000,
  repeat_grace_ms: 90_000,
  tick_ms: 60_000,
} as const;

export type GlucoseAlertKind = 'low' | 'fast_fall' | 'fast_rise' | 'very_high' | 'high' | 'rising' | 'falling';

/** The switches inside the section; 'fast' covers both directions. */
export type GlucoseAlertSetting = 'low' | 'falling' | 'rising' | 'high' | 'very_high' | 'fast' | 'no_data';
export const GLUCOSE_ALERT_SETTINGS: readonly GlucoseAlertSetting[] = ['low', 'falling', 'rising', 'high', 'very_high', 'fast', 'no_data'];

/** Which kind wins when several hold for one reading. */
const PRIORITY: GlucoseAlertKind[] = ['low', 'fast_fall', 'fast_rise', 'very_high', 'high', 'rising', 'falling'];

/** Stronger kinds of the same direction: a push of one of them in the window keeps the weaker one quiet. */
const STRONGER: Record<GlucoseAlertKind, GlucoseAlertKind[]> = {
  low: [],
  falling: ['low'],
  fast_fall: [],
  fast_rise: [],
  very_high: [],
  high: ['very_high'],
  rising: ['high', 'very_high'],
};

const SETTING_OF: Record<GlucoseAlertKind, GlucoseAlertSetting> = {
  low: 'low', falling: 'falling', rising: 'rising', high: 'high', very_high: 'very_high', fast_rise: 'fast', fast_fall: 'fast',
};

/** Repeat intervals a phone can pick ("Powtarzaj co"), in minutes. */
export const GLUCOSE_ALERT_REPEAT_MINUTES = [5, 10, 15, 20, 30, 60] as const;

export interface GlucoseAlertState {
  patient_id: string;
  last_reading_at: string | null;
  /** Per phone (push token): when each kind was last pushed to it. */
  sent: Record<string, Partial<Record<GlucoseAlertKind, string>>>;
  no_data_sent_at: string | null;
  revision: number;
}

export interface GlucoseAlertDevice {
  device_id: string;
  push_token: string;
  /** The section's kinds this phone turned off. */
  kinds_off: GlucoseAlertSetting[];
  /** "Niska glukoza — powtarzaj co" (minutes). */
  low_repeat_minutes: number;
  /** "Pozostałe — powtarzaj co" (minutes). */
  repeat_minutes: number;
}

export interface GlucoseObservation {
  value: number;
  observed_at: string;
  direction: string | null;
  /** mg/dL per 5 minutes. */
  delta: number | null;
  iob_units: number | null;
  cob_grams: number | null;
}

type NextState = Omit<GlucoseAlertState, 'patient_id' | 'revision'>;

export type GlucoseAlertDecision =
  | { type: 'none'; next: NextState | null }
  | { type: 'glucose'; next: NextState; pushes: Array<{ device: GlucoseAlertDevice; kind: GlucoseAlertKind }> }
  | { type: 'no_data'; next: NextState; minutes: number };

type Trend = 'rising' | 'falling' | 'flat' | null;

function trendOf(arrow: string | null): Trend {
  if (arrow === '⇈' || arrow === '↑' || arrow === '↗') return 'rising';
  if (arrow === '⇊' || arrow === '↓' || arrow === '↘') return 'falling';
  if (arrow === '→') return 'flat';
  return null;
}

/** The kinds that hold for this reading, strongest first. */
export function activeGlucoseKinds(observation: Pick<GlucoseObservation, 'value' | 'direction' | 'delta'>): GlucoseAlertKind[] {
  const arrow = trendArrow(observation.direction, observation.delta);
  const trend = trendOf(arrow);
  const value = observation.value;
  const p = GLUCOSE_ALERT_POLICY;
  const kinds: GlucoseAlertKind[] = [];
  if (value < p.low_below) kinds.push('low');
  if (arrow === '⇊') kinds.push('fast_fall');
  if (arrow === '⇈') kinds.push('fast_rise');
  if (trend === 'rising') {
    if (value > p.very_high_above) kinds.push('very_high');
    else if (value > p.high_above) kinds.push('high');
    else if (value > p.rising_above) kinds.push('rising');
  }
  if (trend === 'falling' && value >= p.low_below && value < p.falling_below) kinds.push('falling');
  return PRIORITY.filter((kind) => kinds.includes(kind));
}

/**
 * The phone's repeat window for a kind, less a minute and a half: readings come every 5 minutes but are judged on the
 * minute tick, so "every 5 minutes" must not miss a reading that was judged a few seconds early.
 */
function repeatMs(kind: GlucoseAlertKind, device: GlucoseAlertDevice): number {
  const minutes = kind === 'low' ? device.low_repeat_minutes : device.repeat_minutes;
  return minutes * 60_000 - GLUCOSE_ALERT_POLICY.repeat_grace_ms;
}

function sentWithin(sent: Partial<Record<GlucoseAlertKind, string>>, kind: GlucoseAlertKind, windowMs: number, now: Date): boolean {
  const at = sent[kind] ? Date.parse(sent[kind] as string) : Number.NaN;
  return Number.isFinite(at) && now.getTime() - at < windowMs;
}

export function decideGlucoseAlert(state: GlucoseAlertState | null, observation: GlucoseObservation | null, devices: GlucoseAlertDevice[], now: Date): GlucoseAlertDecision {
  const base: NextState = {
    last_reading_at: state?.last_reading_at ?? null,
    sent: state?.sent ?? {},
    no_data_sent_at: state?.no_data_sent_at ?? null,
  };
  // Nothing in the last 24 h: the patient has no sensor data at all, not a gap to warn about.
  if (!observation) return { type: 'none', next: null };

  const readAt = Date.parse(observation.observed_at);
  const age = now.getTime() - readAt;
  if (!Number.isFinite(readAt)) return { type: 'none', next: null };

  if (age >= GLUCOSE_ALERT_POLICY.no_data_after_ms) {
    const lastNoData = base.no_data_sent_at ? Date.parse(base.no_data_sent_at) : Number.NaN;
    // A push for an older gap (before the reading we have) does not count.
    const forThisGap = Number.isFinite(lastNoData) && lastNoData > readAt;
    if (forThisGap && now.getTime() - lastNoData < GLUCOSE_ALERT_POLICY.no_data_repeat_ms) return { type: 'none', next: null };
    return { type: 'no_data', next: { ...base, no_data_sent_at: now.toISOString() }, minutes: Math.floor(age / 60_000) };
  }

  const lastJudged = base.last_reading_at ? Date.parse(base.last_reading_at) : Number.NaN;
  if (Number.isFinite(lastJudged) && readAt <= lastJudged) return { type: 'none', next: null };

  const active = activeGlucoseKinds(observation);
  const sent: NextState['sent'] = {};
  const pushes: Array<{ device: GlucoseAlertDevice; kind: GlucoseAlertKind }> = [];
  for (const device of devices) {
    const own = { ...(base.sent[device.push_token] ?? {}) };
    const due = active.filter((kind) =>
      !device.kinds_off.includes(SETTING_OF[kind])
      && !sentWithin(own, kind, repeatMs(kind, device), now)
      && !STRONGER[kind].some((stronger) => sentWithin(own, stronger, repeatMs(kind, device), now)));
    if (due.length > 0) {
      pushes.push({ device, kind: due[0]! });
      // Every kind due now counts as told: the push says the same, so the next reading does not repeat it.
      for (const kind of due) own[kind] = now.toISOString();
    }
    // Only phones still on keep an entry (a phone turned off starts afresh).
    if (Object.keys(own).length > 0) sent[device.push_token] = own;
  }
  const next = { ...base, last_reading_at: observation.observed_at, sent };
  return pushes.length > 0 ? { type: 'glucose', next, pushes } : { type: 'none', next };
}

/**
 * "❗ 65 ↘ −4" / "Glukoza nisko, spada" + "IOB 1,2 j · COB 15 g"; a fast change has "Glukoza szybko spada" as the title
 * and the glucose in the body.
 */
export function glucosePushText(kind: GlucoseAlertKind, observation: GlucoseObservation): { title: string; body: string } {
  const arrow = trendArrow(observation.direction, observation.delta);
  const reading = [String(Math.round(observation.value)), arrow, formatDelta(observation.delta)].filter(Boolean).join(' ');
  const loop = loopLine(observation);
  const lines = (first: string) => [first, loop].filter(Boolean).join('\n');
  switch (kind) {
    case 'fast_rise': return { title: 'Glukoza szybko rośnie', body: lines(reading) };
    case 'fast_fall': return { title: 'Glukoza szybko spada', body: lines(reading) };
    case 'low': {
      const trend = trendOf(arrow);
      const suffix = trend === 'rising' ? ', rośnie' : trend === 'falling' ? ', spada' : '';
      return { title: `❗ ${reading}`, body: lines(`Glukoza nisko${suffix}`) };
    }
    case 'falling': return { title: `⚠️ ${reading}`, body: lines('Glukoza spada') };
    case 'rising': return { title: `⚠️ ${reading}`, body: lines('Glukoza rośnie') };
    case 'high': return { title: `⚠️ ${reading}`, body: lines('Glukoza wysoko, rośnie') };
    case 'very_high': return { title: `⚠️ ${reading}`, body: lines('Glukoza bardzo wysoko, rośnie') };
  }
}

/** "Brak pomiarów od 12 min." / "Brak pomiarów od 1 godz. 5 min." */
export function noDataPushText(minutes: number): { title: string; body: string } {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const span = hours === 0 ? `${minutes} min` : rest === 0 ? `${hours} godz.` : `${hours} godz. ${rest} min`;
  return { title: 'Brak danych', body: `Brak pomiarów od ${span}${span.endsWith('.') ? '' : '.'}` };
}

function formatDelta(delta: number | null): string | null {
  if (delta === null || !Number.isFinite(delta)) return null;
  const rounded = Math.round(delta);
  if (rounded === 0) return '±0';
  return rounded > 0 ? `+${rounded}` : `−${Math.abs(rounded)}`;
}

function loopLine(observation: GlucoseObservation): string | null {
  const parts: string[] = [];
  if (observation.iob_units !== null) parts.push(`IOB ${formatDecimal(observation.iob_units)} j`);
  if (observation.cob_grams !== null) parts.push(`COB ${Math.round(observation.cob_grams)} g`);
  return parts.length ? parts.join(' · ') : null;
}

function formatDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(1).replace('.', ',');
}

export interface GlucoseAlertStore {
  listPatientsWithGlucoseAlertDevices(): Promise<string[]>;
  listGlucoseAlertDevices(patientId: string): Promise<GlucoseAlertDevice[]>;
  getState(patientId: string): Promise<GlucoseAlertState | null>;
  /** Stores the state if nobody changed it since `revision` was read (-1: no row yet); false when someone did. */
  saveState(patientId: string, revision: number, next: Omit<GlucoseAlertState, 'patient_id' | 'revision'>): Promise<boolean>;
  deactivatePushToken(pushToken: string): Promise<void>;
}

export interface GlucoseAlertPush {
  sendGlucoseAlert(input: { patientId: string; pushToken: string; kind: string; urgent: boolean; title: string; body: string }): Promise<void>;
}

export function observationFromDashboard(dashboard: DashboardResponse): GlucoseObservation | null {
  const glucose = dashboard.glucose;
  if (!glucose) return null;
  return {
    value: glucose.value,
    observed_at: glucose.observed_at,
    direction: glucose.direction,
    delta: glucose.delta,
    iob_units: dashboard.loop?.iob_units ?? null,
    cob_grams: dashboard.loop?.cob_grams ?? null,
  };
}

export class GlucoseAlertService {
  constructor(private readonly deps: {
    store: GlucoseAlertStore;
    push: GlucoseAlertPush;
    dashboard: (patientId: string, now: Date) => Promise<DashboardResponse>;
    log: (event: Record<string, unknown>) => void;
  }) {}

  async run(now: Date): Promise<void> {
    let patients: string[];
    try {
      patients = await this.deps.store.listPatientsWithGlucoseAlertDevices();
    } catch (error) {
      this.deps.log({ event: 'glucose_alerts_unavailable', error_code: errorCode(error) });
      return;
    }
    for (const patientId of patients) {
      try {
        await this.evaluate(patientId, now);
      } catch (error) {
        this.deps.log({ event: 'glucose_alert_failed', patient_id: patientId, error_code: errorCode(error) });
      }
    }
  }

  async evaluate(patientId: string, now: Date): Promise<GlucoseAlertDecision['type']> {
    const observation = observationFromDashboard(await this.deps.dashboard(patientId, now));
    const [state, devices] = await Promise.all([this.deps.store.getState(patientId), this.deps.store.listGlucoseAlertDevices(patientId)]);
    const decision = decideGlucoseAlert(state, observation, devices, now);
    if (!decision.next) return 'none';
    // The claim comes first: a second worker (or this one after a restart) sees the reading as judged already.
    if (!(await this.deps.store.saveState(patientId, state?.revision ?? -1, decision.next))) return 'none';
    if (decision.type === 'none') return 'none';

    const pushes = decision.type === 'no_data'
      ? devices.filter((device) => !device.kinds_off.includes('no_data')).map((device) => ({ device, kind: 'no_data', text: noDataPushText(decision.minutes) }))
      : decision.pushes.map(({ device, kind }) => ({ device, kind, text: glucosePushText(kind, observation as GlucoseObservation) }));
    const sent: Array<{ device_id: string; kind: string }> = [];
    for (const { device, kind, text } of pushes) {
      try {
        await this.deps.push.sendGlucoseAlert({ patientId, pushToken: device.push_token, kind, urgent: kind === 'low' || kind === 'fast_fall', ...text });
        sent.push({ device_id: device.device_id, kind });
      } catch (error) {
        if (error instanceof PushNotificationProviderError && (error.code === 'DEVICE_TOKEN_INVALID' || error.code === 'DEVICE_TOKEN_UNREGISTERED')) {
          await this.deps.store.deactivatePushToken(device.push_token).catch(() => undefined);
        }
        this.deps.log({ event: 'glucose_alert_send_failed', patient_id: patientId, error_code: errorCode(error) });
      }
    }
    this.deps.log({
      event: 'glucose_alert_sent',
      patient_id: patientId,
      type: decision.type,
      ...(decision.type === 'glucose' ? { value: observation?.value, direction: observation?.direction } : { minutes: decision.minutes }),
      devices: devices.length,
      sent,
    });
    return decision.type;
  }
}

function errorCode(error: unknown): string {
  if (error instanceof PushNotificationProviderError) return error.code;
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return 'UNKNOWN';
}
