import { buildCompactDeliveryArtifact } from '@modules/context/application/compact-delivery-artifact';
import { evaluateEvidenceSelectionShadowSafe } from '@modules/context/application/evidence-selection-shadow';
import type { AiTask, TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import { getRangeSelectionProfile } from '@modules/context/application/time-range-normalization';
import { EXPECTED, ensureExpectedRanges, parseCaptureFile, type CaptureRecord } from './multi-range-local-evidence-validation';

function toAiTask(capture: CaptureRecord): AiTask {
  return {
    task_id: capture.task.task_id,
    task_type: capture.task.task_type as AiTask['task_type'],
    task_version: capture.task.task_version,
    context_package_id: capture.task.context_package_id,
    context_package_version: capture.task.context_package_version,
    context_package_hash: capture.task.context_package_hash,
    prompt_version: capture.task.prompt_version,
    output_schema_version: capture.task.output_schema_version,
    model_policy_version: capture.task.model_policy_version,
    correlation_id: capture.task.correlation_id,
    created_at: capture.task.created_at,
    patient_id: String(capture.context_package.patient_ref?.patient_id ?? ''),
  };
}

// Entirely synthetic capture records (one per range class), in the shape of openai-request-capture.v1. No values come
// from real captures; the fixture used to be a real capture file and must never be restored.
const SYNTHETIC_PATIENT_ID = 'synthetic-patient-multi-range';
const RANGE_END = '2026-01-31T23:59:59.999Z';
const RANGE_DAYS: Record<(typeof EXPECTED)[number]['range_type'], number> = {
  TODAY: 1,
  SHORT_RANGE: 3,
  MEDIUM_RANGE: 7,
  LONG_RANGE: 14,
  EXTENDED_RANGE: 30,
};

function buildSyntheticCapture(rangeType: (typeof EXPECTED)[number]['range_type']): CaptureRecord {
  const days = RANGE_DAYS[rangeType];
  const rangeStart = new Date(Date.parse(RANGE_END) + 1 - days * 24 * 60 * 60 * 1000).toISOString();
  const at = (minutesAfterStart: number) => new Date(Date.parse(rangeStart) + minutesAfterStart * 60 * 1000).toISOString();
  const id = `synthetic-${rangeType.toLowerCase()}`;
  const glucoseEvents = [100, 120, 140, 110].map((value, step) => ({
    event_id: `${id}-glucose-${step + 1}`,
    occurred_at: at(60 + step * 30),
    payload: { glucose_value: value },
    provenance_ref: `source-record/${id}-glucose-${step + 1}`,
  }));
  const contextPackage: TimeRangeAnalysisContextRecord = {
    context_package_id: `${id}-context`,
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: `sha256:${id}-context`,
    created_at: RANGE_END,
    patient_ref: { patient_id: SYNTHETIC_PATIENT_ID },
    analysis_request_input: {
      user_message_id: `${id}-message`,
      user_message_text: `Synthetic request for ${rangeType}`,
      range_type: rangeType,
      timezone: 'UTC',
      range_start: rangeStart,
      range_end: RANGE_END,
      requested_at: RANGE_END,
    },
    conversation_context: {
      thread_id: `${id}-thread`,
      thread_state_version: `${id}-thread-v1`,
      awaiting_user_answer: false,
      messages: [],
    },
    current_state_snapshot: { as_of: RANGE_END, current_glucose: 110, trend: 'FLAT', iob: 0.5 },
    analytical_evidence: {
      glucose_events: glucoseEvents,
      insulin_treatment_events: [
        { event_id: `${id}-bolus-1`, occurred_at: at(75), kind: 'BOLUS', amount: 1, unit: 'U', provenance_ref: `source-record/${id}-bolus-1` },
      ],
      meal_events: [
        { event_id: `${id}-meal-1`, occurred_at: at(70), payload: { carbs_grams: 20 }, provenance_ref: `source-record/${id}-meal-1` },
      ],
      activity_events: [],
      hypo_episodes: [],
      range_event_facts: [],
      summaries: {
        total_events: 6,
        glucose_count: 4,
        insulin_treatment_count: 1,
        meal_count: 1,
        activity_count: 0,
        hypo_episode_count: 0,
        glucose_min: 100,
        glucose_max: 140,
        glucose_avg: 117.5,
        missing_sections: ['activity_events'],
      },
    },
    provenance: { source_refs: [`${id}-message`], selection_policy_version: 'conversation-time-range-selector.v1' },
  };
  return {
    captured_at: RANGE_END,
    capture_version: 'openai-request-capture.v1',
    task_identity: `${id}-task-identity`,
    task: {
      task_id: `${id}-task`,
      task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      task_version: 'v1',
      prompt_version: 'synthetic-prompt.v1',
      output_schema_version: 'synthetic-output.v1',
      model_policy_version: 'synthetic-model-policy.v1',
      context_package_id: contextPackage.context_package_id,
      context_package_version: contextPackage.context_package_version,
      context_package_hash: contextPackage.content_hash,
      correlation_id: `${id}-correlation`,
      created_at: RANGE_END,
    },
    provider: 'fake',
    model: 'synthetic-model',
    model_fingerprint: 'synthetic-model-fingerprint',
    prompt: { system_instructions: 'synthetic', user_payload: 'synthetic' },
    context_package: contextPackage,
    request_representation: {},
    serialized_input_bytes: 0,
    input_fingerprint: `sha256:${id}-input`,
  };
}

// NDJSON in reverse order with a trailing blank line, so parsing and EXPECTED ordering are both exercised.
const SYNTHETIC_CAPTURE_NDJSON = `${EXPECTED.map((item) => JSON.stringify(buildSyntheticCapture(item.range_type))).reverse().join('\n')}\n\n`;

describe('multi-range local evidence validation helpers', () => {
  it('extracts exactly the expected five range classes from capture file', () => {
    const raw = SYNTHETIC_CAPTURE_NDJSON;
    const parsed = parseCaptureFile(raw);
    const selected = ensureExpectedRanges(parsed);

    expect(selected).toHaveLength(5);
    expect(selected.map((item) => item.context_package.analysis_request_input.range_type)).toEqual(
      EXPECTED.map((item) => item.range_type),
    );
  });

  it('maps captured ranges to deterministic selection profiles', () => {
    const raw = SYNTHETIC_CAPTURE_NDJSON;
    const selected = ensureExpectedRanges(parseCaptureFile(raw));

    const matrix = selected.map((item) => {
      const rangeType = item.context_package.analysis_request_input.range_type;
      return [rangeType, getRangeSelectionProfile(rangeType)] as const;
    });

    expect(matrix).toEqual([
      ['TODAY', 'SINGLE_DAY'],
      ['SHORT_RANGE', 'SHORT_RANGE'],
      ['MEDIUM_RANGE', 'MEDIUM_RANGE'],
      ['LONG_RANGE', 'LONG_RANGE'],
      ['EXTENDED_RANGE', 'EXTENDED_RANGE'],
    ]);
  });

  it('replays compact artifact hash deterministically for each captured case', () => {
    const raw = SYNTHETIC_CAPTURE_NDJSON;
    const selected = ensureExpectedRanges(parseCaptureFile(raw));

    for (const capture of selected) {
      const task = toAiTask(capture);
      const shadow = evaluateEvidenceSelectionShadowSafe({
        task,
        context_package: capture.context_package,
      });
      // The synthetic fixture must exercise real selection, not the error fallback of the Safe wrapper.
      expect(shadow.status).not.toBe('SHADOW_SELECTION_FAILED');

      const first = buildCompactDeliveryArtifact({
        contextPackage: capture.context_package,
        task,
        shadowSelection: shadow,
      });
      const second = buildCompactDeliveryArtifact({
        contextPackage: capture.context_package,
        task,
        shadowSelection: shadow,
      });

      expect(first.artifact_content_hash).toBe(second.artifact_content_hash);
      expect(first.deterministic_replay_metadata.source_context_package_hash).toBe(second.deterministic_replay_metadata.source_context_package_hash);
      expect(first.deterministic_replay_metadata.source_task_identity).toBe(second.deterministic_replay_metadata.source_task_identity);
      expect(first.deterministic_replay_metadata.source_task_identity.length).toBeGreaterThan(0);
    }
  });
});
