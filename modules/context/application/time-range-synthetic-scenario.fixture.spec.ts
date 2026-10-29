import { describe, expect, it } from 'vitest';
import {
  SYNTHETIC_SCENARIO_MOMENTS,
  SYNTHETIC_SCENARIO_PATIENT_ID,
  buildTimeRangeSyntheticScenario,
} from './time-range-synthetic-scenario.fixture';
import { normalizeNightscoutEntry } from '@modules/integrations/nightscout/application/nightscout-normalizer';
import { normalizeNightscoutTreatment } from '@modules/integrations/nightscout/application/nightscout-treatment-normalizer';
import { detectHypo } from '@modules/triggering/application/hypo-detector';
import type { HypoEpisodeView } from '@modules/triggering/domain/hypo-types';

// Offline contract validation of the synthetic 3-day scenario: internal consistency, the real Nightscout normalizers
// and the real hypo detector. Pure functions only; no database, network, API or worker.

const scenario = buildTimeRangeSyntheticScenario();
const IMPORTED_AT = scenario.requested_at;
const TREATMENT_EVENT_TYPES: Record<string, string> = { BOLUS: 'Bolus', CARB_ENTRY: 'Carb Correction', TEMP_BASAL: 'Temp Basal' };

describe('synthetic 3-day scenario: internal consistency', () => {
  it('is deterministic and uses only the synthetic patient and synthetic id space', () => {
    expect(buildTimeRangeSyntheticScenario()).toEqual(scenario);
    expect(new Set(scenario.events.map((event) => event.patient_id))).toEqual(new Set([SYNTHETIC_SCENARIO_PATIENT_ID]));
    for (const event of scenario.events) {
      expect(event.id).toMatch(/^5e[0-9a-f]{6}-0000-4000-8000-[0-9a-f]{12}$/);
      expect(event.source).toMatchObject({ source_system: 'SYNTHETIC' });
    }
  });

  it('has unique event and source-record ids', () => {
    expect(new Set(scenario.events.map((event) => event.id)).size).toBe(scenario.events.length);
    expect(new Set(scenario.events.map((event) => event.source_record_id)).size).toBe(scenario.events.length);
  });

  it('keeps every event chronological and inside [range_start, requested_at)', () => {
    const times = scenario.events.map((event) => event.occurred_at);
    expect([...times].sort()).toEqual(times);
    for (const event of scenario.events) {
      expect(event.occurred_at >= scenario.range_start).toBe(true);
      expect(event.occurred_at < scenario.requested_at).toBe(true);
      expect(event.recorded_at).toBe(event.occurred_at);
    }
    expect(scenario.range_start < scenario.range_end).toBe(true);
  });

  it('contains glucose readings, two boluses, one meal, two temp basals and nothing else', () => {
    const counts = scenario.events.reduce<Record<string, number>>((acc, event) => ({ ...acc, [event.type]: (acc[event.type] ?? 0) + 1 }), {});
    expect(counts).toEqual({ GLUCOSE_READING_AVAILABLE: scenario.glucose_readings.length, BOLUS: 2, CARB_ENTRY: 1, TEMP_BASAL: 2 });
  });

  it('declares exactly one CGM gap, and it is the only interval longer than the CGM cadence', () => {
    const readings = scenario.glucose_readings;
    const gaps = readings.slice(1)
      .map((reading, index) => ({ from: readings[index].occurred_at, to: reading.occurred_at, minutes: reading.minute - readings[index].minute }))
      .filter((gap) => gap.minutes > 5);
    expect(gaps).toEqual([{ from: scenario.cgm_gap.last_reading_before, to: scenario.cgm_gap.first_reading_after, minutes: 90 }]);
  });

  it('carries no therapy profile at all (missing, not defaulted)', () => {
    const serialized = JSON.stringify(scenario);
    for (const key of ['therapy', 'basal_schedule', 'icr', 'isf', 'profile', 'dia']) {
      expect(serialized.toLowerCase()).not.toContain(key);
    }
  });
});

describe('synthetic 3-day scenario: real normalizer contracts', () => {
  it('glucose payloads equal what the Nightscout entry normalizer produces', () => {
    for (const event of scenario.events.filter((candidate) => candidate.type === 'GLUCOSE_READING_AVAILABLE')) {
      const normalized = normalizeNightscoutEntry(
        { _id: event.source_record_id, sgv: Number(event.payload.glucose_value), dateString: event.occurred_at, units: 'mg/dL', type: 'sgv' } as never,
        SYNTHETIC_SCENARIO_PATIENT_ID,
        IMPORTED_AT,
      );
      if (normalized.status !== 'VALID') throw new Error(`entry ${event.id} rejected: ${normalized.reason}`);
      expect({ glucose_value: normalized.reading.glucose_value, glucose_unit: normalized.reading.glucose_unit }).toEqual(event.payload);
      expect(normalized.reading.observed_at).toBe(event.occurred_at);
    }
  });

  it('treatment payloads equal what the Nightscout treatment normalizer produces', () => {
    const treatments = scenario.events.filter((event) => event.type !== 'GLUCOSE_READING_AVAILABLE');
    for (const event of treatments) {
      const payload = event.payload;
      const normalized = normalizeNightscoutTreatment({
        _id: event.source_record_id,
        eventType: TREATMENT_EVENT_TYPES[event.type],
        created_at: event.occurred_at,
        carbs: payload.carbs as number | undefined,
        insulin: payload.insulin_units as number | undefined,
        rate: payload.rate as number | undefined,
        absolute: payload.absolute as number | undefined,
        duration: payload.duration_minutes as number | undefined,
      } as never, SYNTHETIC_SCENARIO_PATIENT_ID, IMPORTED_AT);
      if (normalized.status !== 'VALID') throw new Error(`treatment ${event.id} rejected: ${normalized.reason}`);
      expect(normalized.treatment.event_type).toBe(event.type);
      expect(normalized.treatment.payload).toEqual(event.payload);
      expect(normalized.treatment.occurred_at).toBe(event.occurred_at);
    }
  });
});

describe('synthetic 3-day scenario: hypo episode', () => {
  it('matches the episode the real hypo detector derives from the readings, reading by reading', () => {
    let episode: HypoEpisodeView | null = null;
    const episodes: HypoEpisodeView[] = [];
    for (const event of scenario.events.filter((candidate) => candidate.type === 'GLUCOSE_READING_AVAILABLE')) {
      const output = detectHypo({
        patient_id: SYNTHETIC_SCENARIO_PATIENT_ID,
        rule_version: 'hypo.cgm.ada2026.v1',
        existing_episode: episode,
        reading: {
          reading_id: event.id,
          source_record_id: event.source_record_id,
          observed_at: event.occurred_at,
          recorded_at: event.recorded_at,
          glucose_value: Number(event.payload.glucose_value),
          glucose_unit: 'mg/dL',
          classification: 'UNKNOWN',
          relation_to_episode: 'LATEST',
          validity: 'VALID',
          provenance_ref: `source-record/${event.source_record_id}`,
        },
      });
      episode = output.episode;
      if (episode?.state === 'CLOSED') {
        episodes.push(episode);
        episode = null;
      }
    }
    expect(episode).toBeNull();
    expect(episodes).toHaveLength(1);
    const [record] = scenario.hypo_episodes;
    expect(scenario.hypo_episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      state: record.state,
      severity: record.severity,
      started_at: record.started_at,
      ended_at: record.ended_at,
      source_event_id: record.start_event_id,
      latest_reading_id: record.latest_event_id,
      trigger_rule_version: record.rule_version,
    });
  });

  it('is an explicit record whose references point at existing readings inside the range', () => {
    const [record] = scenario.hypo_episodes;
    const byId = new Map(scenario.events.map((event) => [event.id, event]));
    expect(byId.get(record.start_event_id)?.occurred_at).toBe(record.started_at);
    expect(byId.get(record.latest_event_id)?.occurred_at).toBe(record.ended_at);
    expect(Number(byId.get(record.start_event_id)?.payload.glucose_value)).toBeLessThan(70);
    expect(Number(byId.get(record.latest_event_id)?.payload.glucose_value)).toBeGreaterThanOrEqual(70);
    expect(record.patient_id).toBe(SYNTHETIC_SCENARIO_PATIENT_ID);
    expect(record.started_at >= scenario.range_start && record.ended_at < scenario.requested_at).toBe(true);
    expect(byId.has(record.trigger_id)).toBe(false); // the trigger row is created by the hypo pipeline, not an event
  });

  it('pins the ground-truth values the answer rubric checks', () => {
    const value = (minute: number) => scenario.glucose_readings.find((reading) => reading.minute === minute)?.glucose_value;
    const values = scenario.glucose_readings.map((reading) => reading.glucose_value);
    expect(Math.min(...values)).toBe(55);
    expect(Math.max(...values)).toBe(210);
    expect(value(SYNTHETIC_SCENARIO_MOMENTS.peak)).toBe(210);
    expect(value(SYNTHETIC_SCENARIO_MOMENTS.hypoStart)).toBe(62);
    const boluses = scenario.events.filter((event) => event.type === 'BOLUS').map((event) => Number(event.payload.insulin_units));
    expect(boluses.reduce((sum, units) => sum + units, 0)).toBe(6);
    expect(scenario.events.filter((event) => event.type === 'CARB_ENTRY').map((event) => event.payload.carbs)).toEqual([45]);
  });
});
