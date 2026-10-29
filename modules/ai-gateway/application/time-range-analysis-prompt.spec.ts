import { describe, expect, it } from 'vitest';
import {
  buildTimeRangeAnalysisEvidenceToolPrompt,
  buildTimeRangeAnalysisPrompt,
} from './time-range-analysis-prompt';
import { createConversationTimeRangeAnalysisTask } from './ai-task';
import type { TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import { validateAiEvidenceDeliveryEnvelope } from '@modules/ai-gateway/infrastructure/openai-provider';

function buildContext(): TimeRangeAnalysisContextRecord {
  return {
    context_package_id: 'tr-ctx-1',
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: 'sha256:ctx',
    created_at: '2026-10-07T12:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    analysis_request_input: {
      user_message_id: 'msg-1',
      user_message_text: 'Przeanalizuj ostatnie 7 dni',
      range_type: 'MEDIUM_RANGE',
      timezone: 'UTC',
      range_start: '2026-10-01T00:00:00.000Z',
      range_end: '2026-10-07T12:00:00.000Z',
      requested_at: '2026-10-07T12:00:00.000Z',
      normalization_policy_version: 'time-range-normalization.v1',
    },
    conversation_context: {
      thread_id: 'conv-1',
      thread_state_version: 'conv-v1',
      awaiting_user_answer: false,
      messages: [],
    },
    current_state_snapshot: {
      as_of: '2026-10-07T12:00:00.000Z',
      current_glucose: 100,
      trend: 'FLAT',
      iob: 1.2,
    },
    analytical_evidence: {
      glucose_events: [],
      insulin_treatment_events: [],
      meal_events: [],
      activity_events: [],
      hypo_episodes: [],
      range_event_facts: [
        {
          fact_key: 'meal_proximity',
          fact_name: 'meal_proximity',
          fact_type: 'RELATION',
          scope: 'RANGE',
          knowledge_status: 'KNOWN',
          validity: 'VALID',
          confidence: 'HIGH',
          status: 'ACTIVE',
          source_ref: 'evt-1',
        },
      ],
      summaries: {
        total_events: 3,
        glucose_count: 1,
        insulin_treatment_count: 1,
        meal_count: 1,
        activity_count: 0,
        hypo_episode_count: 0,
        glucose_min: 92,
        glucose_max: 140,
        glucose_avg: 111,
        missing_sections: ['activity_events'],
      },
    },
    current_meal_reference: null,
    provenance: {
      source_refs: ['evt-1', 'evt-2', 'evt-3'],
      selection_policy_version: 'conversation-time-range-context-selection.v1',
    },
  };
}

function buildTask(context: TimeRangeAnalysisContextRecord) {
  return createConversationTimeRangeAnalysisTask({
    task_id: 'task-1',
    context_package_id: context.context_package_id,
    context_package_version: context.context_package_version,
    context_package_hash: context.content_hash,
    correlation_id: 'conv-1',
    created_at: '2026-10-07T12:00:00.000Z',
    patient_id: 'patient-1',
  });
}

describe('time-range-analysis prompt', () => {
  it('builds validated transport envelope with selected_evidence and without analytical_evidence', () => {
    const context = buildContext();
    const task = buildTask(context);

    const prompt = buildTimeRangeAnalysisPrompt(task, context);
    const payload = JSON.parse(prompt.user_payload) as Record<string, any>;

    expect(payload.task.task_type).toBe('CONVERSATION_TIME_RANGE_ANALYSIS');
    expect(payload.selected_evidence).toBeTruthy();
    expect(payload.selected_evidence.summary.glucose_count).toBe(1);
    expect(payload.selected_evidence.range_facts).toHaveLength(1);
    expect(payload.provenance_summary.selection_policy_version).toBe('conversation-time-range-context-selection.v1');
    expect(payload.evidence_contract).toMatchObject({ therapy_suggestions: 'CAREGIVER_SUGGESTIONS_WITH_SUFFICIENT_EVIDENCE', therapy_suggestion_policy_version: 'therapy-suggestion-policy.v8' });

    expect(payload.analytical_evidence).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('raw_payload');
    expect(JSON.stringify(payload)).not.toContain('context_package');
  });

  it('says nothing about historical meal cases or historical context (none are sent)', () => {
    const context = buildContext();
    const prompt = buildTimeRangeAnalysisPrompt(buildTask(context), context);

    expect(prompt.system_instructions).not.toMatch(/Historical meal cases|historical context/i);
  });

  it('keeps correction carbs out of the meals and tells the model they were not eaten', () => {
    const context = buildContext();
    const at = context.analysis_request_input.range_start;
    context.analytical_evidence.meal_events = [
      { event_id: 'meal-1', type: 'CARB_ENTRY', occurred_at: at, payload: { carbs: 40 } },
      { event_id: 'hypo-1', type: 'CARB_ENTRY', occurred_at: at, payload: { carbs: 10, carb_kind: 'HYPO_TREATMENT' } },
    ];
    context.analytical_evidence.virtual_correction_carb_events = [
      { event_id: 'virtual-1', type: 'CARB_ENTRY', occurred_at: at, payload: { carbs: 20, carb_kind: 'CORRECTION_CARBS' } },
    ];
    context.analytical_evidence.fat_protein_unit_carb_events = [
      { event_id: 'wbt-1', type: 'CARB_ENTRY', occurred_at: at, payload: { carbs: 15, carb_kind: 'FAT_PROTEIN_UNITS' } },
    ];
    const prompt = buildTimeRangeAnalysisPrompt(buildTask(context), context);
    const payload = JSON.parse(prompt.user_payload) as Record<string, any>;

    expect(prompt.system_instructions).toContain('virtual_correction_carb_events are carbs the caregiver logged only so the loop keeps delivering a correction');
    expect(JSON.stringify(payload.temporal_evidence.meal_events)).toContain('HYPO_TREATMENT');
    expect(JSON.stringify(payload.temporal_evidence.meal_events)).not.toContain('virtual-1');
    expect(JSON.stringify(payload.temporal_evidence.virtual_correction_carb_events)).toContain('CORRECTION_CARBS');
    expect(JSON.stringify(payload.temporal_evidence.fat_protein_unit_carb_events)).toContain('FAT_PROTEIN_UNITS');
    expect(prompt.system_instructions).toContain('fat_protein_unit_carb_events are "carbs" the caregiver logged');
  });

  it('defines WBT as food that raises glucose late, not as insulin', () => {
    const context = buildContext();
    const prompt = buildTimeRangeAnalysisPrompt(buildTask(context), context);

    // A live answer (2026-10-16) said "WBT nie podnosi glikemii samo w sobie — ma dostarczyć insulinę" after this
    // prompt called the WBT entry "the insulin given for its protein and fat".
    // One definition for every conversation prompt (the shared style, payload audit 2026-10-26).
    expect(prompt.system_instructions).toContain('WBT (wymiennik białkowo-tłuszczowy, fat-protein unit, Warsaw method) = 100 kcal from the protein and fat of FOOD');
    expect(prompt.system_instructions).toContain('never say WBT do not raise glucose');
    expect(prompt.system_instructions).not.toContain('the WBT entry is the insulin');
    // A live suggestion asked about a rise 3–6 h after the WBT entries, which are themselves logged hours after the meal.
    expect(prompt.system_instructions).toContain('time the late rise from the meal, never from the WBT entry');
    expect(prompt.system_instructions.split('= 100 kcal from the protein and fat').length - 1).toBe(1);
  });

  it('gives each WBT entry the meal it covers, with that meal\'s local start time', () => {
    const context = buildContext();
    context.analytical_evidence.fat_protein_unit_carb_events = [{
      event_id: 'wbt-1', type: 'CARB_ENTRY', occurred_at: context.analysis_request_input.range_end, payload: { carbs: 10, carb_kind: 'FAT_PROTEIN_UNITS' },
      linked_meal: { link_basis: 'MACROS', anchor_event_id: 'meal-0', started_at: '2026-01-01T17:04:00.000Z', meal_record: { description: 'Kurczak McNuggets', source_carbs_g: 30 } },
    }];
    const payload = JSON.parse(buildTimeRangeAnalysisPrompt(buildTask(context), context).user_payload) as Record<string, any>;

    const [wbt] = payload.temporal_evidence.fat_protein_unit_carb_events.events;
    expect(wbt.linked_meal).toMatchObject({ meal_record: { description: 'Kurczak McNuggets', source_carbs_g: 30 } });
    expect(typeof wbt.linked_meal.started_local_time).toBe('string');
    expect(buildTimeRangeAnalysisPrompt(buildTask(context), context).system_instructions).toContain('never describe one as a meal of its own or as an unresolved meal');
  });

  it('shows the model the suggestions it already offered in the conversation', () => {
    const context = buildContext();
    context.conversation_context.already_suggested_follow_ups = ['Jak zwykle reaguje na pizzę?'];
    const payload = JSON.parse(buildTimeRangeAnalysisPrompt(buildTask(context), context).user_payload) as Record<string, any>;
    expect(payload.conversation_context.already_suggested_follow_ups).toEqual(['Jak zwykle reaguje na pizzę?']);
    context.conversation_context.already_suggested_follow_ups = undefined;
    const withoutAny = JSON.parse(buildTimeRangeAnalysisPrompt(buildTask(context), context).user_payload) as Record<string, any>;
    expect(withoutAny.conversation_context.already_suggested_follow_ups).toEqual([]);
  });

  it('uses the same selected_evidence contract in evidence tool loop prompt', () => {
    const context = buildContext();
    const task = buildTask(context);

    const prompt = buildTimeRangeAnalysisEvidenceToolPrompt({
      task,
      context,
      initialEvidenceView: {
        evidence_view_version: 'initial-evidence-view.v1',
        initial_context_summary: {
          task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
          patient_id: 'patient-1',
          range: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-07T12:00:00.000Z' },
          current_glucose: 100,
          trend: 'FLAT',
          as_of: '2026-10-07T12:00:00.000Z',
        },
        significant_glucose_events: [],
        known_treatment_events: [],
        tools_available: [],
        evidence_capability_summary: [],
        instruction: 'Use tools when necessary.',
        provenance: { fixture_id: 'fixture-1' },
      },
    });

    const payload = JSON.parse(prompt.user_payload) as Record<string, any>;

    expect(payload.task.task_type).toBe('CONVERSATION_TIME_RANGE_ANALYSIS');
    expect(payload.selected_evidence).toBeTruthy();
    expect(payload.tool_loop_state).toBeTruthy();
    expect(payload.tool_loop_state.mode).toBe('EVIDENCE_TOOL_LOOP');

    expect(payload.initial_evidence_view).toBeUndefined();
    expect(payload.analytical_evidence).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('raw_payload');
  });

  it('preserves UNKNOWN and MISSING sections in selected evidence summary', () => {
    const context = buildContext();
    const task = buildTask(context);

    const prompt = buildTimeRangeAnalysisPrompt(task, context);
    const payload = JSON.parse(prompt.user_payload) as Record<string, any>;

    expect(payload.selected_evidence.summary.missing_sections).toContain('activity_events');
  });

  it('does not expose internal context machinery language in user payload fields', () => {
    const context = buildContext();
    const task = buildTask(context);

    const prompt = buildTimeRangeAnalysisPrompt(task, context);
    const payloadText = prompt.user_payload;
    const payload = JSON.parse(prompt.user_payload) as Record<string, any>;

    expect(payloadText).not.toContain('memory building');
    expect(payloadText).not.toContain('historical-context machinery');
    expect(payload.task.task_type).toBe('CONVERSATION_TIME_RANGE_ANALYSIS');
  });
});

describe('time-range-analysis prompt: hypo caregiver reports', () => {
  function withHypos(focus: boolean): TimeRangeAnalysisContextRecord {
    const context = buildContext();
    const report = {
      activity: { performed: true, timing: 'ONE_TO_THREE_HOURS', note: null },
      rescue_carbs: { given: true, carbs_g: 6, logged_entry_event_id: null },
      note: null,
    };
    context.analytical_evidence.hypo_episodes = [
      { episode_id: 'episode-1', state: 'CLOSED', severity: 'L1', started_at: '2026-10-07T08:00:00.000Z', ended_at: '2026-10-07T08:25:00.000Z', trigger_id: 't-1', caregiver_report: report },
      { episode_id: 'episode-2', state: 'CLOSED', severity: 'L1', started_at: '2026-10-06T22:00:00.000Z', ended_at: '2026-10-06T22:30:00.000Z', trigger_id: 't-2', caregiver_report: null },
    ];
    if (focus) {
      context.analysis_request_input.focus_hypo_episode_id = 'episode-1';
    }
    return context;
  }

  it('marks the hypo of a hypo-screen chat as the focus and tells the model to answer about it, with no caregiver report', () => {
    const context = withHypos(true);
    const prompt = buildTimeRangeAnalysisPrompt(buildTask(context), context);
    const payload = JSON.parse(prompt.user_payload) as Record<string, any>;

    expect(payload.analysis_request_input.focus_hypo_episode_id).toBe('episode-1');
    expect(payload.selected_evidence.hypo_episodes.focus[0]).toMatchObject({ episode_id: 'episode-1', focus: true });
    expect(payload.temporal_evidence.hypo_episodes.find((episode: any) => episode.episode_id === 'episode-1')).toMatchObject({ focus: true });
    expect(payload.temporal_evidence.hypo_episodes[0]).not.toHaveProperty('caregiver_report');
    expect(prompt.system_instructions).toContain('focus_hypo_episode_id is set');
  });

  it('passes the value of range facts', () => {
    const context = buildContext();
    context.analytical_evidence.range_event_facts = [{ fact_key: 'hypo_note', value: 'po basenie', knowledge_status: 'KNOWN' }];
    const payload = JSON.parse(buildTimeRangeAnalysisPrompt(buildTask(context), context).user_payload) as Record<string, any>;
    expect(payload.selected_evidence.range_facts[0].value).toBe('po basenie');
  });
});

describe('rescue carb alert conversations (rescue-carbs.v1)', () => {
  // 2026-10-20: the alert reached the payload but the delivery check did not allow its key ("Nie udało się przygotować odpowiedzi").
  it('passes the alert and a GlucoMind rescue carb entry to both prompts and through the delivery check', () => {
    const context = buildContext();
    context.analytical_evidence.rescue_carb_alert = { alert_id: 'alert-1', level: 'PREDICTED_LOW', proposal: { carbs_g: 16, explanation: ['Trio liczy 16 g'] } };
    context.analytical_evidence.meal_events = [{
      event_id: 'rescue-1', type: 'CARB_ENTRY', occurred_at: '2026-10-07T11:50:00.000Z', source_record_id: 'rescue-carbs:alert-1',
      payload: { carbs: 6, carb_kind: 'HYPO_TREATMENT', entry_source: 'GLUCOMIND', in_loop: false },
    }];
    for (const prompt of [
      buildTimeRangeAnalysisPrompt(buildTask(context), context),
      buildTimeRangeAnalysisEvidenceToolPrompt({ task: buildTask(context), context, initialEvidenceView: {} as any }),
    ]) {
      expect(() => validateAiEvidenceDeliveryEnvelope(prompt.user_payload, 'CONVERSATION_TIME_RANGE_ANALYSIS')).not.toThrow();
      const payload = JSON.parse(prompt.user_payload) as Record<string, any>;
      expect(payload.rescue_carb_alert).toMatchObject({ alert_id: 'alert-1', proposal: { carbs_g: 16 } });
      expect(prompt.system_instructions).toContain('entry_source GLUCOMIND');
    }
    const timeline = JSON.parse(buildTimeRangeAnalysisPrompt(buildTask(context), context).user_payload).temporal_evidence.meal_events.events;
    expect(timeline[0]).toMatchObject({ carbs: 6, carb_kind: 'HYPO_TREATMENT', entry_source: 'GLUCOMIND', in_loop: false });
  });

  it('passes the loop state, the open plans and the local time to both prompts and through the delivery check', () => {
    const context = buildContext();
    context.therapy_now = { version: 'therapy-now.v1', loop: null, open_plans: [{ kind: 'LATER_BOLUS_PART', trigger: 'AFTER_MINUTES', due_local: '2026-10-07 14:00', carbs_g: 20, insulin_u_estimate: 1.5 }], active_rescue_alert: null };
    for (const prompt of [
      buildTimeRangeAnalysisPrompt(buildTask(context), context),
      buildTimeRangeAnalysisEvidenceToolPrompt({ task: buildTask(context), context, initialEvidenceView: {} as any }),
    ]) {
      expect(() => validateAiEvidenceDeliveryEnvelope(prompt.user_payload, 'CONVERSATION_TIME_RANGE_ANALYSIS')).not.toThrow();
      const payload = JSON.parse(prompt.user_payload) as Record<string, any>;
      expect(payload.therapy_now.open_plans[0]).toMatchObject({ kind: 'LATER_BOLUS_PART', insulin_u_estimate: 1.5 });
      expect(payload.patient_local_time).toMatchObject({ time_zone: expect.any(String) });
      expect(prompt.system_instructions).toContain('therapy_now.open_plans');
    }
  });
});
