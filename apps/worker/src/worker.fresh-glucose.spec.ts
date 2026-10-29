import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';
import { buildTimeRangeSyntheticScenario } from '@modules/context/application/time-range-synthetic-scenario.fixture';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const SOURCE = 'source-1';

/**
 * fresh-glucose.v1: on 2026-10-21 a reading reached Nightscout 5 s after the CGM, but GlucoMind 84 s later, after an
 * answer had used the previous one (the minute sync waited behind the 40-second answer).
 */
function setup(options: { readingAgeMs: number; syncDelayMs?: number }) {
  const now = Date.now();
  let readingAt = now - options.readingAgeMs;
  const order: string[] = [];
  const repository = {
    getCurrentState: vi.fn().mockImplementation(async () => ({ as_of: new Date(readingAt).toISOString() })),
    claimNextJob: vi.fn().mockResolvedValue(null),
    finalizeJobSuccess: vi.fn().mockResolvedValue(undefined),
    finalizeJobRetry: vi.fn().mockResolvedValue(undefined),
    finalizeJobFailure: vi.fn().mockResolvedValue(undefined),
  } as any;
  const nightscout = {
    ensureNightscoutSource: vi.fn(), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }),
    enqueueRecurringSyncJobs: vi.fn(),
    runHypoDetectionJob: vi.fn(),
    listNightscoutSources: vi.fn().mockResolvedValue([{ id: SOURCE, patient_id: PATIENT }]),
    runNightscoutSyncJob: vi.fn().mockImplementation(async (sourceId: string) => {
      order.push(`start:${sourceId}`);
      await new Promise((resolve) => setTimeout(resolve, options.syncDelayMs ?? 5));
      readingAt = Date.now() - 30_000;
      order.push(`end:${sourceId}`);
      return {};
    }),
  } as any;
  const worker = new WorkerService(repository, nightscout, { get: vi.fn().mockReturnValue(undefined), getOrThrow: vi.fn().mockReturnValue('test') } as any, {} as any, {} as any);
  return { worker, internals: worker as any, repository, nightscout, order };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkerService fresh glucose (fresh-glucose.v1)', () => {
  it('reads Nightscout before an answer when the newest reading is older than 4.5 min, and not when it is fresh', async () => {
    const stale = setup({ readingAgeMs: 6 * 60_000 });
    await stale.internals.refreshGlucoseBeforeAnswer(PATIENT);
    expect(stale.nightscout.runNightscoutSyncJob).toHaveBeenCalledTimes(1);
    expect(stale.nightscout.runNightscoutSyncJob).toHaveBeenCalledWith(SOURCE, expect.any(String));

    const fresh = setup({ readingAgeMs: 2 * 60_000 });
    await fresh.internals.refreshGlucoseBeforeAnswer(PATIENT);
    expect(fresh.nightscout.runNightscoutSyncJob).not.toHaveBeenCalled();
  });

  it('lets the answer go on after 6 s when Nightscout is slow', async () => {
    vi.useFakeTimers();
    const slow = setup({ readingAgeMs: 6 * 60_000, syncDelayMs: 60_000 });
    let done = false;
    const refresh = slow.internals.refreshGlucoseBeforeAnswer(PATIENT).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(5_900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await refresh;
    expect(done).toBe(true);
  });

  it('never runs two syncs of a source at once: the refresh waits for the running one', async () => {
    const { internals, order } = setup({ readingAgeMs: 6 * 60_000, syncDelayMs: 20 });
    await Promise.all([internals.runSourceSync(SOURCE), internals.runSourceSync(SOURCE)]);
    expect(order).toEqual([`start:${SOURCE}`, `end:${SOURCE}`, `start:${SOURCE}`, `end:${SOURCE}`]);
    expect(internals.sourceSyncs.size).toBe(0);
  });

  it('polls every 10 s only while a reading is due (5 min 5 s to 15 min after the newest one)', async () => {
    const due = setup({ readingAgeMs: 5 * 60_000 + 10_000 });
    await due.internals.pollDueReadings();
    expect(due.nightscout.runNightscoutSyncJob).toHaveBeenCalledTimes(1);

    const early = setup({ readingAgeMs: 4 * 60_000 });
    await early.internals.pollDueReadings();
    const cgmOff = setup({ readingAgeMs: 20 * 60_000 });
    await cgmOff.internals.pollDueReadings();
    expect(early.nightscout.runNightscoutSyncJob).not.toHaveBeenCalled();
    expect(cgmOff.nightscout.runNightscoutSyncJob).not.toHaveBeenCalled();
  });

  it('runs sync jobs in their own lane, and the main lane leaves them to it', async () => {
    const { internals, repository, nightscout } = setup({ readingAgeMs: 60_000 });
    repository.claimNextJob
      .mockResolvedValueOnce({ id: 'job-1', lease_token: 'lease-1', job_type: 'nightscout.sync', payload: { source_id: SOURCE }, attempts: 1, max_attempts: 5 })
      .mockResolvedValue(null);
    await internals.drainSyncLane();
    expect(repository.claimNextJob).toHaveBeenNthCalledWith(1, 'worker-1-sync', expect.any(String), 300, ['nightscout.sync']);
    expect(nightscout.runNightscoutSyncJob).toHaveBeenCalledWith(SOURCE, expect.any(String));
    expect(repository.finalizeJobSuccess).toHaveBeenCalledWith('job-1', 'lease-1', expect.any(String));

    repository.claimNextJob.mockClear();
    await internals.processOnce();
    expect(repository.claimNextJob).toHaveBeenCalledWith('worker-1', expect.any(String), 300, null, ['nightscout.sync']);
  });

  it('retries a failed sync job like the main lane', async () => {
    const { internals, repository, nightscout } = setup({ readingAgeMs: 60_000 });
    nightscout.runNightscoutSyncJob.mockRejectedValueOnce(Object.assign(new Error('NIGHTSCOUT_TIMEOUT'), { retryable: true }));
    repository.claimNextJob
      .mockResolvedValueOnce({ id: 'job-2', lease_token: 'lease-2', job_type: 'nightscout.sync', payload: { source_id: SOURCE }, attempts: 1, max_attempts: 5 })
      .mockResolvedValue(null);
    await internals.drainSyncLane();
    expect(repository.finalizeJobSuccess).not.toHaveBeenCalled();
    expect(repository.finalizeJobRetry.mock.calls.length + repository.finalizeJobFailure.mock.calls.length).toBe(1);
    expect(internals.syncLaneJob).toBeNull();
  });

  it('puts the reading the refresh imported into the answer snapshot, though it was written after the question', async () => {
    const scenario = buildTimeRangeSyntheticScenario();
    const requestedAtMs = Date.parse(scenario.requested_at);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(requestedAtMs + 20_000));
    // current_states rows: 56 taken 6 min before the question; the refresh imports 73, taken 40 s before the question
    // but written now (after it). The repository picks by the reading's own time (getCurrentStateAtOrBefore).
    const states = [{ as_of: new Date(requestedAtMs - 6 * 60_000).toISOString(), updated_at: requestedAtMs - 6 * 60_000 + 5_000, value: 56 }];
    const snapshot = (state: { as_of: string; value: number }) => ({ as_of: state.as_of, glucose: { value: state.value, trend: 'FLAT' }, iob: { value: 1.2 }, cob: { value: 0 } });
    const newest = (rows: typeof states) => [...rows].sort((left, right) => right.as_of.localeCompare(left.as_of) || right.updated_at - left.updated_at)[0];
    const userMessage = { id: 'msg-1', role: 'USER', message_type: 'USER_MESSAGE', content: scenario.user_message, created_at: scenario.requested_at, provenance_ref: 'conv/c-1/messages/m-1' };
    const repository = {
      getConversation: vi.fn().mockResolvedValue({ id: 'c-1', patient_id: scenario.patient_id, thread_state_version: 'conv-v1', awaiting_user_answer: false, messages: [userMessage] }),
      getMessageByIdempotencyKey: vi.fn().mockResolvedValue(null),
      getMessageById: vi.fn().mockResolvedValue(userMessage),
      getCurrentState: vi.fn(async () => snapshot(newest(states)!)),
      getCurrentStateAtOrBefore: vi.fn(async (_patientId: string, asOfIso: string) => {
        const row = newest(states.filter((state) => state.as_of <= asOfIso));
        return row ? snapshot(row) : null;
      }),
      listPatientEventsByRange: vi.fn(async () => scenario.events),
      listHypoEpisodesIntersectingRange: vi.fn().mockResolvedValue([]),
      listPatientContextFactsByRecordedRange: vi.fn().mockResolvedValue([]),
      insertContextPackage: vi.fn().mockResolvedValue({ id: 'pkg-1' }),
      getAiExecutionByTaskIdentity: vi.fn().mockResolvedValue(null),
      markAiExecutionRunning: vi.fn(),
      markAiExecutionSucceeded: vi.fn(),
      markAiExecutionFailed: vi.fn(),
      insertAnalysis: vi.fn().mockResolvedValue({ id: 'analysis-1', status: 'INSUFFICIENT_DATA', facts: [], unknowns: [], calculations: [], hypotheses: [], uncertainty: {}, question: null, proposal: null, rationale: '' }),
      linkAiExecutionToAnalysis: vi.fn(),
      getAnalysis: vi.fn().mockResolvedValue({ id: 'analysis-1', status: 'INSUFFICIENT_DATA', facts: [], unknowns: [], calculations: [], hypotheses: [], uncertainty: {}, question: null, proposal: null, rationale: '' }),
      insertRecommendation: vi.fn(async () => ({ id: 'rec-1', analysis_id: 'analysis-1', status: 'INSUFFICIENT_DATA', proposal: {}, evidence: [], provenance: {} })),
      linkConversation: vi.fn(),
      insertMessage: vi.fn().mockResolvedValue({ id: 'assistant-1' }),
      finalizeJobSuccess: vi.fn(),
    } as any;
    const nightscout = {
      listNightscoutSources: vi.fn().mockResolvedValue([{ id: SOURCE, patient_id: scenario.patient_id }]),
      runNightscoutSyncJob: vi.fn(async () => {
        states.push({ as_of: new Date(requestedAtMs - 40_000).toISOString(), updated_at: Date.now(), value: 73 });
        return {};
      }),
    } as any;
    const aiGateway = {
      execute: vi.fn().mockResolvedValue({
        result: { assistant_message: 'Synthetic answer.' },
        metadata: { provider: 'fake', model: 'synthetic', model_fingerprint: 'synthetic' },
        input_hash: 'sha256:synthetic',
      }),
    };
    const worker = new WorkerService(repository, nightscout, { get: vi.fn().mockReturnValue(undefined), getOrThrow: vi.fn().mockReturnValue('test') } as any, aiGateway as any, {} as any);

    await (worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', {
      patient_id: scenario.patient_id,
      conversation_id: 'c-1',
      user_message_id: 'msg-1',
      range_type: scenario.range_type,
      range_start: scenario.range_start,
      range_end: scenario.range_end,
      timezone: scenario.timezone,
      normalization_policy_version: scenario.normalization_policy_version,
    });

    expect(nightscout.runNightscoutSyncJob).toHaveBeenCalledTimes(1);
    const aiInput = JSON.stringify(aiGateway.execute.mock.calls[0]?.[0]);
    expect(aiInput).toContain('"current_glucose":73');
    expect(aiInput).not.toContain('"current_glucose":56');
  });
});
