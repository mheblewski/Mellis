import { describe, expect, it } from 'vitest';
import { selectMealsForAiContext } from '@modules/meal-candidates/application/meal-record-trust';
import { buildInitialEvidenceView, CGM_COVERAGE_GAP_THRESHOLD_MINUTES, createEvidenceSession, createEvidenceToolRegistry, evaluateEvidenceToolRequest, getActivityEvidenceTool, getBasalEvidenceTool, getGlucoseEvidenceTool, getInsulinEvidenceTool, getMealEvidenceTool, getTherapyProfileTool } from './index';

describe('Evidence Tools contract', () => {
  it('registers the runtime progressive tool set and exposes an initial evidence view', () => {
    const registry = createEvidenceToolRegistry();
    expect(registry.tools.map((tool) => tool.name)).toEqual([
      'get_glucose_evidence',
      'get_insulin_evidence',
      'get_basal_evidence',
      'get_meal_evidence',
      'get_activity_evidence',
      'get_loop_evidence',
      'get_therapy_profile',
    ]);

    const view = buildInitialEvidenceView({
      task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      patient_id: 'patient-123',
      range: { from: '2026-10-08T06:00:00.000Z', to: '2026-10-08T07:30:00.000Z' },
      current_state: {
        as_of: '2026-10-08T07:30:00.000Z',
        current_glucose: 98,
        trend: 'FLAT',
      },
      significant_glucose_events: [{ label: 'Low', start: '2026-10-08T06:34:00.000Z', end: '2026-10-08T06:58:00.000Z', minimum: 58 }],
      known_treatment_events: [{ kind: 'BOLUS', occurred_at: '2026-10-08T06:15:00.000Z', amount: 1.5, unit: 'U' }],
      evidence_capability_summary: ['glucose', 'insulin', 'basal', 'meal', 'activity', 'loop', 'profile'],
      provenance: { source: 'context-package.v1' },
    });

    expect(view.initial_context_summary.patient_id).toBe('patient-123');
    expect(view.instruction).toContain('initial evidence is intentionally incomplete');
    expect(view.tools_available.map((tool) => tool.name)).toContain('get_loop_evidence');
    expect(view.tools_available.map((tool) => tool.name)).toContain('get_meal_evidence');
    expect(view.tools_available.map((tool) => tool.name)).toContain('get_activity_evidence');
  });

  it('emits processing steps at actual evidence-tool execution boundaries without leaking sensitive payloads', () => {
    const steps: Array<{ type: string; tool?: string; label?: string }> = [];
    const registry = createEvidenceToolRegistry();

    const result = registry.execute({
      tool: 'get_glucose_evidence',
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T06:30:00.000Z', to: '2026-10-08T08:00:00.000Z' },
      detail_level: 'DETAIL',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 24 * 60 * 60 * 1000 },
    }, {
      patient_ref: { patient_id: 'patient-123' },
      glucose_evidence: [
        { observed_at: '2026-10-08T06:35:00.000Z', glucose_value: 92, validity: 'VALID', provenance_ref: 'src/ref/glucose/1' },
        { observed_at: '2026-10-08T07:10:00.000Z', glucose_value: 74, validity: 'VALID', provenance_ref: 'src/ref/glucose/2' },
      ],
    }, {
      executionId: 'exec-glucose-step',
      observer: { onStep: (step) => steps.push({ type: step.type, tool: step.tool, label: step.label }) },
    });

    expect(result.status).toBe('KNOWN');
    expect(steps.some((step) => step.type === 'REQUESTING_EVIDENCE' && step.tool === 'get_glucose_evidence')).toBe(true);
    expect(steps.some((step) => step.type === 'ANALYZING_EVIDENCE' && step.tool === 'get_glucose_evidence')).toBe(true);
    expect(steps.every((step) => !JSON.stringify(step).includes('src/ref/glucose/1'))).toBe(true);
    expect(steps.some((step) => step.type === 'FAILED')).toBe(false);
  });

  it('emits FAILED when an evidence tool request fails and keeps the tool contract deterministic', () => {
    const steps: Array<{ type: string; tool?: string }> = [];
    const registry = createEvidenceToolRegistry();

    const result = registry.execute({
      tool: 'get_insulin_evidence',
      patient_id: 'patient-999',
      time_range: { from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T02:00:00.000Z' },
      detail_level: 'DETAIL',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 60 * 60 * 1000 },
    }, {
      patient_ref: { patient_id: 'patient-123' },
    }, {
      executionId: 'exec-insulin-failed',
      observer: { onStep: (step) => steps.push({ type: step.type, tool: step.tool }) },
    });

    expect(result.status).toBe('UNAUTHORIZED');
    expect(steps[0]?.type).toBe('REQUESTING_EVIDENCE');
    expect(steps.some((step) => step.type === 'FAILED')).toBe(true);
    expect(steps.some((step) => step.tool === 'get_insulin_evidence')).toBe(true);
  });

  it('validates tool ranges and returns semantic evidence without raw sensor records', () => {
    const context = {
      patient_ref: { patient_id: 'patient-123' },
      glucose_evidence: [
        {
          reading_id: 'g1',
          observed_at: '2026-10-08T06:10:00.000Z',
          glucose_value: 84,
          classification: 'NORMAL',
          validity: 'VALID',
          provenance_ref: 'glucose:ref:1',
        },
        {
          reading_id: 'g2',
          observed_at: '2026-10-08T06:25:00.000Z',
          glucose_value: 58,
          classification: 'L1',
          validity: 'VALID',
          provenance_ref: 'glucose:ref:2',
        },
      ],
      active_therapy_snapshot: {
        therapy_id: 'therapy-1',
        therapy_version: 'v1',
        active_profile_id: 'profile-1',
        basal_schedule: { '00:00': 0.2 },
        icr_schedule: { default: 12 },
        isf_schedule: { default: 45 },
        target_schedule: { default: 110 },
        dia: 6,
        automation_mode: 'OFF',
      },
      current_state_snapshot: {
        as_of: '2026-10-08T07:00:00.000Z',
        current_glucose: 84,
        trend: 'UP',
        iob: 0.4,
        recent_insulin: [{ event_id: 'ins-1', value: 1.5, unit: 'U', kind: 'BOLUS', occurred_at: '2026-10-08T06:15:00.000Z' }],
      },
    } as any;

    const request = {
      tool: 'get_glucose_evidence',
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T06:00:00.000Z', to: '2026-10-08T06:45:00.000Z' },
      detail_level: 'SUMMARY',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 24 * 60 * 60 * 1000 },
    };

    const validation = evaluateEvidenceToolRequest(request, context);
    expect(validation.ok).toBe(true);

    const response = getGlucoseEvidenceTool.execute(request, context);
    expect(response.status).toBe('KNOWN');
    expect(response.evidence.summary.minimum_glucose).toBe(58);
    expect(response.evidence.summary.maximum_glucose).toBe(84);
    expect(response.evidence.summary.trajectory_points).toBeGreaterThan(0);
    expect(response.evidence.raw_records).toBeUndefined();
  });

  it('uses canonical glucose evidence and real trajectory semantics for the selected time window', () => {
    const context = {
      patient_ref: { patient_id: 'patient-123' },
      glucose_evidence: [
        { reading_id: 'g1', source_record_id: 'src-1', observed_at: '2026-10-08T06:42:00.000Z', recorded_at: '2026-10-08T06:42:00.000Z', glucose_value: 94, glucose_unit: 'mg/dL', classification: 'NORMAL', relation_to_episode: 'PRE_START', validity: 'VALID', provenance_ref: 'src/ref/glucose/a-1' },
        { reading_id: 'g2', source_record_id: 'src-2', observed_at: '2026-10-08T06:48:00.000Z', recorded_at: '2026-10-08T06:48:00.000Z', glucose_value: 82, glucose_unit: 'mg/dL', classification: 'L1', relation_to_episode: 'START', validity: 'VALID', provenance_ref: 'src/ref/glucose/a-2' },
        { reading_id: 'g3', source_record_id: 'src-3', observed_at: '2026-10-08T06:52:00.000Z', recorded_at: '2026-10-08T06:52:00.000Z', glucose_value: 71, glucose_unit: 'mg/dL', classification: 'L1', relation_to_episode: 'ONGOING', validity: 'VALID', provenance_ref: 'src/ref/glucose/a-3' },
        { reading_id: 'g4', source_record_id: 'src-4', observed_at: '2026-10-08T06:57:00.000Z', recorded_at: '2026-10-08T06:57:00.000Z', glucose_value: 59, glucose_unit: 'mg/dL', classification: 'L1', relation_to_episode: 'ONGOING', validity: 'VALID', provenance_ref: 'src/ref/glucose/a-4' },
        { reading_id: 'g5', source_record_id: 'src-5', observed_at: '2026-10-08T07:02:00.000Z', recorded_at: '2026-10-08T07:02:00.000Z', glucose_value: 63, glucose_unit: 'mg/dL', classification: 'L1', relation_to_episode: 'ONGOING', validity: 'VALID', provenance_ref: 'src/ref/glucose/a-5' },
        { reading_id: 'g6', source_record_id: 'src-6', observed_at: '2026-10-08T07:08:00.000Z', recorded_at: '2026-10-08T07:08:00.000Z', glucose_value: 78, glucose_unit: 'mg/dL', classification: 'NORMAL', relation_to_episode: 'LATEST', validity: 'VALID', provenance_ref: 'src/ref/glucose/a-6' },
      ],
      active_therapy_snapshot: { therapy_id: 'therapy-1', therapy_version: 'v1', active_profile_id: 'profile-1', basal_schedule: { '00:00': 0.2 }, icr_schedule: { default: 12 }, isf_schedule: { default: 45 }, target_schedule: { default: 110 }, dia: 6, automation_mode: 'OFF' },
      current_state_snapshot: { as_of: '2026-10-08T07:10:00.000Z', current_glucose: 78, trend: 'UP', iob: 0.3 },
    } as any;

    const request = {
      tool: 'get_glucose_evidence',
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T06:42:00.000Z', to: '2026-10-08T07:08:00.000Z' },
      detail_level: 'TRAJECTORY',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 24 * 60 * 60 * 1000 },
    };

    const response = getGlucoseEvidenceTool.execute(request, context);
    expect(response.status).toBe('KNOWN');
    expect(response.evidence.summary.minimum_glucose).toBe(59);
    expect(response.evidence.summary.maximum_glucose).toBe(94);
    expect(response.evidence.summary.average_glucose).toBeCloseTo(74.5, 1);
    expect(response.evidence.summary.observation_count).toBe(6);
    expect(response.evidence.trajectory.first_glucose_value).toBe(94);
    expect(response.evidence.trajectory.minimum_point.glucose_value).toBe(59);
    expect(response.evidence.trajectory.last_glucose_value).toBe(78);
    expect(response.evidence.trajectory).not.toHaveProperty('shape_signature');
    expect(response.evidence.trajectory).not.toHaveProperty('direction_segments');
    expect(response.evidence.trajectory).not.toHaveProperty('has_secondary_decline');
    expect(response.evidence.trajectory.recovery_state).toBe('UNKNOWN');
    expect(response.evidence.raw_records).toBeUndefined();
    expect(response.content_hash).toBe(response.content_hash);

    const second = getGlucoseEvidenceTool.execute(request, context);
    expect(second.content_hash).toBe(response.content_hash);
  });

  it('keeps glucose L2 anchors bounded and returns exact L3 observations without synthetic period semantics', () => {
    const response = getGlucoseEvidenceTool.execute({
      tool: 'get_glucose_evidence',
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T06:00:00.000Z', to: '2026-10-08T06:30:00.000Z' },
      detail_level: 'DETAIL',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 24 * 60 * 60 * 1000 },
    }, {
      patient_ref: { patient_id: 'patient-123' },
      glucose_evidence: [
        { observed_at: '2026-10-08T06:05:00.000Z', glucose_value: 160, validity: 'VALID', provenance_ref: 'src/ref/glucose/l3-1' },
        { observed_at: '2026-10-08T06:15:00.000Z', glucose_value: 140, validity: 'VALID', provenance_ref: 'src/ref/glucose/l3-2' },
        { observed_at: '2026-10-08T06:25:00.000Z', glucose_value: 180, validity: 'VALID', provenance_ref: 'src/ref/glucose/l3-3' },
      ],
    } as any);

    expect(response.status).toBe('KNOWN');
    expect(response.evidence.summary).not.toHaveProperty('observed_duration_minutes');
    expect(response.evidence.summary).not.toHaveProperty('significant_period_duration_minutes_total');
    expect(response.evidence.significant_periods.length).toBeGreaterThan(0);
    expect(response.evidence.significant_periods[0]).not.toHaveProperty('duration_minutes');
    expect(response.evidence.detail_window.requested_range).toEqual({ from: '2026-10-08T06:00:00.000Z', to: '2026-10-08T06:30:00.000Z' });
    expect(response.evidence.detail_window.observations).toHaveLength(3);
    expect(response.evidence.detail_window.observations[0]).toMatchObject({
      observed_at: '2026-10-08T06:05:00.000Z',
      glucose_value: 160,
      unit: 'mg/dL',
      provenance_ref: 'src/ref/glucose/l3-1',
    });
    expect(response.evidence.detail_window.notes[0]).toContain('No interpolation');
    expect(response.evidence.detail_window).not.toHaveProperty('interpolated_values');
    expect(response.evidence.detail_window).not.toHaveProperty('trend');
  });

  it('enforces authorization and range budget limits in the tool contract', () => {
    const result = evaluateEvidenceToolRequest({
      tool: 'get_insulin_evidence',
      patient_id: 'patient-999',
      time_range: { from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T10:00:00.000Z' },
      detail_level: 'DETAIL',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 60 * 60 * 1000 },
    }, { patient_ref: { patient_id: 'patient-123' } } as any);

    expect(result.ok).toBe(false);
    expect(result.error.status).toBe('UNAUTHORIZED');

    const session = createEvidenceSession({
      task: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      patient_id: 'patient-123',
      initial_evidence_identity: 'init-hash',
      available_tools: ['get_glucose_evidence'],
      tool_calls: [],
      budget: { max_calls: 3, total_budget_tokens: 2000 },
    });

    expect(session.initial_evidence_identity).toBe('init-hash');
    expect(session.budget.max_calls).toBe(3);
  });

  it('returns therapy profile semantics without raw profile JSON leakage', () => {
    const response = getTherapyProfileTool.execute({
      tool: 'get_therapy_profile',
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T06:00:00.000Z', to: '2026-10-08T07:30:00.000Z' },
      detail_level: 'SUMMARY',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 10 * 60 * 60 * 1000 },
    }, {
      patient_ref: { patient_id: 'patient-123' },
      active_therapy_snapshot: {
        therapy_id: 'therapy-1',
        therapy_version: 'v1',
        active_profile_id: 'profile-1',
        basal_schedule: { '00:00': 0.2 },
        icr_schedule: { default: 12 },
        isf_schedule: { default: 45 },
        target_schedule: { default: 110 },
        dia: 6,
        automation_mode: 'OFF',
      },
    } as any);

    expect(response.status).toBe('KNOWN');
    expect(response.evidence.profile_id).toBe('profile-1');
    expect(response.evidence.planned_basal).toEqual({ schedule: { '00:00': 0.2 } });
    expect(response.evidence.raw_profile).toBeUndefined();
  });

  it('returns meal evidence semantics for in-range meal events', () => {
    const response = getMealEvidenceTool.execute({
      tool: 'get_meal_evidence',
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T09:00:00.000Z', to: '2026-10-08T10:00:00.000Z' },
      detail_level: 'DETAIL',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 10 * 60 * 60 * 1000 },
    }, {
      patient_ref: { patient_id: 'patient-123' },
      meal_events: [
        { event_id: 'meal-1', occurred_at: '2026-10-08T09:10:00.000Z', carbs: 54, meal_type: 'DINNER', provenance_ref: 'src/ref/meal/1' },
      ],
    } as any);

    expect(response.status).toBe('KNOWN');
    expect(response.evidence.summary.event_count).toBe(1);
    expect(response.evidence.summary.total_carbs).toBe(54);
    expect(response.evidence.events[0].provenance_ref).toBe('src/ref/meal/1');
  });

  it('adds caregiver-confirmed and unconfirmed new-history meals in range, keeping proposals out of facts', () => {
    const records = selectMealsForAiContext([
      {
        meal_identity: 'meal:v1:e:confirmed', status: 'CONFIRMED', started_at: '2026-10-08T09:10:00.000Z', source_carbs_g: 54,
        description: 'Makaron z sosem', has_photo: false,
        macros: { carbs: { grams: 54, origin: 'AI_PROPOSAL' }, protein: { grams: 18, origin: 'CAREGIVER' }, fat: { grams: null, origin: null } },
      },
      {
        meal_identity: 'meal:v1:e:proposed', status: 'AI_PROPOSED', started_at: '2026-10-08T09:40:00.000Z', source_carbs_g: 20,
        description: 'Jabłko', has_photo: false, pending_proposal_id: 'p-1',
        macros: { carbs: { grams: 20, origin: 'AI_PROPOSAL' }, protein: { grams: 1, origin: 'AI_PROPOSAL' }, fat: { grams: null, origin: null } },
      },
      {
        meal_identity: 'meal:v1:e:outside', status: 'CORRECTED', started_at: '2026-10-08T12:00:00.000Z', source_carbs_g: 30,
        description: 'Kolacja', has_photo: false,
        macros: { carbs: { grams: 30, origin: 'CAREGIVER' }, protein: { grams: null, origin: null }, fat: { grams: null, origin: null } },
      },
    ]);
    const request = {
      tool: 'get_meal_evidence' as const,
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T09:00:00.000Z', to: '2026-10-08T10:00:00.000Z' },
      detail_level: 'DETAIL' as const,
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 10 * 60 * 60 * 1000 },
    };
    const mealEvents = [{ event_id: 'meal-1', occurred_at: '2026-10-08T09:10:00.000Z', carbs: 54, provenance_ref: 'src/ref/meal/1' }];

    const response = getMealEvidenceTool.execute(request as any, { patient_ref: { patient_id: 'patient-123' }, meal_events: mealEvents, meal_records: records } as any);

    const mealRecords = (response.evidence as any).meal_records;
    expect(mealRecords.trusted.map((item: any) => item.meal_identity)).toEqual(['meal:v1:e:confirmed']);
    expect(mealRecords.trusted[0]).toMatchObject({ trusted: true, description: 'Makaron z sosem', protein: { value: 18, knowledge_status: 'KNOWN', origin: 'REPORTED' } });
    expect(mealRecords.unconfirmed.map((item: any) => item.meal_identity)).toEqual(['meal:v1:e:proposed']);
    expect(mealRecords.unconfirmed[0].protein).toEqual({ value: null, knowledge_status: 'UNKNOWN', origin: 'INFERRED', unconfirmed_proposal_g: 1 });
    expect(response.evidence.summary.total_carbs).toBe(54);
    expect(JSON.stringify(response)).toContain('unconfirmed_proposal_g is an unverified AI estimate');

    const withoutRecords = getMealEvidenceTool.execute(request as any, { patient_ref: { patient_id: 'patient-123' }, meal_events: mealEvents } as any);
    expect((withoutRecords.evidence as any).meal_records).toBeUndefined();
  });

  it('returns WBT entries of the range with the meal they cover, even when that meal started before the range', () => {
    const request = {
      tool: 'get_meal_evidence' as const,
      patient_id: 'patient-123',
      time_range: { from: '2026-10-15T20:00:00.000Z', to: '2026-10-15T22:30:00.000Z' },
      detail_level: 'SUMMARY' as const,
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 10 * 60 * 60 * 1000 },
    };
    const linkedMeal = { link_basis: 'MACROS', anchor_event_id: 'nuggets', started_at: '2026-10-15T17:04:00.000Z', meal_record: { description: 'Kurczak McNuggets', source_carbs_g: 30 } };
    const wbtEvents = [
      { event_id: 'wbt-1', type: 'CARB_ENTRY', occurred_at: '2026-10-15T20:24:00.000Z', payload: { carbs: 10, carb_kind: 'FAT_PROTEIN_UNITS' }, linked_meal: linkedMeal },
      { event_id: 'wbt-old', type: 'CARB_ENTRY', occurred_at: '2026-10-15T12:00:00.000Z', payload: { carbs: 5, carb_kind: 'FAT_PROTEIN_UNITS' }, linked_meal: null },
    ];

    const response = getMealEvidenceTool.execute(request as any, { patient_ref: { patient_id: 'patient-123' }, meal_events: [], fat_protein_unit_carb_events: wbtEvents } as any);

    expect(response.status).toBe('KNOWN');
    expect((response.evidence as any).fat_protein_unit_entries).toEqual([
      { event_id: 'wbt-1', occurred_at: '2026-10-15T20:24:00.000Z', carbs_logged_for_wbt: 10, linked_meal: linkedMeal, provenance_ref: 'wbt-1' },
    ]);
    expect(response.evidence.summary.total_carbs).toBeNull();
    expect(JSON.stringify(response)).toContain('not a meal of their own and not an unresolved meal');
  });

  it('returns activity evidence semantics for in-range activity events', () => {
    const response = getActivityEvidenceTool.execute({
      tool: 'get_activity_evidence',
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T09:00:00.000Z', to: '2026-10-08T10:00:00.000Z' },
      detail_level: 'DETAIL',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 10 * 60 * 60 * 1000 },
    }, {
      patient_ref: { patient_id: 'patient-123' },
      activity_events: [
        {
          event_id: 'activity-1',
          occurred_at: '2026-10-08T09:20:00.000Z',
          started_at: '2026-10-08T09:20:00.000Z',
          ended_at: '2026-10-08T09:50:00.000Z',
          duration_minutes: 30,
          activity_type: 'WALKING',
          provenance_ref: 'src/ref/activity/1',
        },
      ],
    } as any);

    expect(response.status).toBe('KNOWN');
    expect(response.evidence.summary.event_count).toBe(1);
    expect(response.evidence.summary.total_duration_minutes).toBe(30);
    expect(response.evidence.events[0].activity_type).toBe('WALKING');
  });

  it('does not fabricate meal associations for insulin requests', () => {
    const response = getInsulinEvidenceTool.execute({
      tool: 'get_insulin_evidence',
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T06:00:00.000Z', to: '2026-10-08T07:00:00.000Z' },
      detail_level: 'SUMMARY',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 10 * 60 * 60 * 1000 },
    }, {
      patient_ref: { patient_id: 'patient-123' },
      current_state_snapshot: {
        recent_insulin: [{ event_id: 'ins-1', value: 1.5, unit: 'U', kind: 'BOLUS', occurred_at: '2026-10-08T06:15:00.000Z' }],
      },
    } as any);

    expect(response.status).toBe('KNOWN');
    expect(response.evidence.events[0].kind).toBe('BOLUS');
    expect(response.evidence.associations.meal_association).toBe('UNKNOWN');
  });

  it('parses insulin boluses and SMBs deterministically without fabricating meal relationships', () => {
    const response = getInsulinEvidenceTool.execute({
      tool: 'get_insulin_evidence',
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T09:00:00.000Z', to: '2026-10-08T12:00:00.000Z' },
      detail_level: 'DETAIL',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 10 * 60 * 60 * 1000 },
    }, {
      patient_ref: { patient_id: 'patient-123' },
      current_state_snapshot: {
        recent_insulin: [
          { event_id: 'ins-1', value: 0.1, unit: 'U', kind: 'SMB', occurred_at: '2026-10-08T09:24:00.000Z', provenance_ref: 'src/ref/insulin/smb-1', validity: 'VALID' },
          { event_id: 'ins-2', value: 2.5, unit: 'U', kind: 'BOLUS', occurred_at: '2026-10-08T11:47:00.000Z', provenance_ref: 'src/ref/insulin/bolus-1', validity: 'VALID' },
          { event_id: 'ins-3', value: 0.1, unit: 'U', kind: 'SMB', occurred_at: '2026-10-08T11:58:00.000Z', provenance_ref: 'src/ref/insulin/smb-2', validity: 'VALID' },
        ],
      },
      meal_events: [{ event_id: 'meal-1', occurred_at: '2026-10-08T09:10:00.000Z', carbs: 54, provenance_ref: 'src/ref/meal/1' }],
    } as any);

    expect(response.status).toBe('KNOWN');
    expect(response.evidence.summary.total_bolus_insulin).toBe(2.5);
    expect(response.evidence.summary.total_smb_insulin).toBe(0.2);
    expect(response.evidence.summary.total_insulin).toBe(2.7);
    expect(response.evidence.events.map((event) => event.event_type)).toEqual(['SMB', 'BOLUS', 'SMB']);
    expect(response.evidence.events[0].provenance_ref).toBe('src/ref/insulin/smb-1');
    expect(response.evidence.associations.meal_association).toBe('UNKNOWN');
    expect(response.evidence.raw_payload).toBeUndefined();
    expect(response.provenance.source_refs).toContain('src/ref/insulin/bolus-1');
    expect(response.content_hash).toBeTruthy();
  });

  it('returns planned basal intervals and actual temp basal changes without leaking raw therapy payloads', () => {
    const response = getBasalEvidenceTool.execute({
      tool: 'get_basal_evidence',
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T05:00:00.000Z', to: '2026-10-08T07:30:00.000Z' },
      detail_level: 'DETAIL',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 10 * 60 * 60 * 1000 },
    }, {
      patient_ref: { patient_id: 'patient-123' },
      active_therapy_snapshot: {
        therapy_id: 'therapy-1',
        therapy_version: 'v1',
        active_profile_id: 'profile-1',
        basal_schedule: { '00:00': 0.05, '02:00': 0.1, '05:00': 0.3, '06:00': 0.15 },
      },
      current_state_snapshot: {
        recent_insulin: [
          { event_id: 'temp-1', value: 0.0, unit: 'U/h', kind: 'TEMP_BASAL', occurred_at: '2026-10-08T05:42:00.000Z', duration: 30, validity: 'VALID', provenance_ref: 'src/ref/temp-basal/1' },
          { event_id: 'temp-2', value: 0.25, unit: 'U/h', kind: 'TEMP_BASAL', occurred_at: '2026-10-08T06:12:00.000Z', duration: 25, validity: 'VALID', provenance_ref: 'src/ref/temp-basal/2' },
        ],
      },
    } as any);

    expect(response.status).toBe('KNOWN');
    expect(response.evidence.planned_basal.profile_id).toBe('profile-1');
    expect(response.evidence.planned_basal.intervals.some((interval) => interval.start === '2026-10-08T05:00:00.000Z')).toBe(true);
    expect(response.evidence.actual_temp_basal[0].rate).toBe(0);
    expect(response.evidence.actual_temp_basal[0].start).toBe('2026-10-08T05:42:00.000Z');
    expect(response.evidence.actual_temp_basal[0].provenance_ref).toBe('src/ref/temp-basal/1');
    expect(response.evidence.temporal_relationship.preserves_boundaries).toBe(true);
    expect(response.evidence.raw_profile).toBeUndefined();
  });

  it('without a therapy profile still reports recorded temp basal as PARTIAL_DATA, with planned basal unknown', () => {
    const response = getBasalEvidenceTool.execute({
      tool: 'get_basal_evidence',
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T05:00:00.000Z', to: '2026-10-08T07:30:00.000Z' },
      detail_level: 'DETAIL',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 10 * 60 * 60 * 1000 },
    }, {
      patient_ref: { patient_id: 'patient-123' },
      active_therapy_snapshot: null,
      temp_basal_events: [
        { event_id: 'temp-1', value: 0.0, unit: 'U/h', kind: 'TEMP_BASAL', occurred_at: '2026-10-08T05:42:00.000Z', duration: 30, validity: 'VALID', provenance_ref: 'src/ref/temp-basal/1' },
      ],
    } as any);

    expect(response.status).toBe('PARTIAL_DATA');
    expect(response.evidence.planned_basal).toBeNull();
    expect(response.evidence.summary).toEqual({ planned_intervals: 0, temp_intervals: 1 });
    expect(response.evidence.actual_temp_basal).toHaveLength(1);
    expect(response.evidence.actual_temp_basal[0]).toMatchObject({ start: '2026-10-08T05:42:00.000Z', rate: 0, provenance_ref: 'src/ref/temp-basal/1' });
    expect(response.evidence.temporal_relationship.planned_vs_actual).toBe('PLANNED_UNKNOWN');
    expect(response.limitations.join(' ')).toContain('planned basal is unknown');
    expect(response.provenance.source_refs).toEqual(['src/ref/temp-basal/1']);
  });

  // TEMP_BASAL as stored in `events` and projected by the worker: the normalized treatment fields live in `payload`.
  const storedTempBasal = (eventId: string, occurredAt: string, payload: Record<string, unknown>) => ({
    event_id: eventId,
    type: 'TEMP_BASAL',
    occurred_at: occurredAt,
    payload: { ...payload, source_event_type: 'Temp Basal' },
    source_record_id: `source-record-${eventId}`,
  });
  const basalRequest = {
    tool: 'get_basal_evidence',
    patient_id: 'patient-123',
    time_range: { from: '2026-10-08T05:00:00.000Z', to: '2026-10-08T07:30:00.000Z' },
    detail_level: 'DETAIL',
    task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
    constraints: { max_range_ms: 10 * 60 * 60 * 1000 },
  } as any;

  it('reads stored TEMP_BASAL rate and duration from the payload and keeps the planned profile contract', () => {
    const events = [
      storedTempBasal('temp-a', '2026-10-08T05:30:00.000Z', { rate: 0.8, absolute: 0.8, duration_minutes: 45 }),
      storedTempBasal('temp-b', '2026-10-08T06:30:00.000Z', { rate: 0, absolute: 0, duration_minutes: 30 }),
    ];
    const response = getBasalEvidenceTool.execute(basalRequest, {
      patient_ref: { patient_id: 'patient-123' },
      active_therapy_snapshot: { therapy_id: 'therapy-1', therapy_version: 'v1', active_profile_id: 'profile-1', basal_schedule: { '00:00': 0.05, '05:00': 0.3 } },
      // The gateway passes the same array under both keys.
      temp_basal_events: events,
      treatment_events: events,
    } as any);

    expect(response.status).toBe('KNOWN');
    expect(response.evidence.planned_basal.profile_id).toBe('profile-1');
    expect(response.evidence.planned_basal.intervals.length).toBeGreaterThan(0);
    expect(response.evidence.actual_temp_basal).toEqual([
      { event_id: 'temp-a', type: 'TEMP_BASAL', start: '2026-10-08T05:30:00.000Z', end: '2026-10-08T06:15:00.000Z', rate: 0.8, unit: 'U/h', status: 'VALID', provenance_ref: 'source-record-temp-a' },
      { event_id: 'temp-b', type: 'TEMP_BASAL', start: '2026-10-08T06:30:00.000Z', end: '2026-10-08T07:00:00.000Z', rate: 0, unit: 'U/h', status: 'VALID', provenance_ref: 'source-record-temp-b' },
    ]);
    expect(response.evidence.summary.temp_intervals).toBe(2);
    expect(response.coverage).toMatchObject({ status: 'KNOWN', covered_range: { from: '2026-10-08T05:30:00.000Z', to: '2026-10-08T06:30:00.000Z' } });
  });

  it('leaves the temp basal rate unknown when the stored rate and absolute disagree, and lists each record once', () => {
    const ambiguous = storedTempBasal('temp-c', '2026-10-08T05:30:00.000Z', { rate: 0.75, absolute: 0.9, duration_minutes: 30 });
    const response = getBasalEvidenceTool.execute(basalRequest, {
      patient_ref: { patient_id: 'patient-123' },
      active_therapy_snapshot: null,
      temp_basal_events: [ambiguous],
      treatment_events: [ambiguous],
    } as any);

    expect(response.status).toBe('PARTIAL_DATA');
    expect(response.evidence.actual_temp_basal).toEqual([
      { event_id: 'temp-c', type: 'TEMP_BASAL', start: '2026-10-08T05:30:00.000Z', end: '2026-10-08T06:00:00.000Z', rate: null, unit: 'U/h', status: 'VALID', provenance_ref: 'source-record-temp-c' },
    ]);
    expect(response.limitations.join(' ')).toContain('Temp basal rate is unknown for 1 record(s)');
  });

  // BOLUS/SMB as stored in `events` and projected by the worker: the dose lives in payload.insulin_units.
  const storedInsulin = (eventId: string, type: 'BOLUS' | 'SMB', occurredAt: string, payload: Record<string, unknown>) => ({
    event_id: eventId,
    type,
    occurred_at: occurredAt,
    payload: { ...payload, source_event_type: type === 'BOLUS' ? 'Bolus' : 'SMB' },
    source_record_id: `source-record-${eventId}`,
  });
  const insulinRequest = {
    tool: 'get_insulin_evidence',
    patient_id: 'patient-123',
    time_range: { from: '2026-10-08T05:00:00.000Z', to: '2026-10-08T09:00:00.000Z' },
    detail_level: 'DETAIL',
    task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
    constraints: { max_range_ms: 10 * 60 * 60 * 1000 },
  } as any;

  it('counts an event passed under both insulin keys once, but keeps distinct events with identical values', () => {
    const events = [
      storedInsulin('bolus-a', 'BOLUS', '2026-10-08T06:00:00.000Z', { insulin_units: 1.5 }),
      // A different event with the same time and dose (e.g. two uploads of a split bolus) is still its own event.
      storedInsulin('bolus-b', 'BOLUS', '2026-10-08T06:00:00.000Z', { insulin_units: 1.5 }),
      storedInsulin('smb-a', 'SMB', '2026-10-08T07:00:00.000Z', { insulin_units: 0.3 }),
    ];
    const response = getInsulinEvidenceTool.execute(insulinRequest, {
      patient_ref: { patient_id: 'patient-123' },
      insulin_treatment_events: events,
      treatment_events: events,
    } as any);

    expect(response.status).toBe('KNOWN');
    expect(response.evidence.events.map((event: any) => [event.event_id, event.event_type, event.amount])).toEqual([
      ['bolus-a', 'BOLUS', 1.5],
      ['bolus-b', 'BOLUS', 1.5],
      ['smb-a', 'SMB', 0.3],
    ]);
    expect(response.evidence.summary).toMatchObject({ total_bolus_insulin: 3, total_smb_insulin: 0.3, total_insulin: 3.3, bolus_count: 2, smb_count: 1, event_count: 3 });
  });

  it('dedupes by event_id across sources even when the records are different objects', () => {
    const response = getInsulinEvidenceTool.execute(insulinRequest, {
      patient_ref: { patient_id: 'patient-123' },
      current_state_snapshot: { recent_insulin: [{ event_id: 'bolus-a', value: 1.5, unit: 'U', kind: 'BOLUS', occurred_at: '2026-10-08T06:00:00.000Z' }] },
      insulin_treatment_events: [storedInsulin('bolus-a', 'BOLUS', '2026-10-08T06:00:00.000Z', { insulin_units: 1.5 })],
    } as any);

    expect(response.evidence.summary).toMatchObject({ bolus_count: 1, total_bolus_insulin: 1.5, total_insulin: 1.5 });
  });

  it('keeps a missing dose unknown instead of zero, and a recorded zero dose as zero', () => {
    const withMissing = getInsulinEvidenceTool.execute(insulinRequest, {
      patient_ref: { patient_id: 'patient-123' },
      insulin_treatment_events: [
        storedInsulin('bolus-a', 'BOLUS', '2026-10-08T06:00:00.000Z', { insulin_units: 2 }),
        storedInsulin('bolus-b', 'BOLUS', '2026-10-08T07:00:00.000Z', {}),
        storedInsulin('smb-a', 'SMB', '2026-10-08T07:30:00.000Z', { insulin_units: 0.2 }),
      ],
    } as any);
    expect(withMissing.status).toBe('PARTIAL_DATA');
    expect(withMissing.evidence.status).toBe('PARTIAL_DATA');
    expect(withMissing.evidence.events.map((event: any) => event.amount)).toEqual([2, null, 0.2]);
    expect(withMissing.evidence.summary).toMatchObject({ total_bolus_insulin: null, total_smb_insulin: 0.2, total_insulin: null, bolus_count: 2, smb_count: 1 });
    expect(withMissing.limitations.join(' ')).toContain('Insulin dose is unknown for 1 event(s)');

    const withZero = getInsulinEvidenceTool.execute(insulinRequest, {
      patient_ref: { patient_id: 'patient-123' },
      insulin_treatment_events: [storedInsulin('bolus-z', 'BOLUS', '2026-10-08T06:00:00.000Z', { insulin_units: 0 })],
    } as any);
    expect(withZero.status).toBe('KNOWN');
    expect(withZero.evidence.events[0].amount).toBe(0);
    expect(withZero.evidence.summary).toMatchObject({ total_bolus_insulin: 0, total_insulin: 0, bolus_count: 1 });
  });

  describe('get_glucose_evidence coverage gaps (threshold CGM_COVERAGE_GAP_THRESHOLD_MINUTES)', () => {
    const window = { from: '2026-10-08T06:00:00.000Z', to: '2026-10-08T07:00:00.000Z' };
    const at = (minute: number) => new Date(Date.parse(window.from) + minute * 60_000).toISOString();
    const coverageFor = (minutes: number[]) => getGlucoseEvidenceTool.execute({
      tool: 'get_glucose_evidence',
      patient_id: 'patient-123',
      time_range: window,
      detail_level: 'DETAIL',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 10 * 60 * 60 * 1000 },
    }, {
      patient_ref: { patient_id: 'patient-123' },
      glucose_evidence: minutes.map((minute, index) => ({
        reading_id: `g-${index}`,
        observed_at: at(minute),
        glucose_value: 110,
        classification: 'UNKNOWN',
        validity: 'VALID',
        provenance_ref: `glucose:${index}`,
      })),
    } as any).coverage;

    it('uses a documented 15-minute threshold', () => {
      expect(CGM_COVERAGE_GAP_THRESHOLD_MINUTES).toBe(15);
    });

    it('treats spacing below and exactly at the threshold as continuous', () => {
      // Readings every 10 minutes, then one spacing of exactly 15 minutes (40 -> 55), edges at 0 and 60.
      expect(coverageFor([0, 10, 20, 30, 40, 55, 60])).toEqual({ status: 'KNOWN', range: window, covered_range: { from: at(0), to: at(60) }, gaps: [] });
    });

    it('reports a spacing just above the threshold as a gap between the two observed readings', () => {
      expect(coverageFor([0, 10, 26, 30, 40, 50, 60])).toEqual({
        status: 'PARTIAL',
        range: window,
        covered_range: { from: at(0), to: at(60) },
        gaps: [{ from: at(10), to: at(26) }],
      });
    });

    it('applies the same threshold at the window edges', () => {
      // 15 minutes from the start and to the end: continuous. 16 minutes: an edge gap.
      expect(coverageFor([15, 25, 35, 45]).gaps).toEqual([]);
      expect(coverageFor([16, 26, 36, 44]).gaps).toEqual([{ from: window.from, to: at(16) }, { from: at(44), to: window.to }]);
    });

    it('orders readings before measuring spacing and reports every interior gap', () => {
      // Sorted: 0, 10, 40, 60 -> spacings 10 (continuous), 30 and 20 (both gaps).
      expect(coverageFor([60, 0, 40, 10]).gaps).toEqual([{ from: at(10), to: at(40) }, { from: at(40), to: at(60) }]);
    });

    it('marks a single reading as partial coverage with its edge gaps', () => {
      expect(coverageFor([30])).toEqual({
        status: 'PARTIAL',
        range: window,
        covered_range: { from: at(30), to: at(30) },
        gaps: [{ from: window.from, to: at(30) }, { from: at(30), to: window.to }],
      });
    });

    it('reports a window without readings as missing in full', () => {
      expect(coverageFor([])).toEqual({ status: 'MISSING', range: window, covered_range: null, gaps: [window] });
    });
  });

  it('without a therapy profile or temp basal reports basal and therapy evidence as MISSING', () => {
    const timeRange = { from: '2026-10-08T05:00:00.000Z', to: '2026-10-08T07:30:00.000Z' };
    const context = { patient_ref: { patient_id: 'patient-123' }, active_therapy_snapshot: null } as any;
    const request = (tool: string) => ({
      tool,
      patient_id: 'patient-123',
      time_range: timeRange,
      detail_level: 'DETAIL',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 10 * 60 * 60 * 1000 },
    }) as any;
    const missingCoverage = { status: 'MISSING', range: timeRange, covered_range: null, gaps: [timeRange] };

    const basal = getBasalEvidenceTool.execute(request('get_basal_evidence'), context);
    expect(basal.status).toBe('MISSING');
    expect(basal.evidence).toEqual({ planned_basal: null, actual_temp_basal: [], summary: { planned_intervals: 0, temp_intervals: 0 } });
    expect(basal.coverage).toEqual(missingCoverage);

    const therapy = getTherapyProfileTool.execute(request('get_therapy_profile'), context);
    expect(therapy.status).toBe('MISSING');
    expect(therapy.evidence).toEqual({ profile_id: null, planned_basal: null, icr: null, isf: null, target: null, dia: null });
    expect(therapy.coverage).toEqual(missingCoverage);
  });

  it('retains temporal sequence across insulin and basal evidence for the same window', () => {
    const context = {
      patient_ref: { patient_id: 'patient-123' },
      active_therapy_snapshot: {
        therapy_id: 'therapy-1',
        therapy_version: 'v1',
        active_profile_id: 'profile-1',
        basal_schedule: { '00:00': 0.05, '05:00': 0.30, '06:00': 0.15 },
      },
      current_state_snapshot: {
        recent_insulin: [
          { event_id: 'temp-1', value: 0, unit: 'U/h', kind: 'TEMP_BASAL', occurred_at: '2026-10-08T05:42:00.000Z', duration: 30, validity: 'VALID', provenance_ref: 'src/ref/temp-basal/1' },
          { event_id: 'ins-1', value: 3.7, unit: 'U', kind: 'BOLUS', occurred_at: '2026-10-08T06:05:00.000Z', validity: 'VALID', provenance_ref: 'src/ref/insulin/bolus-1' },
          { event_id: 'smb-1', value: 0.1, unit: 'U', kind: 'SMB', occurred_at: '2026-10-08T06:12:00.000Z', validity: 'VALID', provenance_ref: 'src/ref/insulin/smb-1' },
        ],
      },
    } as any;

    const insulin = getInsulinEvidenceTool.execute({
      tool: 'get_insulin_evidence',
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T05:30:00.000Z', to: '2026-10-08T06:20:00.000Z' },
      detail_level: 'DETAIL',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 2 * 60 * 60 * 1000 },
    }, context);

    const basal = getBasalEvidenceTool.execute({
      tool: 'get_basal_evidence',
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T05:30:00.000Z', to: '2026-10-08T06:20:00.000Z' },
      detail_level: 'DETAIL',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 2 * 60 * 60 * 1000 },
    }, context);

    expect(insulin.evidence.events.map((event) => event.occurred_at)).toEqual(['2026-10-08T06:05:00.000Z', '2026-10-08T06:12:00.000Z']);
    expect(basal.evidence.actual_temp_basal[0].start).toBe('2026-10-08T05:42:00.000Z');
    expect(insulin.evidence.events[0].amount).toBe(3.7);
    expect(basal.evidence.temporal_relationship.preserves_boundaries).toBe(true);
  });

  it('does not assign unsupported observation-window duration to glucose anchors', () => {
    const response = getGlucoseEvidenceTool.execute({
      tool: 'get_glucose_evidence',
      patient_id: 'patient-123',
      time_range: { from: '2026-10-08T06:00:00.000Z', to: '2026-10-08T07:00:00.000Z' },
      detail_level: 'SUMMARY',
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 10 * 60 * 60 * 1000 },
    }, {
      patient_ref: { patient_id: 'patient-123' },
      glucose_evidence: [
        { observed_at: '2026-10-08T06:10:00.000Z', glucose_value: 160, validity: 'VALID', provenance_ref: 'src/ref/glucose/1' },
        { observed_at: '2026-10-08T06:50:00.000Z', glucose_value: 190, validity: 'VALID', provenance_ref: 'src/ref/glucose/2' },
      ],
    } as any);

    expect(response.status).toBe('KNOWN');
    expect(response.evidence.summary).not.toHaveProperty('observed_duration_minutes');
    expect(response.evidence.summary).not.toHaveProperty('significant_period_duration_minutes_total');
    expect(response.evidence.significant_periods[0]).not.toHaveProperty('duration_minutes');
  });
});

describe('evidence tools: what was not loaded is never "none"', () => {
  const window = { from: '2026-10-18T10:00:00.000Z', to: '2026-10-18T16:00:00.000Z' };
  const request = (tool: string, timeRange = window) => ({
    tool, patient_id: 'patient-123', time_range: timeRange, detail_level: 'SUMMARY',
    task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' }, constraints: { max_range_ms: 25 * 60 * 60 * 1000 },
  }) as any;

  it('reports the part of a window before the loaded range as not selected, and KNOWN as PARTIAL_DATA', () => {
    const context = {
      patient_ref: { patient_id: 'patient-123' },
      loaded_range: { from: '2026-10-18T13:00:00.000Z', to: '2026-10-18T20:00:00.000Z' },
      insulin_treatment_events: [{ event_id: 'b1', type: 'BOLUS', occurred_at: '2026-10-18T14:00:00.000Z', payload: { insulin_units: 2 } }],
    } as any;
    const partly = getInsulinEvidenceTool.execute(request('get_insulin_evidence'), context);
    expect(partly.status).toBe('PARTIAL_DATA');
    expect(partly.evidence.not_selected_ranges).toEqual([{ from: window.from, to: '2026-10-18T13:00:00.000Z' }]);
    expect((partly.evidence.summary as any).bolus_count).toBe(1);
    expect(partly.provenance.request.time_range).toEqual(window);

    const before = getInsulinEvidenceTool.execute(request('get_insulin_evidence', { from: '2026-10-18T06:00:00.000Z', to: '2026-10-18T12:00:00.000Z' }), context);
    expect(before.status).toBe('NOT_SELECTED');
    expect(before.evidence).toEqual({ status: 'NOT_SELECTED', loaded_range: context.loaded_range });
  });

  it('reads an unreadable therapy profile as unknown, and a basal window without temp basals as the profile basal', () => {
    const unreadable = getTherapyProfileTool.execute(request('get_therapy_profile'), { patient_ref: { patient_id: 'patient-123' }, active_therapy_snapshot: null, therapy_profile_status: 'UNAVAILABLE' } as any);
    expect(unreadable.status).toBe('UNKNOWN');
    expect(unreadable.limitations[0]).toContain('could not be read');

    const basal = getBasalEvidenceTool.execute(request('get_basal_evidence'), {
      patient_ref: { patient_id: 'patient-123' },
      active_therapy_snapshot: { therapy_id: 't', therapy_version: 'v', active_profile_id: 't', timezone: 'Europe/Warsaw', basal_schedule: { '00:00': 0.3, '14:00': 0.5 } },
      temp_basal_events: [],
    } as any);
    expect(basal.status).toBe('KNOWN');
    // 14:00 in Warsaw is 12:00 UTC in October.
    expect((basal.evidence.planned_basal as any).intervals.map((interval: any) => [interval.start, interval.rate])).toEqual([[window.from, 0.3], ['2026-10-18T12:00:00.000Z', 0.5]]);
    expect(basal.limitations.join(' ')).toContain('not an absence of basal insulin');
  });
});
