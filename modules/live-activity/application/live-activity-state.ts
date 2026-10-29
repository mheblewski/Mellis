import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';

/**
 * The glucose Live Activity's content (ActivityKit `content-state`, decoded by the app's GlucoseActivityAttributes
 * .ContentState: the keys must match). Times are seconds since 1970. The app colours it with the dashboard's own
 * thresholds, so this only carries values; the equipment's raw values let it say what is due, as the dashboard does.
 * Kept small: ActivityKit pushes are at most 4 KB.
 */
export interface LiveActivityContentState {
  glucose: number | null;
  direction: string | null;
  /** mg/dL per 5 minutes. */
  delta: number | null;
  readingAt: number | null;
  iob: number | null;
  cob: number | null;
  reservoir: number | null;
  reservoirFull: number | null;
  battery: number | null;
  siteChangedAt: number | null;
  sensorStartedAt: number | null;
  /** The last 2 h of readings, [seconds since 1970, mg/dL], oldest first (the expanded island's chart). */
  readings: Array<[number, number]>;
  /** Boluses of the last 2 h, [seconds since 1970, units]. */
  boluses: Array<[number, number]>;
  /** "Dynamic Island": false draws nothing in the island (the lock screen keeps everything). */
  islandEnabled: boolean;
  /**
   * The patient the fields above belong to (migration 094). The app prefers these over the activity's attributes, so a
   * patient dropping out of a two-patient activity needs no restart. Older apps ignore them.
   */
  patientID?: string;
  patientName?: string;
  /** The second patient (two-patient activity); absent with one patient. */
  others?: LiveActivityPatientReading[];
  /** Two patients: 'both' (one glucose each side of the island) or 'closer' (the one closer to danger, with IOB). */
  islandMode?: LiveActivityIslandMode;
  /** 'both': the patient on the left of the island. */
  islandLeft?: string;
}

export type LiveActivityIslandMode = 'both' | 'closer';

/** Another patient's glance: what the two-patient lock screen and island show (no chart: small pushes). */
export interface LiveActivityPatientReading {
  id: string;
  name: string;
  glucose: number | null;
  direction: string | null;
  delta: number | null;
  readingAt: number | null;
  iob: number | null;
}

export interface LiveActivityPatientInput {
  id: string;
  name: string;
  dashboard: DashboardResponse;
}

export interface LiveActivityAttributes {
  patientID: string;
  patientName: string;
}

/** The type name ActivityKit starts a push-to-start activity with (the app's Swift struct). */
export const LIVE_ACTIVITY_ATTRIBUTES_TYPE = 'GlucoseActivityAttributes';

const CHART_SECONDS = 2 * 3_600;
/** After this long without a new reading iOS shows the activity as stale (the app greys the value). */
export const LIVE_ACTIVITY_STALE_AFTER_SECONDS = 15 * 60;

export interface LiveActivityStateOptions {
  islandEnabled?: boolean;
  /** The patient of `dashboard` (sent so the app can show it without restarting the activity). */
  patient?: { id: string; name: string };
  /** The second patient: the state then carries no chart (the two-patient layouts have none). */
  others?: LiveActivityPatientInput[];
  islandMode?: LiveActivityIslandMode;
  islandLeft?: string | null;
}

export function buildLiveActivityContentState(dashboard: DashboardResponse, now: Date, options: LiveActivityStateOptions = {}): LiveActivityContentState {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const from = nowSeconds - CHART_SECONDS;
  const others = (options.others ?? []).slice(0, 1);
  const two = others.length > 0;
  const state: LiveActivityContentState = {
    glucose: dashboard.glucose?.value ?? null,
    direction: dashboard.glucose?.direction ?? null,
    delta: dashboard.glucose?.delta ?? null,
    readingAt: seconds(dashboard.glucose?.observed_at),
    iob: round(dashboard.loop?.iob_units, 2),
    cob: round(dashboard.loop?.cob_grams, 0),
    reservoir: round(dashboard.pump?.reservoir_units, 1),
    reservoirFull: round(dashboard.pump?.reservoir_full_units, 0),
    battery: round(dashboard.pump?.battery_percent, 0),
    siteChangedAt: seconds(dashboard.site_changed_at),
    sensorStartedAt: seconds(dashboard.sensor_started_at),
    readings: two
      ? []
      : dashboard.readings
          .map((reading): [number, number] => [seconds(reading.at) ?? 0, Math.round(reading.value)])
          .filter(([at]) => at >= from),
    boluses: two
      ? []
      : (dashboard.insulin?.boluses ?? [])
          .map((dose): [number, number] => [seconds(dose.at) ?? 0, Math.round(dose.units * 100) / 100])
          .filter(([at, units]) => at >= from && units > 0),
    islandEnabled: options.islandEnabled ?? true,
  };
  if (options.patient) {
    state.patientID = options.patient.id;
    state.patientName = options.patient.name;
  }
  if (two) {
    state.others = others.map((other) => ({
      id: other.id,
      name: other.name,
      glucose: other.dashboard.glucose?.value ?? null,
      direction: other.dashboard.glucose?.direction ?? null,
      delta: other.dashboard.glucose?.delta ?? null,
      readingAt: seconds(other.dashboard.glucose?.observed_at),
      iob: round(other.dashboard.loop?.iob_units, 2),
    }));
    state.islandMode = options.islandMode ?? 'both';
    const ids = [options.patient?.id, ...others.map((other) => other.id)];
    state.islandLeft = options.islandLeft && ids.includes(options.islandLeft) ? options.islandLeft : (options.patient?.id ?? others[0].id);
  }
  return state;
}

/** The `aps` of an update: the new content, stale 15 min after its reading. */
export function liveActivityUpdateAps(state: LiveActivityContentState, now: Date): Record<string, unknown> {
  return {
    timestamp: Math.floor(now.getTime() / 1000),
    event: 'update',
    'content-state': state,
    ...staleDate(state),
  };
}

/**
 * The `aps` of a push-to-start: iOS requires an alert with it. It is quiet (no sound) and says only that the glucose
 * is on the lock screen again; it comes about every 8 hours, when iOS has ended the previous activity.
 */
export function liveActivityStartAps(state: LiveActivityContentState, attributes: LiveActivityAttributes, now: Date, secondName?: string): Record<string, unknown> {
  return {
    timestamp: Math.floor(now.getTime() / 1000),
    event: 'start',
    'content-state': state,
    'attributes-type': LIVE_ACTIVITY_ATTRIBUTES_TYPE,
    attributes,
    alert: { title: secondName ? `${attributes.patientName} i ${secondName}` : attributes.patientName, body: 'Glukoza znów na ekranie blokady' },
    ...staleDate(state),
  };
}

/** The `aps` that ends an activity at once (a newer one replaced it, or the switch was turned off). */
export function liveActivityEndAps(state: LiveActivityContentState | null, now: Date): Record<string, unknown> {
  const timestamp = Math.floor(now.getTime() / 1000);
  return {
    timestamp,
    event: 'end',
    'dismissal-date': timestamp,
    ...(state ? { 'content-state': state } : {}),
  };
}

/** Stale once the newest reading of every patient shown is old (each patient greys on its own in the app). */
function staleDate(state: LiveActivityContentState): Record<string, number> {
  const newest = Math.max(...[state.readingAt, ...(state.others ?? []).map((other) => other.readingAt)].map((at) => at ?? 0));
  return newest > 0 ? { 'stale-date': newest + LIVE_ACTIVITY_STALE_AFTER_SECONDS } : {};
}

function seconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function round(value: number | null | undefined, digits: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
