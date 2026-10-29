import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';
import { buildTimeRangeSyntheticScenario } from '@modules/context/application/time-range-synthetic-scenario.fixture';

// A paid AI call must not repeat when a job is retried after the AI already succeeded (e.g. saving the analysis
// failed). Offline: fake repository and gateway, synthetic scenario, no database or provider.

function setup() {
  const scenario = buildTimeRangeSyntheticScenario();
  const executions = new Map<string, Record<string, unknown>>();
  let failNextAnalysisInsert = true;
  const userMessage = { id: 'msg-1', role: 'USER', message_type: 'USER_MESSAGE', content: scenario.user_message, created_at: scenario.requested_at, provenance_ref: 'conv/c-1/messages/m-1' };
  const repository = {
    getConversation: vi.fn().mockResolvedValue({ id: 'c-1', patient_id: scenario.patient_id, thread_state_version: 'conv-v1', awaiting_user_answer: false, messages: [userMessage] }),
    getMessageByIdempotencyKey: vi.fn().mockResolvedValue(null),
    getMessageById: vi.fn().mockResolvedValue(userMessage),
    getCurrentStateAtOrBefore: vi.fn().mockResolvedValue(null),
    getCurrentState: vi.fn().mockResolvedValue(null),
    listPatientEventsByRange: vi.fn(async () => scenario.events.filter((event) => event.type !== 'GLUCOSE_READING_AVAILABLE' || event.occurred_at >= scenario.range_start)),
    listHypoEpisodesIntersectingRange: vi.fn().mockResolvedValue([]),
    listPatientContextFactsByRecordedRange: vi.fn().mockResolvedValue([]),
    insertContextPackage: vi.fn().mockResolvedValue({ id: 'pkg-1' }),
    getAiExecutionByTaskIdentity: vi.fn(async (identity: string) => executions.get(identity) ?? null),
    markAiExecutionRunning: vi.fn(async (args: { taskIdentity: string }) => {
      executions.set(args.taskIdentity, { id: `exec-${executions.size + 1}`, status: 'running' });
    }),
    markAiExecutionSucceeded: vi.fn(async (args: { taskIdentity: string; result: Record<string, unknown> }) => {
      executions.set(args.taskIdentity, { ...executions.get(args.taskIdentity), status: 'succeeded', normalized_result: args.result });
    }),
    markAiExecutionFailed: vi.fn(),
    insertAnalysis: vi.fn(async () => {
      if (failNextAnalysisInsert) {
        failNextAnalysisInsert = false;
        throw new Error('analysis insert failed after the AI call');
      }
      return { id: 'analysis-1', status: 'INSUFFICIENT_DATA', facts: [], unknowns: [], calculations: [], hypotheses: [], uncertainty: {}, question: null, proposal: null, rationale: '' };
    }),
    linkAiExecutionToAnalysis: vi.fn(),
    getAnalysis: vi.fn().mockResolvedValue({ id: 'analysis-1', status: 'INSUFFICIENT_DATA', facts: [], unknowns: [], calculations: [], hypotheses: [], uncertainty: {}, question: null, proposal: null, rationale: '' }),
    insertRecommendation: vi.fn(async () => ({ id: 'rec-1', analysis_id: 'analysis-1', status: 'INSUFFICIENT_DATA', proposal: {}, evidence: [], provenance: {} })),
    linkConversation: vi.fn(),
    insertMessage: vi.fn().mockResolvedValue({ id: 'assistant-1' }),
    finalizeJobSuccess: vi.fn(),
  } as any;
  const aiGateway = {
    execute: vi.fn().mockResolvedValue({
      result: { assistant_message: 'Synthetic answer.' },
      metadata: { provider: 'fake', model: 'synthetic', model_fingerprint: 'synthetic' },
      input_hash: 'sha256:synthetic',
    }),
  };
  const worker = new WorkerService(repository, {} as any, { get: vi.fn(), getOrThrow: vi.fn() } as any, aiGateway as any, {} as any);
  const payload = {
    patient_id: scenario.patient_id,
    conversation_id: 'c-1',
    user_message_id: 'msg-1',
    range_type: scenario.range_type,
    range_start: scenario.range_start,
    range_end: scenario.range_end,
    timezone: scenario.timezone,
    normalization_policy_version: scenario.normalization_policy_version,
  };
  const run = () => (worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', payload);
  return { run, repository, aiGateway, scenario };
}

describe('time-range analysis retry after a succeeded AI call', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses the succeeded execution on the retry instead of calling the model again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T16:00:05.000Z'));
    const { run, repository, aiGateway } = setup();

    await expect(run()).rejects.toThrow('analysis insert failed after the AI call');
    expect(aiGateway.execute).toHaveBeenCalledTimes(1);

    // The job is retried minutes later: per-attempt metadata (created_at) differs, the evidence does not.
    vi.setSystemTime(new Date('2026-10-14T16:07:30.000Z'));
    await run();

    expect(aiGateway.execute).toHaveBeenCalledTimes(1);
    const identities = repository.getAiExecutionByTaskIdentity.mock.calls.map((call: [string]) => call[0]);
    expect(new Set(identities).size).toBe(1);
    expect(repository.insertMessage).toHaveBeenCalledTimes(1);
    expect(repository.finalizeJobSuccess).toHaveBeenCalledTimes(1);
  });

  it('saves the time-range recommendation as an observation without a question (rule R3)', async () => {
    const { run, repository } = setup();
    repository.getAnalysis.mockResolvedValue({ id: 'analysis-1', status: 'INSUFFICIENT_DATA', facts: [], unknowns: [], calculations: [], hypotheses: [], uncertainty: { material_unresolved_blocker: true }, question: null, proposal: null, rationale: 'Synthetic answer.' });
    await expect(run()).rejects.toThrow();
    await run();

    const saved = repository.insertRecommendation.mock.calls[0][0];
    expect(saved.status).toBe('INSUFFICIENT_DATA');
    expect(saved.proposal).toEqual({
      type: 'OBSERVATION',
      title: 'Za mało danych',
      text: 'Synthetic answer.',
      recommendation_type: 'NO_ACTION',
      safety_boundary: 'NON_AUTONOMOUS',
      supporting_evidence_refs: [],
      question_ref: null,
    });
    expect(saved.provenance).toMatchObject({ decision_rule: 'R3', recommendation_status: 'INSUFFICIENT_DATA', recommendation_type: 'NO_ACTION', question_ref: null });
  });

  it('reuses the saved analysis and recommendation when the answer message failed to save', async () => {
    const { run, repository, aiGateway } = setup();
    const executions = new Map<string, Record<string, unknown>>();
    repository.getAiExecutionByTaskIdentity.mockImplementation(async (identity: string) => executions.get(identity) ?? null);
    repository.markAiExecutionSucceeded.mockImplementation(async (args: { taskIdentity: string; result: Record<string, unknown> }) => {
      executions.set(args.taskIdentity, { id: 'exec-1', status: 'succeeded', normalized_result: args.result });
    });
    repository.linkAiExecutionToAnalysis.mockImplementation(async (args: { taskIdentity: string; analysisId: string }) => {
      executions.set(args.taskIdentity, { ...executions.get(args.taskIdentity), analysis_id: args.analysisId });
    });
    repository.insertAnalysis.mockImplementation(async () => ({ id: `analysis-${repository.insertAnalysis.mock.calls.length}` }));
    repository.getAnalysis.mockImplementation(async (_patientId: string, id: string) => ({ id, status: 'INSUFFICIENT_DATA', facts: [], unknowns: [], calculations: [], hypotheses: [], uncertainty: {}, question: null, proposal: null, rationale: '' }));
    repository.insertMessage.mockRejectedValueOnce(new Error('message insert failed'));

    await expect(run()).rejects.toThrow('message insert failed');
    await run();

    expect(aiGateway.execute).toHaveBeenCalledTimes(1);
    expect(repository.insertAnalysis).toHaveBeenCalledTimes(1);
    expect(repository.linkAiExecutionToAnalysis).toHaveBeenCalledTimes(1);
    expect(repository.insertRecommendation.mock.calls.map((call: any[]) => call[0].analysisId)).toEqual(['analysis-1', 'analysis-1']);
    expect(repository.linkConversation.mock.calls.map((call: any[]) => call[0].analysisId)).toEqual(['analysis-1', 'analysis-1']);
    expect(repository.insertMessage).toHaveBeenCalledTimes(2);
    expect(repository.finalizeJobSuccess).toHaveBeenCalledTimes(1);
  });

  it('calls the model again when the evidence changed between attempts', async () => {
    const { run, repository, aiGateway, scenario } = setup();
    await expect(run()).rejects.toThrow();
    repository.listPatientEventsByRange.mockResolvedValueOnce(scenario.events.slice(1));
    await run();
    expect(aiGateway.execute).toHaveBeenCalledTimes(2);
  });
});
