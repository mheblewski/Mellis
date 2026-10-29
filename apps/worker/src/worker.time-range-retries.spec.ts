import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';
import { buildTimeRangeSyntheticScenario } from '@modules/context/application/time-range-synthetic-scenario.fixture';

// Time-range job retries: a succeeded AI execution is reused instead of calling the model again for the same question.
// Offline: fake repository and gateway, synthetic scenario, no database or provider.

function setup(options: { failAnalysisInsertOnce?: boolean; failMarkSucceededOnce?: boolean; aiError?: Error } = {}) {
  const scenario = buildTimeRangeSyntheticScenario();
  const executions = new Map<string, Record<string, unknown>>();
  let failAnalysisInsert = options.failAnalysisInsertOnce ?? false;
  let failMarkSucceeded = options.failMarkSucceededOnce ?? false;
  const userMessage = { id: 'msg-1', role: 'USER', message_type: 'USER_MESSAGE', content: scenario.user_message, created_at: scenario.requested_at, provenance_ref: 'conv/c-1/messages/m-1' };
  const analysis = { id: 'analysis-1', status: 'INSUFFICIENT_DATA', facts: [], unknowns: [], calculations: [], hypotheses: [], uncertainty: {}, question: null, proposal: null, rationale: '' };
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
      if (failMarkSucceeded) {
        failMarkSucceeded = false;
        throw Object.assign(new Error('saving the AI result failed'), { code: 'ECONNRESET' });
      }
      executions.set(args.taskIdentity, { ...executions.get(args.taskIdentity), status: 'succeeded', normalized_result: args.result });
    }),
    markAiExecutionFailed: vi.fn(async (args: { taskIdentity: string }) => {
      executions.set(args.taskIdentity, { ...executions.get(args.taskIdentity), status: 'failed' });
    }),
    insertAnalysis: vi.fn(async () => {
      if (failAnalysisInsert) {
        failAnalysisInsert = false;
        throw Object.assign(new Error('analysis insert failed after the AI call'), { code: 'ECONNRESET' });
      }
      return analysis;
    }),
    linkAiExecutionToAnalysis: vi.fn(),
    getAnalysis: vi.fn().mockResolvedValue(analysis),
    insertRecommendation: vi.fn(async () => ({ id: 'rec-1', analysis_id: 'analysis-1', status: 'INSUFFICIENT_DATA', proposal: {}, evidence: [], provenance: {} })),
    linkConversation: vi.fn(),
    insertMessage: vi.fn().mockResolvedValue({ id: 'assistant-1' }),
    finalizeJobSuccess: vi.fn(),
  } as any;
  const aiGateway = {
    execute: options.aiError
      ? vi.fn().mockRejectedValue(options.aiError)
      : vi.fn().mockResolvedValue({
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

describe('time-range job retries', () => {
  it('calls the model exactly once on the first attempt', async () => {
    const { run, aiGateway, repository } = setup();
    await run();
    expect(aiGateway.execute).toHaveBeenCalledTimes(1);
    expect(repository.finalizeJobSuccess).toHaveBeenCalledTimes(1);
  });

  it('reuses a persisted result after a later write failure, without a second call', async () => {
    const { run, aiGateway, repository } = setup({ failAnalysisInsertOnce: true });
    await expect(run()).rejects.toThrow('analysis insert failed after the AI call');
    await run();
    expect(aiGateway.execute).toHaveBeenCalledTimes(1);
    expect(repository.insertMessage).toHaveBeenCalledTimes(1);
    expect(repository.finalizeJobSuccess).toHaveBeenCalledTimes(1);
  });

  it('calls the model again when the evidence of a retry changed (new task identity)', async () => {
    const { run, aiGateway, repository, scenario } = setup({ failAnalysisInsertOnce: true });
    await expect(run()).rejects.toThrow();
    repository.listPatientEventsByRange.mockResolvedValueOnce(scenario.events.slice(1));
    await run();
    expect(aiGateway.execute).toHaveBeenCalledTimes(2);
  });
});
