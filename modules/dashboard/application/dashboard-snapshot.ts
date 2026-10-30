/**
 * The Dashboard tab: the latest CGM reading with its trend and 5-minute change, 24 h of readings for the chart and
 * time in range, the pump's battery, reservoir and last contact, and when the infusion site and the sensor were last
 * changed. Colours and thresholds belong to the app; this only shapes the data.
 */

import { readLoopValues } from '@modules/loop-system/application/loop-status';
import { reservoirStatus, type ReservoirLevel } from './reservoir-level';

export const DASHBOARD_HISTORY_HOURS = 24;
/** International Consensus on Time in Range (Battelino et al., Diabetes Care 2019): 70–180 mg/dL. */
export const TIME_IN_RANGE_LOW_MG_DL = 70;
export const TIME_IN_RANGE_HIGH_MG_DL = 180;

/** The change is shown per 5 minutes, like Nightscout; readings this far back can stand in for "5 minutes ago". */
const DELTA_MINUTES = 5;
const DELTA_MIN_GAP_MINUTES = 2.5;
const DELTA_MAX_GAP_MINUTES = 15;

export interface DashboardGlucoseReading {
  at: string;
  value: number;
  /** Nightscout direction as uploaded (Flat, FortyFiveUp, SingleUp, DoubleUp, ...); only the latest one is used. */
  direction: string | null;
}

export interface DashboardDeviceStatus {
  observed_at: string;
  raw_payload: Record<string, unknown>;
}

export interface DashboardCareEvents {
  site_changed_at: string | null;
  sensor_started_at: string | null;
  reservoir_changed_at?: string | null;
  /** The reservoir level right after its last change: 100% of the reservoir bar. */
  reservoir_filled_units?: number | null;
}

export interface DashboardResponse {
  patient_id: string;
  generated_at: string;
  glucose: {
    value: number;
    unit: 'mg/dL';
    direction: string | null;
    observed_at: string;
    /** mg/dL per 5 minutes; null without a reading 2.5–15 minutes before the latest one. */
    delta: number | null;
  } | null;
  /** Oldest first, the last 24 h. */
  readings: Array<{ at: string; value: number }>;
  time_in_range: {
    hours: number;
    readings_count: number;
    low_percent: number;
    in_range_percent: number;
    high_percent: number;
  } | null;
  pump: {
    battery_percent: number | null;
    reservoir_units: number | null;
    /** The level after the last reservoir change (never below the current level); null when unknown. */
    reservoir_full_units: number | null;
    /**
     * How many hours the reservoir lasts at the patient's average daily insulin (reservoir-usage.v1); null without an
     * estimate. Optional: older servers do not send it.
     */
    reservoir_hours_left?: number | null;
    /** The reservoir's colour (reservoir-level.v1); null without a reservoir reading. */
    reservoir_level?: ReservoirLevel | null;
    /** When the loop app last talked to the pump (pump.clock), else when it uploaded the status. */
    last_read_at: string;
  } | null;
  /** Insulin and carbs on board from the loop app's newest calculation. */
  loop: {
    iob_units: number | null;
    cob_grams: number | null;
    observed_at: string;
  } | null;
  /** The last 24 h of insulin for the chart; null when it could not be read. */
  insulin: DashboardInsulin | null;
  site_changed_at: string | null;
  sensor_started_at: string | null;
  /**
   * The server's Nightscout history import (nightscout-history.v1) while it runs: the dashboard shows "Wczytuję
   * historię z Nightscouta… NN%". Absent or null when complete. Optional: older apps ignore it.
   */
  nightscout_history?: { status: 'LOADING'; progress_percent: number } | null;
}

export interface DashboardInsulin {
  boluses: Array<{ at: string; units: number }>;
  smbs: Array<{ at: string; units: number }>;
  /** Delivered basal as runs of one rate (temp basals, the profile in the gaps); rate null when unknown. */
  basal: Array<{ start: string; end: string; rate: number | null }>;
}

export function buildDashboard(input: {
  patientId: string;
  now: Date;
  readings: DashboardGlucoseReading[];
  deviceStatus: DashboardDeviceStatus | null;
  /** Newest devicestatus with the loop's calculation (often the same record as the pump status). */
  loopStatus?: DashboardDeviceStatus | null;
  careEvents: DashboardCareEvents | null;
  insulin?: DashboardInsulin | null;
  /** The patient's average total daily insulin (reservoir-usage.v1); null or absent without an estimate. */
  averageDailyInsulinUnits?: number | null;
}): DashboardResponse {
  const since = input.now.getTime() - DASHBOARD_HISTORY_HOURS * 3_600_000;
  const readings = dedupeByTime(input.readings)
    .filter((reading) => Number.isFinite(reading.value) && reading.value > 0)
    .filter((reading) => Date.parse(reading.at) >= since)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));

  const latest = readings.at(-1) ?? null;

  return {
    patient_id: input.patientId,
    generated_at: input.now.toISOString(),
    glucose: latest
      ? {
        value: Math.round(latest.value),
        unit: 'mg/dL',
        direction: latest.direction,
        observed_at: latest.at,
        delta: deltaPerFiveMinutes(readings),
      }
      : null,
    readings: readings.map((reading) => ({ at: reading.at, value: Math.round(reading.value) })),
    time_in_range: timeInRange(readings),
    pump: pumpStatus(input.deviceStatus, input.careEvents?.reservoir_filled_units ?? null, input.averageDailyInsulinUnits ?? null),
    loop: loopStatus(input.loopStatus ?? null),
    insulin: input.insulin ?? null,
    site_changed_at: input.careEvents?.site_changed_at ?? null,
    sensor_started_at: input.careEvents?.sensor_started_at ?? null,
  };
}

/** The newer of the synced and the live devicestatus among those that carry one of `keys` (e.g. pump, openaps). */
export function newestStatusWith(keys: string[], ...statuses: Array<DashboardDeviceStatus | null | undefined>): DashboardDeviceStatus | null {
  return statuses
    .filter((status): status is DashboardDeviceStatus => !!status && keys.some((key) => key in status.raw_payload))
    .sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at))[0] ?? null;
}

/** Two uploaders (or a re-import) can store the same reading twice; one per timestamp is kept. */
function dedupeByTime(readings: DashboardGlucoseReading[]): DashboardGlucoseReading[] {
  const byTime = new Map<number, DashboardGlucoseReading>();
  for (const reading of readings) {
    const time = Date.parse(reading.at);
    if (Number.isFinite(time) && !byTime.has(time)) {
      byTime.set(time, reading);
    }
  }
  return [...byTime.values()];
}

/** Against the reading closest to 5 minutes earlier, scaled to 5 minutes (1-minute CGMs and gaps alike). */
function deltaPerFiveMinutes(readings: DashboardGlucoseReading[]): number | null {
  const latest = readings.at(-1);
  if (!latest) return null;
  const latestTime = Date.parse(latest.at);

  let best: { reading: DashboardGlucoseReading; minutes: number } | null = null;
  for (const reading of readings.slice(0, -1)) {
    const minutes = (latestTime - Date.parse(reading.at)) / 60_000;
    if (minutes < DELTA_MIN_GAP_MINUTES || minutes > DELTA_MAX_GAP_MINUTES) continue;
    if (!best || Math.abs(minutes - DELTA_MINUTES) < Math.abs(best.minutes - DELTA_MINUTES)) {
      best = { reading, minutes };
    }
  }
  if (!best) return null;

  return Math.round(((latest.value - best.reading.value) * DELTA_MINUTES) / best.minutes);
}

function timeInRange(readings: DashboardGlucoseReading[]): DashboardResponse['time_in_range'] {
  if (readings.length === 0) return null;
  const low = readings.filter((reading) => reading.value < TIME_IN_RANGE_LOW_MG_DL).length;
  const high = readings.filter((reading) => reading.value > TIME_IN_RANGE_HIGH_MG_DL).length;
  const lowPercent = Math.round((low * 100) / readings.length);
  const highPercent = Math.round((high * 100) / readings.length);
  return {
    hours: DASHBOARD_HISTORY_HOURS,
    readings_count: readings.length,
    low_percent: lowPercent,
    // The remainder, so the three parts of the bar always add up to 100.
    in_range_percent: Math.max(0, 100 - lowPercent - highPercent),
    high_percent: highPercent,
  };
}

/** Trio, Loop and AAPS upload `pump: { clock, battery: { percent }, reservoir }`. */
function pumpStatus(status: DashboardDeviceStatus | null, filledUnits: number | null, averageDailyUnits: number | null): DashboardResponse['pump'] {
  if (!status) return null;
  const pump = asRecord(status.raw_payload.pump);
  if (!pump) return null;

  const battery = asRecord(pump.battery);
  const clock = typeof pump.clock === 'string' && Number.isFinite(Date.parse(pump.clock))
    ? new Date(pump.clock).toISOString()
    : status.observed_at;

  const reservoir = plausibleReservoir(finiteNumber(pump.reservoir));
  const fullUnits = filledUnits === null ? null : Math.max(filledUnits, reservoir ?? 0);
  const reservoirNow = reservoirStatus({ units: reservoir, fullUnits, averageDailyUnits });
  return {
    battery_percent: finiteNumber(battery?.percent),
    reservoir_units: reservoir,
    reservoir_full_units: fullUnits,
    reservoir_hours_left: reservoirNow?.hours_left ?? null,
    reservoir_level: reservoirNow?.level ?? null,
    last_read_at: clock,
  };
}

/** Omnipod drivers upload a magic number (e.g. 3995, 5115) for "more than 50 U"; no reservoir holds that much. */
function plausibleReservoir(units: number | null): number | null {
  return units !== null && units >= 0 && units <= 1000 ? units : null;
}

/** IOB (U, two decimals) and COB (whole grams) of one loop calculation; null when it carries neither. */
export function loopValues(payload: Record<string, unknown>): { iob_units: number | null; cob_grams: number | null } | null {
  const { iob_u: iob, cob_g: cob } = readLoopValues(payload);
  if (iob === null && cob === null) return null;
  return {
    iob_units: iob === null ? null : Math.round(iob * 100) / 100,
    cob_grams: cob === null ? null : Math.round(cob),
  };
}

function loopStatus(status: DashboardDeviceStatus | null): DashboardResponse['loop'] {
  if (!status) return null;
  const values = loopValues(status.raw_payload);
  return values ? { ...values, observed_at: status.observed_at } : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}
