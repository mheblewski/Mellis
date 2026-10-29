import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';

function makeRepository() {
  let persistedAnalysis: Record<string, unknown> | null = null;

  return {
    getConversation: vi.fn().mockResolvedValue({
      id: 'conversation-1',
      patient_id: 'patient-1',
      thread_state_version: 'thread-v1',
      awaiting_user_answer: false,
      messages: [
        { id: 'msg-1', role: 'USER', created_at: '2026-01-01T12:00:00.000Z', content: 'Analyze my day', provenance_ref: 'message/m1', message_type: 'USER_MESSAGE' },
      ],
    }),
    getMessageByIdempotencyKey: vi.fn().mockResolvedValue(null),
    getMessageById: vi.fn().mockResolvedValue({
      id: 'msg-1',
      message_type: 'USER_MESSAGE',
      content: 'Analyze my day',
      created_at: '2026-01-01T12:00:00.000Z',
      provenance_ref: 'message/m1',
    }),
    getCurrentStateAtOrBefore: vi.fn().mockResolvedValue({
      as_of: '2026-01-01T12:00:00.000Z',
      glucose: { value: 110, trend: 'FLAT' },
      iob: { value: 0.4 },
      state_version: 'state-v1',
      active_therapy: { therapy_id: 'therapy-1', therapy_version: 'therapy-v1' },
      recent_insulin: [],
      recent_meal: null,
      recent_activity: null,
      recent_sleep: null,
      recent_illness: null,
    }),
    getCurrentState: vi.fn().mockResolvedValue({
      as_of: '2026-01-01T12:00:00.000Z',
      glucose: { value: 110, trend: 'FLAT' },
      iob: { value: 0.4 },
      state_version: 'state-v1',
      active_therapy: { therapy_id: 'therapy-1', therapy_version: 'therapy-v1' },
      recent_insulin: [],
      recent_meal: null,
      recent_activity: null,
      recent_sleep: null,
      recent_illness: null,
    }),
    listPatientEventsByRange: vi.fn().mockResolvedValue([
      { id: 'g1', type: 'GLUCOSE_READING_AVAILABLE', occurred_at: '2026-01-01T08:00:00.000Z', payload: { glucose_value: 120 }, source_record_id: 'sr-1' },
      { id: 'i1', type: 'BOLUS', occurred_at: '2026-01-01T09:00:00.000Z', payload: { insulin_units: 1.5 }, source_record_id: 'sr-2' },
      { id: 'm1', type: 'CARB_ENTRY', occurred_at: '2026-01-01T10:00:00.000Z', payload: { carbs: 30 }, source_record_id: 'sr-3' },
      { id: 'a1', type: 'ACTIVITY', occurred_at: '2026-01-01T11:00:00.000Z', payload: { activity_type: 'walking' }, source_record_id: 'sr-4' },
    ]),
    listHypoEpisodesIntersectingRange: vi.fn().mockResolvedValue([
      { id: 'ep-1', state: 'OPEN', severity: 'L1', started_at: '2026-01-01T06:00:00.000Z', ended_at: null, trigger_id: 'trg-1' },
    ]),
    listPatientContextFactsByRecordedRange: vi.fn().mockResolvedValue([
      { id: 'f1', fact_key: 'meal', fact_name: 'meal', value: { carbs: 30 }, value_type: 'json', knowledge_status: 'KNOWN', source_ref: 'source/ref', source_event_id: 'e-1', source_conversation_id: 'thread-1', recorded_at: '2026-01-01T10:00:00.000Z', created_at: '2026-01-01T10:00:00.000Z' },
    ]),
    insertContextPackage: vi.fn().mockResolvedValue({ id: 'pkg-1' }),
    getAiExecutionByTaskIdentity: vi.fn().mockResolvedValue(null),
    markAiExecutionRunning: vi.fn().mockResolvedValue(undefined),
    markAiExecutionSucceeded: vi.fn().mockResolvedValue(undefined),
    markAiExecutionFailed: vi.fn().mockResolvedValue(undefined),
    insertAnalysis: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
      persistedAnalysis = {
        id: 'analysis-1',
        status: String(args.status ?? 'INSUFFICIENT_DATA'),
        facts: Array.isArray(args.facts) ? args.facts : [],
        unknowns: Array.isArray(args.unknowns) ? args.unknowns : [],
        calculations: Array.isArray(args.calculations) ? args.calculations : [],
        hypotheses: Array.isArray(args.hypotheses) ? args.hypotheses : [],
        uncertainty: args.uncertainty ?? {},
        question: args.question ?? null,
        proposal: args.proposal ?? null,
        rationale: String(args.rationale ?? ''),
      };
      return persistedAnalysis;
    }),
    linkAiExecutionToAnalysis: vi.fn().mockResolvedValue(undefined),
    getAnalysis: vi.fn().mockImplementation(async () => persistedAnalysis),
    insertRecommendation: vi.fn().mockImplementation(async (args: Record<string, unknown>) => ({
      id: 'recommendation-1',
      analysis_id: String(args.analysisId ?? ''),
      status: String(args.status ?? 'INSUFFICIENT_DATA'),
      proposal: args.proposal ?? {},
      evidence: args.evidence ?? [],
      provenance: args.provenance ?? {},
    })),
    linkConversation: vi.fn().mockResolvedValue(undefined),
    insertMessage: vi.fn().mockResolvedValue({ id: 'msg-2' }),
    finalizeJobSuccess: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeWorker() {
  const repository = makeRepository();
  const aiGateway = {
    execute: vi.fn().mockResolvedValue({
      result: { assistant_message: 'I reviewed your day and found a meal around 10:00 and a glucose value around 120.' },
      metadata: {
        provider: 'fake',
        model: 'fake-model',
        prompt_version: 'conversation-time-range-analysis.v1',
        output_schema_version: 'conversation-time-range-analysis-output.v1',
        model_policy_version: 'policy-v1',
        model_fingerprint: 'fake:fake-model:conversation-time-range-analysis.v1:conversation-time-range-analysis-output.v1',
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, cached_input_tokens: null, reasoning_tokens: null },
        input_fingerprint: 'fingerprint',
        serialized_input_bytes: 123,
        context_package_usage: { total_serialized_bytes: 123, sections: [] },
        provider_latency_ms: 10,
        estimated_cost: { estimated_cost: 0.01, currency: 'USD', pricing_version: 'v1', input_cost: 0.01, output_cost: 0, cached_input_cost: 0, reasoning_cost: 0 },
      },
      input_hash: 'sha256:abc',
      task_identity: 'task-1',
      input_fingerprint: 'fingerprint',
      metadata_version: 'v1',
    }),
  };

  const worker = new WorkerService(
    repository,
    {} as any,
    { get: vi.fn(), getOrThrow: vi.fn() } as any,
    aiGateway as any,
    {} as any,
  );

  return { worker, repository, aiGateway };
}

function buildTimeRangePayload(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    patient_id: 'patient-1',
    conversation_id: 'conversation-1',
    user_message_id: 'msg-1',
    range_type: 'TODAY',
    range_start: '2026-01-01T00:00:00.000Z',
    range_end: '2026-01-01T12:00:00.000Z',
    timezone: 'UTC',
    normalization_policy_version: 'time-range-normalization.v1',
    ...overrides,
  };
}

describe('TODAY time-range analysis', () => {

  it('passes the AI preferences of the user who sent the message, and none without an author', async () => {
    const { worker, aiGateway, repository } = makeWorker();
    const getUserAiPreferences = vi.fn().mockResolvedValue({ ai_role: 'PATIENT_SELF', ai_instructions: 'Krótko.' });
    Object.assign(repository, { getUserAiPreferences });
    repository.getMessageById.mockResolvedValue({
      id: 'msg-1',
      message_type: 'USER_MESSAGE',
      content: 'Analyze my day',
      created_at: '2026-01-01T12:00:00.000Z',
      provenance_ref: 'message/m1',
      author_user_id: 'user-7',
    });
    await (worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', { ...buildTimeRangePayload() });
    expect(getUserAiPreferences).toHaveBeenCalledWith('user-7');
    expect(aiGateway.execute.mock.calls[0][0].context_package.user_preferences).toEqual({ ai_role: 'PATIENT_SELF', ai_instructions: 'Krótko.' });

    const second = makeWorker();
    await (second.worker as any).handleConversationTimeRangeAnalysis('job-2', 'lease-2', { ...buildTimeRangePayload() });
    expect(second.aiGateway.execute.mock.calls[0][0].context_package.user_preferences).toBeNull();
  });

  it('A. resolves current meal anchor from event evidence for meal-focused question', async () => {
    const { worker, aiGateway, repository } = makeWorker();
    repository.getMessageById.mockResolvedValue({
      id: 'msg-1',
      message_type: 'USER_MESSAGE',
      content: 'Przeanalizuj obiad około 10:00',
      created_at: '2026-01-01T12:00:00.000Z',
      provenance_ref: 'message/m1',
    });

    await (worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', {
      ...buildTimeRangePayload(),
    });

    const contextPackage = aiGateway.execute.mock.calls[0][0].context_package;
    expect(contextPackage.current_meal_reference.status).toBe('RESOLVED');
    expect(contextPackage.current_meal_reference.reference_type).toBe('EVENT');
    expect(contextPackage.current_meal_reference.meal_event_id).toBe('m1');
    expect(contextPackage.current_meal_reference.carbs.value).toBe(30);
  });

  it('B. marks anchor as ambiguous when multiple meal candidates cannot be safely disambiguated', async () => {
    const { worker, aiGateway, repository } = makeWorker();
    repository.getMessageById.mockResolvedValue({
      id: 'msg-1',
      message_type: 'USER_MESSAGE',
      content: 'Przeanalizuj posiłek',
      created_at: '2026-01-01T12:00:00.000Z',
      provenance_ref: 'message/m1',
    });
    repository.listPatientEventsByRange.mockResolvedValue([
      { id: 'm1', type: 'CARB_ENTRY', occurred_at: '2026-01-01T10:00:00.000Z', payload: { carbs: 30 }, source_record_id: 'sr-3' },
      { id: 'm2', type: 'CARB_ENTRY', occurred_at: '2026-01-01T09:45:00.000Z', payload: { carbs: 28 }, source_record_id: 'sr-5' },
    ]);

    await (worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', {
      ...buildTimeRangePayload(),
    });

    const contextPackage = aiGateway.execute.mock.calls[0][0].context_package;
    expect(contextPackage.current_meal_reference.status).toBe('AMBIGUOUS');
    expect(contextPackage.current_meal_reference.meal_event_id).toBeNull();
    expect(contextPackage.current_meal_reference.candidate_meal_event_ids).toEqual(['m1', 'm2']);
  });

  it('C. resolves anchor from user-reported carbs when no meal event can be selected', async () => {
    const { worker, aiGateway, repository } = makeWorker();
    repository.getMessageById.mockResolvedValue({
      id: 'msg-1',
      message_type: 'USER_MESSAGE',
      content: 'Po posiłku 42g węglowodanów miałem wzrost',
      created_at: '2026-01-01T12:00:00.000Z',
      provenance_ref: 'message/m1',
    });
    repository.listPatientEventsByRange.mockResolvedValue([
      { id: 'g1', type: 'GLUCOSE_READING_AVAILABLE', occurred_at: '2026-01-01T08:00:00.000Z', payload: { glucose_value: 120 }, source_record_id: 'sr-1' },
    ]);

    await (worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', {
      ...buildTimeRangePayload(),
    });

    const contextPackage = aiGateway.execute.mock.calls[0][0].context_package;
    expect(contextPackage.current_meal_reference.status).toBe('RESOLVED');
    expect(contextPackage.current_meal_reference.reference_type).toBe('USER_REPORTED');
    expect(contextPackage.current_meal_reference.carbs.value).toBe(42);
  });

  it('D. keeps anchor unresolved when meal query exists but no concrete meal evidence is available', async () => {
    const { worker, aiGateway, repository } = makeWorker();
    repository.getMessageById.mockResolvedValue({
      id: 'msg-1',
      message_type: 'USER_MESSAGE',
      content: 'Co po tym posiłku?',
      created_at: '2026-01-01T12:00:00.000Z',
      provenance_ref: 'message/m1',
    });
    repository.listPatientEventsByRange.mockResolvedValue([]);

    await (worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', {
      ...buildTimeRangePayload(),
    });

    const contextPackage = aiGateway.execute.mock.calls[0][0].context_package;
    expect(contextPackage.current_meal_reference.status).toBe('UNRESOLVED');
    expect(contextPackage.current_meal_reference.reference_type).toBe('NONE');
  });

  it('E. does not treat planned menu mention as consumed meal without runtime planned source', async () => {
    const { worker, aiGateway, repository } = makeWorker();
    repository.getMessageById.mockResolvedValue({
      id: 'msg-1',
      message_type: 'USER_MESSAGE',
      content: 'W przedszkolu było menu, przeanalizuj ten posiłek',
      created_at: '2026-01-01T12:00:00.000Z',
      provenance_ref: 'message/m1',
    });
    repository.listPatientEventsByRange.mockResolvedValue([]);

    await (worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', {
      ...buildTimeRangePayload(),
    });

    const contextPackage = aiGateway.execute.mock.calls[0][0].context_package;
    expect(contextPackage.current_meal_reference.status).toBe('UNRESOLVED');
    expect(contextPackage.current_meal_reference.planned_meal_source_available).toBe(false);
    expect(contextPackage.current_meal_reference.notes).toContain('planned_meal_source_unavailable');
  });

  it('F. can resolve anchor from current_state recent meal when explicitly referenced', async () => {
    const { worker, aiGateway, repository } = makeWorker();
    repository.getMessageById.mockResolvedValue({
      id: 'msg-1',
      message_type: 'USER_MESSAGE',
      content: 'Przeanalizuj ten posiłek',
      created_at: '2026-01-01T12:00:00.000Z',
      provenance_ref: 'message/m1',
    });
    repository.listPatientEventsByRange.mockResolvedValue([]);
    repository.getCurrentStateAtOrBefore.mockResolvedValue({
      as_of: '2026-01-01T12:00:00.000Z',
      glucose: { value: 110, trend: 'FLAT' },
      iob: { value: 0.4 },
      state_version: 'state-v1',
      active_therapy: { therapy_id: 'therapy-1', therapy_version: 'therapy-v1' },
      recent_insulin: [],
      recent_meal: { event_id: 'recent-meal-1', occurred_at: '2026-01-01T11:40:00.000Z', carbs: 27 },
      recent_activity: null,
      recent_sleep: null,
      recent_illness: null,
    });

    await (worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', {
      ...buildTimeRangePayload(),
    });

    const contextPackage = aiGateway.execute.mock.calls[0][0].context_package;
    expect(contextPackage.current_meal_reference.status).toBe('RESOLVED');
    expect(contextPackage.current_meal_reference.reference_type).toBe('CURRENT_STATE_RECENT_MEAL');
    expect(contextPackage.current_meal_reference.meal_event_id).toBe('recent-meal-1');
  });

  it('G. preserves unknown composition semantics (unknown is not zero)', async () => {
    const { worker, aiGateway, repository } = makeWorker();
    repository.getMessageById.mockResolvedValue({
      id: 'msg-1',
      message_type: 'USER_MESSAGE',
      content: 'Sprawdź posiłek',
      created_at: '2026-01-01T12:00:00.000Z',
      provenance_ref: 'message/m1',
    });
    repository.listPatientEventsByRange.mockResolvedValue([]);

    await (worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', {
      ...buildTimeRangePayload(),
    });

    const contextPackage = aiGateway.execute.mock.calls[0][0].context_package;
    expect(contextPackage.current_meal_reference.carbs.value).toBeNull();
    expect(contextPackage.current_meal_reference.carbs.knowledge_status).toBe('UNKNOWN');
  });

  it('6. persisted compact ContextPackage payload remains unchanged', async () => {
    const { worker, repository } = makeWorker();

    await (worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', {
      ...buildTimeRangePayload(),
    });

    expect(repository.insertContextPackage).toHaveBeenCalledTimes(1);
    const insertedPayload = repository.insertContextPackage.mock.calls[0][0].payload;
    expect(insertedPayload).not.toHaveProperty('analytical_evidence');
    expect(insertedPayload).toHaveProperty('evidence_sections');
    expect(insertedPayload).toHaveProperty('source_refs');
  });

  it('7. accepts MEDIUM_RANGE payload and preserves non-TODAY range in persisted artifacts', async () => {
    const { worker, repository } = makeWorker();
    const mediumRangePayload = buildTimeRangePayload({
      range_type: 'MEDIUM_RANGE',
      range_start: '2025-12-26T00:00:00.000Z',
      range_end: '2026-01-01T12:00:00.000Z',
    });

    await (worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', mediumRangePayload);

    expect(repository.listPatientEventsByRange).toHaveBeenCalledWith(expect.objectContaining({
      startAtIso: '2025-12-26T00:00:00.000Z',
      endAtIso: '2026-01-01T12:00:00.000Z',
    }));

    const insertedPayload = repository.insertContextPackage.mock.calls[0][0].payload;
    expect(insertedPayload.range.range_type).toBe('MEDIUM_RANGE');
    expect(insertedPayload.range.range_start).toBe('2025-12-26T00:00:00.000Z');
    expect(insertedPayload.range.range_end).toBe('2026-01-01T12:00:00.000Z');
  });

  it('8. rejects malformed range payloads and does not fallback to TODAY', async () => {
    const { worker, aiGateway } = makeWorker();
    const malformedPayload = buildTimeRangePayload({
      range_type: 'SHORT_RANGE',
      range_start: '2026-01-02T00:00:00.000Z',
      range_end: '2026-01-01T12:00:00.000Z',
    });

    await expect((worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', malformedPayload))
      .rejects
      .toThrowError('INVALID_TIME_RANGE_ANALYSIS_PAYLOAD');

    expect(aiGateway.execute).not.toHaveBeenCalled();
  });

});
