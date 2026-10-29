import { describe, expect, it } from 'vitest';
import { buildModelFacingTimeRangeEnvelope, createLocalTimeFormatter, isEvidenceToolName, stripEvidenceForModel } from './model-facing-payload';
import { buildOpenAiResponsesRequestBody } from '@modules/ai-gateway/infrastructure/openai-provider';

const UUID = '5e990000-0000-4000-8000-000000000d11';
const DIGEST = { count: 3, sha256: `sha256:${'a'.repeat(64)}`, first: `event/${UUID}`, last: `event/${UUID}` };

const glucoseDomain = {
  tool: 'get_glucose_evidence',
  status: 'KNOWN',
  evidence: {
    summary: {
      minimum_glucose: 55,
      average_glucose: 142.53,
      time_in_range: { policy_version: 'glucose-time-in-range.v1', in_range_percent: 83, low_percent: 2.8 },
      semantic_anchors: { hypo_episode_refs: ['hypo/1', 'hypo/2'], source_boundary_refs: [`event/${UUID}`], protected_event_refs: [`event/${UUID}`] },
      provenance: { source_ref_count: 247, source_refs_sha256: DIGEST.sha256, derivation_policy_version: 'glucose-evidence-delivery-spec.v1' },
    },
    significant_periods: [{ type: 'LOCAL_MINIMUM', observed_at: '2026-10-18T09:20:00.000Z', glucose_value: 55, provenance_ref: `event/${UUID}` }],
    coverage: { status: 'KNOWN', gaps: [] },
    status: 'KNOWN',
    model: 'glucose-semantic-summary.v1',
  },
  coverage: { status: 'KNOWN', gaps: [] },
  limitations: [],
};

describe('stripEvidenceForModel', () => {
  it('drops ids, hashes, ref digests and version labels and keeps every value the model reads', () => {
    expect(stripEvidenceForModel(glucoseDomain)).toEqual({
      tool: 'get_glucose_evidence',
      status: 'KNOWN',
      evidence: {
        summary: {
          minimum_glucose: 55,
          average_glucose: 142.53,
          time_in_range: { in_range_percent: 83, low_percent: 2.8 },
          // The ids say nothing; how many hypo episodes the day holds does.
          semantic_anchors: { hypo_episode_count: 2 },
        },
        significant_periods: [{ type: 'LOCAL_MINIMUM', observed_at: '2026-10-18T09:20:00.000Z', glucose_value: 55 }],
        // The inner coverage and status repeat the domain's: sent once (and a full coverage not at all).
      },
    });
  });

  it('drops ref digests of compacted record lists and the result hash, keeps the records', () => {
    const result = { tool: 'get_insulin_evidence', evidence: { events: [{ event_type: 'SMB', amount: 0.025 }], events_refs: DIGEST, events_unit: 'U' }, content_hash: DIGEST.sha256 };
    expect(stripEvidenceForModel(result)).toEqual({ tool: 'get_insulin_evidence', evidence: { events: [{ event_type: 'SMB', amount: 0.025 }], events_unit: 'U' } });
  });

  it('keeps a coverage with gaps, and coverage inside evidence when it differs from the domain coverage', () => {
    const gap = { status: 'PARTIAL', gaps: [{ from: 'a', to: 'b' }] };
    const stripped = stripEvidenceForModel({ ...glucoseDomain, coverage: gap, evidence: { ...glucoseDomain.evidence, coverage: { status: 'KNOWN', gaps: [{ from: 'c', to: 'd' }] } } }) as Record<string, any>;
    expect(stripped.coverage).toEqual(gap);
    expect(stripped.evidence.coverage).toEqual({ status: 'KNOWN', gaps: [{ from: 'c', to: 'd' }] });
  });

  it('drops values that repeat a default or another field, never a value of its own (audit 2026-10-26)', () => {
    const summary = { observation_count: 289, trajectory_points: 289, unknown_count: 0, missing_count: 2, coverage_status: 'HAS_USABLE_GLUCOSE_DATA',
      evidence_status: { glucose_data: 'KNOWN', known_hypo_episodes: 'NOT_SELECTED', excluded_evidence: 'NONE' },
      time_in_range: { target_mg_dl: { low: 70, high: 180 }, readings_count: 289, very_low_percent: 0, low_percent: 1, in_range_percent: 80, high_percent: 19, very_high_percent: 0, below_range_percent: 1, above_range_percent: 19 } };
    expect(stripEvidenceForModel(summary)).toEqual({ observation_count: 289, missing_count: 2, evidence_status: { known_hypo_episodes: 'NOT_SELECTED' },
      time_in_range: { very_low_percent: 0, low_percent: 1, in_range_percent: 80, high_percent: 19, very_high_percent: 0 } });
    // Another target is kept; insulin and meal coverage (first to last event) and boilerplate lines go.
    expect((stripEvidenceForModel({ time_in_range: { target_mg_dl: { low: 70, high: 140 } } }) as any).time_in_range.target_mg_dl).toEqual({ low: 70, high: 140 });
    const insulin = stripEvidenceForModel({ tool: 'get_insulin_evidence', status: 'KNOWN', evidence: { status: 'KNOWN', model: 'canonical-treatment-insulin-compiler', associations: { meal_association: 'UNKNOWN', activity_association: 'UNKNOWN' }, events: [] },
      coverage: { status: 'KNOWN', range: { from: 'a', to: 'b' }, covered_range: { from: 'x', to: 'y' }, gaps: [{ from: 'a', to: 'x' }] },
      limitations: ['Meal and activity association remains explicit UNKNOWN unless deterministically established.', 'Something specific.'] });
    expect(insulin).toEqual({ tool: 'get_insulin_evidence', status: 'KNOWN', evidence: { events: [] }, limitations: ['Something specific.'] });
  });

  it('writes the readings of one day and offset with the date once (compact format)', () => {
    const local = createLocalTimeFormatter('Europe/Warsaw');
    const window = { reading_columns: ['observed_at', 'glucose_mg_dl', 'validity_if_not_valid'], readings: [['2026-10-18T13:30Z', 201], ['2026-10-18T13:35Z', 200, 'INVALID']] };
    expect(stripEvidenceForModel(window, { localTime: local })).toEqual({
      reading_columns: ['local_time', 'glucose_mg_dl', 'validity_if_not_valid'], readings_date: '2026-10-18', readings_utc_offset: '+02:00',
      readings: [['15:30', 201], ['15:35', 200, 'INVALID']],
    });
  });

  it('rounds float noise to three decimals without touching basal steps', () => {
    expect(stripEvidenceForModel({ total_bolus_insulin: 12.599999999999998, rate: 0.025, carbs: 45 })).toEqual({ total_bolus_insulin: 12.6, rate: 0.025, carbs: 45 });
  });

  it('keeps a "model" or "policy_version" value that is not a version label', () => {
    expect(stripEvidenceForModel({ model: 'Dexcom G7', policy_version: 'manual' })).toEqual({ model: 'Dexcom G7', policy_version: 'manual' });
  });
});

describe('buildModelFacingTimeRangeEnvelope', () => {
  const envelope = {
    task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
    analysis_request_input: { user_message_text: 'Przeanalizuj mi dzisiejszy dzień', provenance_ref: 'kept/outside-evidence' },
    current_meal_reference: { status: 'UNRESOLVED', carbs: { value: null, knowledge_status: 'MISSING' }, candidate_meal_event_ids: [UUID], notes: ['could_not_resolve_specific_current_meal'] },
    daily_insulin_totals: { policy_version: 'daily-insulin-totals.v1', days: [{ bolus_units: 12.599999999999998 }] },
    tool_loop_state: { initial_evidence_view: { evidence_view_version: 'initial-evidence-view.v1', initial_context_summary: { range: { from: 'a', to: 'b' } } }, precomputed_daily_evidence: { days: [{ domains: [glucoseDomain] }] } },
  };

  it('strips the evidence sections and compacts an unresolved meal anchor; the rest is sent as built', () => {
    const facing = buildModelFacingTimeRangeEnvelope(envelope) as Record<string, any>;
    // Validated on the full envelope, not sent: the task's labels.
    expect(facing.task).toBeUndefined();
    expect(facing.analysis_request_input).toEqual(envelope.analysis_request_input);
    expect(facing.current_meal_reference).toEqual({ status: 'UNRESOLVED', notes: ['could_not_resolve_specific_current_meal'] });
    expect(facing.daily_insulin_totals).toEqual({ days: [{ bolus_units: 12.6 }] });
    expect(facing.tool_loop_state.initial_evidence_view).toEqual({ initial_context_summary: { range: { from: 'a', to: 'b' } } });
    expect(JSON.stringify(facing.tool_loop_state)).not.toMatch(/sha256|provenance_ref|_refs"|\.v1"/);
  });

  it('keeps a resolved meal anchor whole', () => {
    const resolved = { status: 'RESOLVED', meal_event_id: UUID, carbs: { value: 45, knowledge_status: 'KNOWN' } };
    expect((buildModelFacingTimeRangeEnvelope({ ...envelope, current_meal_reference: resolved }) as Record<string, unknown>).current_meal_reference).toEqual(resolved);
  });
});

describe('request body', () => {
  const toolResult = (tool_name: string) => ({ call_id: 'call-1', tool_name, result: { tool: tool_name, evidence: { events: [], events_refs: DIGEST }, content_hash: DIGEST.sha256 } });
  const common = { patient_ref: { patient_id: 'p' }, conversation_context: { recent_messages: [] }, evidence_contract: { no_chain_of_thought: true } };
  const payloads: Record<string, Record<string, unknown>> = {
    CONVERSATION_TIME_RANGE_ANALYSIS: {
      ...common,
      task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      analysis_request_input: { user_message_text: 'Przeanalizuj mi dzisiejszy dzień' },
      selected_evidence: { summary: {} },
      provenance_summary: { source_ref_count: 1 },
      tool_loop_state: { precomputed_daily_evidence: { days: [{ domains: [glucoseDomain] }] } },
    },
    CONVERSATION_DIRECT_RESPONSE: {
      ...common,
      task: { task_type: 'CONVERSATION_DIRECT_RESPONSE' },
      direct_response_input: { user_message_text: 'Co to jest WBT?', note: DIGEST.sha256 },
    },
  };
  const body = (taskType: string, toolName: string) => buildOpenAiResponsesRequestBody({
    model: 'synthetic-model',
    task_type: taskType,
    system_instructions: 'system',
    user_payload: JSON.stringify(payloads[taskType]),
    previous_response_id: 'resp-1',
    tool_runtime: { available_tools: [], tool_results: [toolResult(toolName)], max_tool_calls_remaining: 1 },
  }) as { input: Array<Record<string, any>> };

  it('sends time-range evidence and evidence tool results without ids and hashes', () => {
    const input = body('CONVERSATION_TIME_RANGE_ANALYSIS', 'get_insulin_evidence').input;
    expect(input[1].content).not.toContain('sha256');
    expect(input[1].content).not.toContain(UUID);
    expect(JSON.parse(input[2].output)).toEqual({ tool: 'get_insulin_evidence', evidence: { events: [] } });
  });

  it('leaves other tools and other tasks unchanged', () => {
    expect(JSON.parse(body('CONVERSATION_TIME_RANGE_ANALYSIS', 'find_meals').input[2].output)).toEqual(toolResult('find_meals').result);
    const direct = body('CONVERSATION_DIRECT_RESPONSE', 'get_insulin_evidence').input;
    // Only the envelope parts the model never reads are left out (task, contracts).
    const { task: _task, evidence_contract: _contract, ...sent } = payloads.CONVERSATION_DIRECT_RESPONSE;
    expect(JSON.parse(direct[1].content)).toEqual(sent);
    expect(JSON.parse(direct[2].output)).toEqual(toolResult('get_insulin_evidence').result);
  });

  it('recognises the evidence tools by name', () => {
    expect(['get_glucose_evidence', 'get_therapy_profile'].every(isEvidenceToolName)).toBe(true);
    expect(['find_meals', 'search_food', 'search_knowledge', 'get_meals', 'get_anything', undefined].some(isEvidenceToolName)).toBe(false);
  });
});

describe('compact format', () => {
  const local = createLocalTimeFormatter('Europe/Warsaw')!;

  it('writes UTC timestamps as local minutes with the offset, exact to the minute', () => {
    expect(local('2026-10-18T09:20:00.000Z')).toBe('2026-10-18T11:20+02:00');
    // After the DST change.
    expect(local('2026-10-26T09:20:00.000Z')).toBe('2026-10-26T10:20+01:00');
    expect(Date.parse(local('2026-10-18T09:20:00.000Z'))).toBe(Date.parse('2026-10-18T09:20:00.000Z'));
    expect(createLocalTimeFormatter('Not/AZone')).toBeNull();
    expect(createLocalTimeFormatter(undefined)).toBeNull();
  });

  it('sends long same-shaped record lists as columns and rows, constants once', () => {
    const basal = Array.from({ length: 6 }, (_, i) => ({ type: 'TEMP_BASAL', start: `2026-10-18T0${i}:00:00.000Z`, rate: 0.5 + i / 10, status: 'VALID' }));
    expect(stripEvidenceForModel({ actual_temp_basal: basal, note: 'x', at: '2026-10-18T09:20:00.000Z' }, { localTime: local, columnar: true })).toEqual({
      // One date and offset: written once, the times as "02:00" (audit 2026-10-26).
      actual_temp_basal: {
        same_for_all: { type: 'TEMP_BASAL', status: 'VALID', date: '2026-10-18', utc_offset: '+02:00' },
        columns: ['start', 'rate'],
        rows: basal.map((row) => [local(row.start).slice(11, 16), row.rate]),
      },
      note: 'x',
      at: '2026-10-18T11:20+02:00',
    });
  });

  it('keeps the full times when a block spans two dates, and leaves out opaque ids and default flags', () => {
    const rows = [{ start: '2026-10-18T21:50:00.000Z', rate: 0.5 }, { start: '2026-10-18T22:10:00.000Z', rate: 0.6 }, { start: '2026-10-18T22:30:00.000Z', rate: 0.7 }];
    expect((stripEvidenceForModel({ intervals: rows }, { localTime: local, columnar: true }) as any).intervals.rows[0][0]).toBe('2026-10-18T23:50+02:00');
    expect(stripEvidenceForModel({ episode_ids: ['a', 'b'], event_id: 'x', clipped_to_range_start: false, mentioned_in_conversation: true, availability: 'RECORDS_FOUND' }))
      .toEqual({ episode_count: 2, mentioned_in_conversation: true });
  });

  it('keeps short or mixed lists and the plain format unchanged', () => {
    const short = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
    const mixed = Array.from({ length: 6 }, (_, i) => (i === 3 ? { a: i } : { a: i, b: i }));
    expect(stripEvidenceForModel({ short, mixed }, { localTime: null, columnar: true })).toEqual({ short, mixed });
    expect(stripEvidenceForModel({ at: '2026-10-18T09:20:00.000Z' })).toEqual({ at: '2026-10-18T09:20:00.000Z' });
  });
});
