import { normalizeTimeRangeRequest } from './time-range-normalization';

/**
 * Synthetic three-day scenario for conversation.time_range_analysis. Every value is invented; nothing here comes from
 * a real patient. OFFLINE FIXTURE / GENERATOR ONLY: it builds in-memory rows and imports no database client; it is
 * not a seed script and writes nothing anywhere. All times derive from an explicit reference instant (the moment the
 * user asks), never from the clock. Contract checks against the real normalizers and hypo detector live in
 * time-range-synthetic-scenario.fixture.spec.ts; the answer rubric (buildTimeRangeEvidenceGroundTruth in
 * modules/ai-gateway/evaluation/time-range-evidence-rubric.ts) derives the ground truth from it.
 *
 * Layout in local time (minutes from the local midnight that starts the range, i.e. "two days before the request"):
 * - day 1 and day 3: stable CGM around 110 mg/dL;
 * - day 2 ("yesterday"): 06:30 temp basal 0.8 U/h for 45 min, 07:45 bolus 4 U, 08:00 carbs 45 g, rise to 210 at
 *   09:30, 11:00 correction bolus 2 U, fall to 55 (hypo 11:40-12:20, nadir 11:50-12:05), 11:45 temp basal 0 U/h for
 *   30 min, recovery to 110 by 13:00, CGM gap 15:00-16:30;
 * - no activity, device status (IOB/COB), current state or therapy profile at all.
 * Minute offsets are exact local wall-clock times only when the range does not cross a DST change.
 */

export const SYNTHETIC_SCENARIO_PATIENT_ID = '11111111-1111-4111-8111-111111111111';
export const SYNTHETIC_SCENARIO_TIMEZONE = 'Europe/Warsaw';
export const SYNTHETIC_SCENARIO_REFERENCE_REQUESTED_AT = '2026-10-14T16:00:00.000Z'; // 18:00 in Europe/Warsaw
export const SYNTHETIC_SCENARIO_USER_MESSAGE = 'Jak wyglądał mój cukier przez ostatnie 3 dni?';
export const SYNTHETIC_SCENARIO_RANGE_TYPE = 'SHORT_RANGE' as const;

const CGM_INTERVAL_MINUTES = 5;
const DAY = 24 * 60;
const YESTERDAY = DAY; // day 2 starts one day after the range start

/** Day-2 wall-clock minutes of the scenario's notable moments. */
export const SYNTHETIC_SCENARIO_MOMENTS = {
  tempBasalMorning: YESTERDAY + 6 * 60 + 30,
  bolusMeal: YESTERDAY + 7 * 60 + 45,
  carbs: YESTERDAY + 8 * 60,
  peak: YESTERDAY + 9 * 60 + 30,
  correctionBolus: YESTERDAY + 11 * 60,
  hypoStart: YESTERDAY + 11 * 60 + 40,
  tempBasalSuspend: YESTERDAY + 11 * 60 + 45,
  nadirStart: YESTERDAY + 11 * 60 + 50,
  nadirEnd: YESTERDAY + 12 * 60 + 5,
  hypoEnd: YESTERDAY + 12 * 60 + 20,
  recovered: YESTERDAY + 13 * 60,
  cgmGapLastReading: YESTERDAY + 15 * 60,
  cgmGapNextReading: YESTERDAY + 16 * 60 + 30,
} as const;

export interface SyntheticGlucoseReading {
  minute: number;
  occurred_at: string;
  glucose_value: number;
}

export interface SyntheticEventRow {
  id: string;
  patient_id: string;
  source_record_id: string;
  type: 'GLUCOSE_READING_AVAILABLE' | 'BOLUS' | 'CARB_ENTRY' | 'TEMP_BASAL';
  occurred_at: string;
  recorded_at: string;
  source: Record<string, unknown>;
  context: Record<string, unknown>;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface SyntheticHypoEpisodeRow {
  id: string;
  patient_id: string;
  trigger_id: string;
  start_event_id: string;
  latest_event_id: string;
  state: 'CLOSED';
  severity: 'L1';
  started_at: string;
  ended_at: string;
  rule_version: string;
}

export interface TimeRangeSyntheticScenario {
  patient_id: string;
  timezone: string;
  range_type: typeof SYNTHETIC_SCENARIO_RANGE_TYPE;
  user_message: string;
  requested_at: string;
  range_start: string;
  range_end: string;
  /** Local midnight of scenario day 1 (the day after range_start): scenario minutes count from here. */
  scenario_start: string;
  normalization_policy_version: string;
  glucose_readings: SyntheticGlucoseReading[];
  /** Event rows shaped like `events` (ordered by occurred_at), payloads as the Nightscout normalizers write them. */
  events: SyntheticEventRow[];
  /** Shaped like `hypo_episodes`; a DB seed must create it through the hypo pipeline (it needs a trigger row). */
  hypo_episodes: SyntheticHypoEpisodeRow[];
  cgm_gap: { last_reading_before: string; first_reading_after: string };
}

/** Deterministic UUID-shaped ids, distinct per kind, so a later seed can find and remove exactly these rows. */
function syntheticId(kind: number, index: number): string {
  return `5e${kind.toString(16).padStart(2, '0')}0000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function interpolate(minute: number, fromMinute: number, fromValue: number, toMinute: number, toValue: number): number {
  return Math.round(fromValue + ((toValue - fromValue) * (minute - fromMinute)) / (toMinute - fromMinute));
}

/** Synthetic CGM curve in mg/dL. */
export function syntheticGlucoseAt(minute: number): number {
  const m = SYNTHETIC_SCENARIO_MOMENTS;
  if (minute >= m.carbs && minute <= m.peak) return interpolate(minute, m.carbs, 110, m.peak, 210);
  if (minute > m.peak && minute <= m.correctionBolus) return interpolate(minute, m.peak, 210, m.correctionBolus, 180);
  if (minute > m.correctionBolus && minute <= m.hypoStart) return interpolate(minute, m.correctionBolus, 180, m.hypoStart, 62);
  if (minute > m.hypoStart && minute <= m.nadirStart) return interpolate(minute, m.hypoStart, 62, m.nadirStart, 55);
  if (minute > m.nadirStart && minute <= m.nadirEnd) return 55;
  if (minute > m.nadirEnd && minute <= m.recovered) return interpolate(minute, m.nadirEnd, 55, m.recovered, 110);
  // Stable periods: a small deterministic 108/110/112 pattern.
  return 110 + ((((Math.floor(minute / CGM_INTERVAL_MINUTES) % 3) + 3) % 3) - 1) * 2;
}

function isInCgmGap(minute: number): boolean {
  return minute > SYNTHETIC_SCENARIO_MOMENTS.cgmGapLastReading && minute < SYNTHETIC_SCENARIO_MOMENTS.cgmGapNextReading;
}

export function buildTimeRangeSyntheticScenario(options: { requestedAt?: string; patientId?: string } = {}): TimeRangeSyntheticScenario {
  const requestedAt = options.requestedAt ?? SYNTHETIC_SCENARIO_REFERENCE_REQUESTED_AT;
  const patientId = options.patientId ?? SYNTHETIC_SCENARIO_PATIENT_ID;
  const normalized = normalizeTimeRangeRequest({
    range_type: SYNTHETIC_SCENARIO_RANGE_TYPE,
    requested_at: requestedAt,
    timezone: SYNTHETIC_SCENARIO_TIMEZONE,
  });
  if (normalized.status !== 'OK') {
    throw new Error(`Synthetic scenario range could not be normalized: ${normalized.reason}`);
  }

  // Scenario minutes count from day 1 of the scenario, the day after the range start: the 3-day range also holds one
  // more complete day before it, with stable CGM only.
  const rangeStartMs = Date.parse(normalized.value.range_start);
  const scenarioStartMs = rangeStartMs + 24 * 60 * 60_000;
  const firstMinute = -24 * 60;
  const requestedAtMs = Date.parse(requestedAt);
  const at = (minute: number) => new Date(scenarioStartMs + minute * 60_000).toISOString();
  const lastMinute = Math.floor((requestedAtMs - scenarioStartMs) / 60_000) - CGM_INTERVAL_MINUTES;
  if (lastMinute < SYNTHETIC_SCENARIO_MOMENTS.recovered) {
    throw new Error('Synthetic scenario needs the request after the day-2 recovery (13:05 local time on day 2)');
  }

  const glucoseReadings: SyntheticGlucoseReading[] = [];
  for (let minute = firstMinute; minute <= lastMinute; minute += CGM_INTERVAL_MINUTES) {
    if (!isInCgmGap(minute)) {
      glucoseReadings.push({ minute, occurred_at: at(minute), glucose_value: syntheticGlucoseAt(minute) });
    }
  }

  const row = (kind: number, index: number, type: SyntheticEventRow['type'], minute: number, payload: Record<string, unknown>): SyntheticEventRow => ({
    id: syntheticId(kind, index),
    patient_id: patientId,
    source_record_id: syntheticId(kind + 0x10, index),
    type,
    occurred_at: at(minute),
    recorded_at: at(minute),
    source: { source_system: 'SYNTHETIC', normalization_version: 'synthetic-scenario.v1' },
    context: {},
    payload,
    created_at: at(minute),
  });

  const glucoseRows = glucoseReadings.map((reading, index) =>
    row(0x01, index, 'GLUCOSE_READING_AVAILABLE', reading.minute, { glucose_value: reading.glucose_value, glucose_unit: 'mg/dL' }));
  const treatmentRows = [
    row(0x02, 0, 'BOLUS', SYNTHETIC_SCENARIO_MOMENTS.bolusMeal, { insulin_units: 4, source_event_type: 'Bolus' }),
    row(0x03, 0, 'CARB_ENTRY', SYNTHETIC_SCENARIO_MOMENTS.carbs, { carbs: 45, source_event_type: 'Carb Correction' }),
    row(0x02, 1, 'BOLUS', SYNTHETIC_SCENARIO_MOMENTS.correctionBolus, { insulin_units: 2, source_event_type: 'Bolus' }),
    // TEMP_BASAL payload exactly as the treatment normalizer writes it (rate, absolute, duration_minutes).
    row(0x06, 0, 'TEMP_BASAL', SYNTHETIC_SCENARIO_MOMENTS.tempBasalMorning, { rate: 0.8, absolute: 0.8, duration_minutes: 45, source_event_type: 'Temp Basal' }),
    row(0x06, 1, 'TEMP_BASAL', SYNTHETIC_SCENARIO_MOMENTS.tempBasalSuspend, { rate: 0, absolute: 0, duration_minutes: 30, source_event_type: 'Temp Basal' }),
  ];
  const events = [...glucoseRows, ...treatmentRows].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id));

  const glucoseRowAt = (minute: number) => {
    const found = glucoseRows.find((candidate) => candidate.occurred_at === at(minute));
    if (!found) throw new Error(`Synthetic scenario has no CGM reading at minute ${minute}`);
    return found;
  };

  return {
    patient_id: patientId,
    timezone: SYNTHETIC_SCENARIO_TIMEZONE,
    range_type: SYNTHETIC_SCENARIO_RANGE_TYPE,
    user_message: SYNTHETIC_SCENARIO_USER_MESSAGE,
    requested_at: requestedAt,
    range_start: normalized.value.range_start,
    range_end: normalized.value.range_end,
    scenario_start: new Date(scenarioStartMs).toISOString(),
    normalization_policy_version: normalized.value.normalization_policy_version,
    glucose_readings: glucoseReadings,
    events,
    hypo_episodes: [{
      id: syntheticId(0x04, 0),
      patient_id: patientId,
      trigger_id: syntheticId(0x05, 0),
      start_event_id: glucoseRowAt(SYNTHETIC_SCENARIO_MOMENTS.hypoStart).id,
      latest_event_id: glucoseRowAt(SYNTHETIC_SCENARIO_MOMENTS.hypoEnd).id,
      state: 'CLOSED',
      severity: 'L1',
      started_at: at(SYNTHETIC_SCENARIO_MOMENTS.hypoStart),
      ended_at: at(SYNTHETIC_SCENARIO_MOMENTS.hypoEnd),
      rule_version: 'hypo.cgm.ada2026.v1',
    }],
    cgm_gap: {
      last_reading_before: at(SYNTHETIC_SCENARIO_MOMENTS.cgmGapLastReading),
      first_reading_after: at(SYNTHETIC_SCENARIO_MOMENTS.cgmGapNextReading),
    },
  };
}
