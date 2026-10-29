export type HypoSeverity = 'L1' | 'L2';
export type HypoEpisodeState = 'OPEN' | 'CLOSED';
export type HypoDetectionResultStatus =
  | 'HYPO_DETECTED_NEW'
  | 'HYPO_ONGOING'
  | 'NO_HYPO'
  | 'INSUFFICIENT_DATA';

export interface GlucoseReadingEvidence {
  reading_id: string;
  source_record_id: string;
  observed_at: string;
  recorded_at: string;
  glucose_value: number;
  glucose_unit: 'mg/dL';
  classification: 'NORMAL' | 'L1' | 'L2' | 'UNKNOWN';
  relation_to_episode: 'PRE_START' | 'START' | 'ONGOING' | 'LATEST';
  validity: 'VALID' | 'INVALID' | 'DUPLICATE' | 'UNKNOWN';
  provenance_ref: string;
}

export interface HypoEpisodeView {
  episode_id: string;
  state: HypoEpisodeState;
  severity: HypoSeverity;
  started_at: string;
  ended_at: string | null;
  latest_reading_id: string;
  trigger_id: string;
  trigger_rule_version: string;
  source_event_id: string;
}

export interface TriggerView {
  trigger_id: string;
  trigger_type: 'HYPO_DETECTED';
  rule_version: string;
  created_at: string;
  source_event_id: string;
  patient_id: string;
  episode_id: string;
}

export interface HypoDetectionInput {
  patient_id: string;
  rule_version: string;
  existing_episode: HypoEpisodeView | null;
  reading: GlucoseReadingEvidence;
}

export interface HypoDetectionOutput {
  status: HypoDetectionResultStatus;
  severity: HypoSeverity | null;
  episode: HypoEpisodeView | null;
  trigger: TriggerView | null;
  evidence: GlucoseReadingEvidence[];
  reasons: string[];
}