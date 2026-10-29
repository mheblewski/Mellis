import {
  GlucoseReadingEvidence,
  HypoDetectionInput,
  HypoDetectionOutput,
  HypoEpisodeView,
  TriggerView,
} from '../domain/hypo-types';

const HYPO_THRESHOLD_MGDL = 70;
const LEVEL_2_THRESHOLD_MGDL = 54;

function classify(glucoseValue: number): 'NORMAL' | 'L1' | 'L2' {
  if (glucoseValue < LEVEL_2_THRESHOLD_MGDL) {
    return 'L2';
  }

  if (glucoseValue < HYPO_THRESHOLD_MGDL) {
    return 'L1';
  }

  return 'NORMAL';
}

function nextSeverity(current: 'L1' | 'L2' | null, candidate: 'L1' | 'L2'): 'L1' | 'L2' {
  if (current === 'L2' || candidate === 'L2') {
    return 'L2';
  }

  return 'L1';
}

export function detectHypo(input: HypoDetectionInput): HypoDetectionOutput {
  const reading = input.reading;

  if (reading.validity !== 'VALID') {
    return {
      status: 'INSUFFICIENT_DATA',
      severity: null,
      episode: input.existing_episode,
      trigger: null,
      evidence: [reading],
      reasons: ['Reading is not valid.'],
    };
  }

  const classification = classify(reading.glucose_value);

  if (classification === 'NORMAL') {
    if (input.existing_episode?.state === 'OPEN') {
      return {
        status: 'NO_HYPO',
        severity: input.existing_episode.severity,
        episode: {
          ...input.existing_episode,
          state: 'CLOSED',
          ended_at: reading.observed_at,
          latest_reading_id: reading.reading_id,
        },
        trigger: null,
        evidence: [reading],
        reasons: ['Open hypo episode closed by reading >= 70 mg/dL.'],
      };
    }

    return {
      status: 'NO_HYPO',
      severity: null,
      episode: input.existing_episode,
      trigger: null,
      evidence: [reading],
      reasons: ['Reading is at or above 70 mg/dL.'],
    };
  }

  const severity = classification;
  const episodeId = input.existing_episode?.episode_id ?? input.reading.reading_id;
  const triggerId = input.existing_episode?.trigger_id ?? input.reading.reading_id;
  const episode: HypoEpisodeView = input.existing_episode
    ? {
        ...input.existing_episode,
        severity: nextSeverity(input.existing_episode.severity, severity),
        latest_reading_id: reading.reading_id,
      }
    : {
        episode_id: episodeId,
        state: 'OPEN',
        severity,
        started_at: reading.observed_at,
        ended_at: null,
        latest_reading_id: reading.reading_id,
        trigger_id: triggerId,
        trigger_rule_version: input.rule_version,
        source_event_id: reading.reading_id,
      };

  const trigger: TriggerView | null = input.existing_episode
    ? null
    : {
        trigger_id: triggerId,
        trigger_type: 'HYPO_DETECTED',
        rule_version: input.rule_version,
        created_at: reading.recorded_at,
        source_event_id: reading.reading_id,
        patient_id: input.patient_id,
        episode_id: episode.episode_id,
      };

  return {
    status: input.existing_episode ? 'HYPO_ONGOING' : 'HYPO_DETECTED_NEW',
    severity,
    episode,
    trigger,
    evidence: [reading],
    reasons: [
      classification === 'L2'
        ? 'Reading is below 54 mg/dL.'
        : 'Reading is at or above 54 mg/dL and below 70 mg/dL.',
    ],
  };
}

export function classifyGlucoseReading(glucoseValue: number): 'NORMAL' | 'L1' | 'L2' {
  return classify(glucoseValue);
}

/**
 * Freshness guard for starting a new hypo flow (trigger, conversation, AI analysis, push). Not a clinical rule:
 * classification thresholds are untouched. A reading older than this when its detection job runs (e.g. a backlog
 * fetched after worker downtime) may still continue or close an existing episode, but never opens a new one.
 */
export const HYPO_NEW_FLOW_MAX_READING_AGE_MINUTES = 30;

export function isReadingTooStaleToStartHypoFlow(
  reading: Pick<GlucoseReadingEvidence, 'observed_at'>,
  now: string,
  maxAgeMinutes: number = HYPO_NEW_FLOW_MAX_READING_AGE_MINUTES,
): boolean {
  const observedMs = new Date(reading.observed_at).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs)) {
    return true;
  }
  return nowMs - observedMs > maxAgeMinutes * 60_000;
}
