import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_DIRECT_RESPONSE_TASK_TYPE,
  CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE,
  type AiTask,
  type DirectResponseContextRecord,
  type TimeRangeAnalysisContextRecord,
} from '@modules/ai-gateway/domain/ai-gateway';
import { buildAiInputHash } from '@modules/ai-gateway/application/ai-task';
import {
  buildCompactDeliveryArtifact,
  buildCompactDeliveryArtifactFromRuntime,
} from './compact-delivery-artifact';
import type { EvidenceSelectionShadowResult } from './evidence-selection-shadow';
import { evaluateEvidenceSelectionShadowSafe } from './evidence-selection-shadow';

function createDirectContext(): DirectResponseContextRecord {
  const base: DirectResponseContextRecord = {
    context_package_id: 'direct-ctx-1',
    context_package_version: 'conversation-context.v1',
    content_hash: '',
    created_at: '2026-10-07T00:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    conversation_context: {
      thread_id: 'conv-1',
      thread_state_version: 'conv-v1',
      awaiting_user_answer: false,
      messages: [
        {
          message_id: 'm-user-1',
          role: 'USER',
          created_at: '2026-10-07T00:00:00.000Z',
          content: 'Co oznacza ten trend?',
          provenance_ref: 'm-user-1',
          message_type: 'OTHER',
        },
      ],
    },
    direct_response_input: {
      user_message_id: 'm-user-1',
      user_message_text: 'Co oznacza ten trend?',
    },
    current_state_snapshot: {
      as_of: '2026-10-07T00:00:00.000Z',
      current_glucose: 121,
      trend: 'FLAT',
      iob: 0.4,
    },
    provenance: {
      source_refs: ['m-user-1'],
    },
  };

  return {
    ...base,
    content_hash: buildAiInputHash({ context_package: base }),
  };
}

function createRangeContext(message = 'Przeanalizuj mi dzisiejszy dzień'): TimeRangeAnalysisContextRecord {
  const base: TimeRangeAnalysisContextRecord = {
    context_package_id: 'range-ctx-1',
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: '',
    created_at: '2026-10-07T00:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    analysis_request_input: {
      user_message_id: 'm-user-1',
      user_message_text: message,
      range_type: 'TODAY',
      timezone: 'Europe/Warsaw',
      range_start: '2026-10-07T00:00:00.000Z',
      range_end: '2026-10-07T12:00:00.000Z',
      requested_at: '2026-10-07T12:00:00.000Z',
    },
    conversation_context: {
      thread_id: 'conv-1',
      thread_state_version: 'conv-v1',
      awaiting_user_answer: false,
      messages: [
        {
          message_id: 'm-user-1',
          role: 'USER',
          created_at: '2026-10-07T12:00:00.000Z',
          content: message,
          provenance_ref: 'm-user-1',
        },
      ],
    },
    current_state_snapshot: {
      as_of: '2026-10-07T12:00:00.000Z',
      current_glucose: 95,
      trend: 'FLAT',
      iob: 0.2,
    },
    analytical_evidence: {
      glucose_events: [{ event_id: 'g1' }, { event_id: 'g2' }],
      insulin_treatment_events: [{ event_id: 'i1' }],
      meal_events: [{ event_id: 'm1' }],
      activity_events: [{ event_id: 'a1' }],
      hypo_episodes: [],
      range_event_facts: [{ fact_id: 'f1' }],
      summaries: {
        total_events: 5,
        glucose_count: 2,
        insulin_treatment_count: 1,
        meal_count: 1,
        activity_count: 1,
        hypo_episode_count: 0,
        glucose_min: 80,
        glucose_max: 145,
        glucose_avg: 103,
        missing_sections: [],
      },
    },
    provenance: {
      source_refs: ['g1', 'g2', 'i1', 'm1', 'a1', 'f1'],
      selection_policy_version: 'task-evidence-policy.v1',
    },
  };

  return {
    ...base,
    content_hash: buildAiInputHash({ context_package: base }),
  };
}

function createTask(taskType: AiTask['task_type'], context: { context_package_id: string; context_package_version: string; content_hash: string }): AiTask {
  return {
    task_id: `task-${taskType.toLowerCase()}`,
    task_type: taskType,
    task_version: 'task.v1',
    context_package_id: context.context_package_id,
    context_package_version: context.context_package_version,
    context_package_hash: context.content_hash,
    prompt_version: 'prompt.v1',
    output_schema_version: 'schema.v1',
    model_policy_version: 'policy.v1',
    correlation_id: 'corr-1',
    created_at: '2026-10-07T00:00:00.000Z',
    patient_id: 'patient-1',
    trigger_id: 'trigger-1',
  };
}

function shadowOverride(base: EvidenceSelectionShadowResult, patch: Partial<EvidenceSelectionShadowResult>): EvidenceSelectionShadowResult {
  return { ...base, ...patch };
}

function baseShadowFor(args: {
  contextPackage: DirectResponseContextRecord | TimeRangeAnalysisContextRecord;
  task: AiTask;
}): EvidenceSelectionShadowResult {
  return evaluateEvidenceSelectionShadowSafe({
    task: args.task,
    context_package: args.contextPackage,
  });
}

describe('compact-delivery-artifact', () => {
  it('builds DIRECT L1 artifact', () => {
    const context = createDirectContext();
    const task = createTask(CONVERSATION_DIRECT_RESPONSE_TASK_TYPE, context);

    const artifact = buildCompactDeliveryArtifactFromRuntime({ contextPackage: context, task });

    expect(artifact.policy.selection_profile).toBe('CONVERSATION_DIRECT_RESPONSE');
    expect(artifact.policy.selected_level).toBe('L1');
    expect(artifact.selected_families).toEqual(expect.arrayContaining(['CURRENT_STATE', 'CONVERSATION_CONTEXT', 'PROVENANCE']));
  });

  it('builds TODAY L1 artifact with omitted detail families', () => {
    const context = createRangeContext();
    const task = createTask(CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE, context);

    const artifact = buildCompactDeliveryArtifactFromRuntime({ contextPackage: context, task });

    const omitted = new Set(artifact.omitted_families.map((item) => item.family));
    expect(artifact.policy.selection_profile).toBe('CONVERSATION_TIME_RANGE_ANALYSIS');
    expect(omitted.has('GLUCOSE_DETAIL')).toBe(true);
    expect(omitted.has('INSULIN_DETAIL')).toBe(true);
  });

  it('preserves UNKNOWN semantics', () => {
    const context = createRangeContext();
    const task = createTask(CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE, context);
    const shadow = shadowOverride(baseShadowFor({ contextPackage: context, task }), {
      unknowns: ['ACTIVITY_DETAIL:UNMAPPED'],
    });

    const artifact = buildCompactDeliveryArtifact({ contextPackage: context, task, shadowSelection: shadow });

    expect(artifact.unknown_states).toContain('ACTIVITY_DETAIL:UNMAPPED');
    expect(artifact.family_decisions.find((item) => item.family === 'ACTIVITY_DETAIL')?.semantic_state).toBe('UNKNOWN');
  });

  it('preserves MISSING semantics', () => {
    const context = createRangeContext();
    const task = createTask(CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE, context);
    const shadow = shadowOverride(baseShadowFor({ contextPackage: context, task }), {
      missing: ['MEAL_DETAIL'],
    });

    const artifact = buildCompactDeliveryArtifact({ contextPackage: context, task, shadowSelection: shadow });

    expect(artifact.missing_states).toContain('MEAL_DETAIL');
    expect(artifact.omitted_families.find((item) => item.family === 'MEAL_DETAIL')?.reason_code).toBe('MISSING');
  });

  it('preserves EXCLUDED semantics', () => {
    const context = createRangeContext();
    const task = createTask(CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE, context);
    const shadow = shadowOverride(baseShadowFor({ contextPackage: context, task }), {
      excluded: ['INSULIN_DETAIL'],
    });

    const artifact = buildCompactDeliveryArtifact({ contextPackage: context, task, shadowSelection: shadow });

    expect(artifact.excluded_states).toContain('INSULIN_DETAIL');
    expect(artifact.omitted_families.find((item) => item.family === 'INSULIN_DETAIL')?.reason_code).toBe('EXCLUDED');
  });

  it('preserves NOT_SELECTED semantics', () => {
    const context = createRangeContext();
    const task = createTask(CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE, context);
    const shadow = shadowOverride(baseShadowFor({ contextPackage: context, task }), {
      not_selected: ['GLUCOSE_DETAIL'],
    });

    const artifact = buildCompactDeliveryArtifact({ contextPackage: context, task, shadowSelection: shadow });

    expect(artifact.not_selected_states).toContain('GLUCOSE_DETAIL');
    expect(artifact.omitted_families.find((item) => item.family === 'GLUCOSE_DETAIL')?.reason_code).toBe('NOT_SELECTED');
  });

  it('marks PARTIAL relationship semantics explicitly', () => {
    const context = createRangeContext();
    const task = createTask(CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE, context);
    const shadow = shadowOverride(baseShadowFor({ contextPackage: context, task }), {
      relationship_decisions: [{ relationship: 'MEAL_GLUCOSE', status: 'PARTIAL' }],
      unresolved_reasons: ['meal -> glucose targeted window remains PARTIAL'],
      status: 'PARTIAL',
    });

    const artifact = buildCompactDeliveryArtifact({ contextPackage: context, task, shadowSelection: shadow });

    expect(artifact.relationship_decisions).toEqual([{ relationship: 'MEAL_GLUCOSE', status: 'PARTIAL' }]);
    expect(artifact.unresolved_reasons.length).toBeGreaterThan(0);
  });

  it('marks CLOSED observational relationship semantics explicitly', () => {
    const context = createRangeContext();
    const task = createTask(CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE, context);
    const shadow = shadowOverride(baseShadowFor({ contextPackage: context, task }), {
      relationship_decisions: [{ relationship: 'HYPO_INSULIN', status: 'CLOSED' }],
    });

    const artifact = buildCompactDeliveryArtifact({ contextPackage: context, task, shadowSelection: shadow });

    expect(artifact.relationship_decisions).toEqual([{ relationship: 'HYPO_INSULIN', status: 'CLOSED' }]);
  });

  it('preserves provenance refs and deterministic ordering key', () => {
    const context = createRangeContext();
    const task = createTask(CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE, context);

    const artifact = buildCompactDeliveryArtifactFromRuntime({ contextPackage: context, task });

    expect(artifact.provenance.count).toBeGreaterThan(0);
    expect(artifact.provenance.deterministic_ordering_key.startsWith('sha256:')).toBe(true);
  });

  it('is deterministic across repeated builds', () => {
    const context = createRangeContext();
    const task = createTask(CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE, context);

    const a = buildCompactDeliveryArtifactFromRuntime({ contextPackage: context, task });
    const b = buildCompactDeliveryArtifactFromRuntime({ contextPackage: context, task });

    expect(a.artifact_content_hash).toBe(b.artifact_content_hash);
    expect(a.artifact_bytes).toBe(b.artifact_bytes);
    expect(a).toEqual(b);
  });
});
