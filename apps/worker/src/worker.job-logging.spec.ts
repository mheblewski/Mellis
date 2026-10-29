import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeJobErrorCode, WorkerService } from './worker.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';

// Fake repository, sync service and config only: no database, no Nightscout, no AI, no push.
function buildWorker(claim: () => Promise<unknown>, runNightscoutSyncJob = vi.fn()) {
  const repository = {
    claimNextJob: vi.fn(claim),
    finalizeJobSuccess: vi.fn(),
    finalizeJobRetry: vi.fn(),
    finalizeJobFailure: vi.fn(),
  } as any;
  const nightscoutSyncService = { runNightscoutSyncJob } as any;
  const configService = { getOrThrow: vi.fn().mockReturnValue('synthetic'), get: vi.fn() } as any;
  const worker = new WorkerService(repository, nightscoutSyncService, configService, {} as any, {} as any, {} as any, {} as any);
  return { worker, repository };
}

function job(overrides: Record<string, unknown>) {
  return { id: 'job-1', lease_token: 'lease-1', attempts: 1, max_attempts: 5, payload: { patient_id: PATIENT }, ...overrides };
}

describe('worker job logging', () => {
  let logs: Array<{ level: string; entry: Record<string, unknown>; raw: string }>;

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        const raw = String(message);
        logs.push({ level, entry: JSON.parse(raw), raw });
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const events = () => logs.map(({ level, entry }) => ({ level, ...entry }));

  it('logs job_claimed and a succeeded job_finished without the payload', async () => {
    const { worker, repository } = buildWorker(async () => job({ job_type: 'unknown.type' }));
    await worker.processOnce();

    expect(repository.finalizeJobSuccess).toHaveBeenCalledTimes(1);
    expect(events()).toEqual([
      { level: 'log', event: 'job_claimed', job_id: 'job-1', job_type: 'unknown.type', attempt: 1 },
      { level: 'log', event: 'job_finished', job_id: 'job-1', job_type: 'unknown.type', outcome: 'succeeded', duration_ms: expect.any(Number) },
    ]);
    expect(logs.every(({ raw }) => !raw.includes(PATIENT))).toBe(true);
  });

  it('logs a retry with the error code and keeps the existing retry handling', async () => {
    const transient = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const { worker, repository } = buildWorker(
      async () => job({ job_type: 'nightscout.sync', payload: { source_id: 'source-1' } }),
      vi.fn().mockRejectedValue(transient),
    );
    await worker.processOnce();

    expect(repository.finalizeJobRetry).toHaveBeenCalledTimes(1);
    expect(repository.finalizeJobFailure).not.toHaveBeenCalled();
    expect(events()[1]).toEqual({
      level: 'warn', event: 'job_finished', job_id: 'job-1', job_type: 'nightscout.sync', outcome: 'retry', duration_ms: expect.any(Number), error_code: 'ECONNRESET',
      error_detail: expect.stringContaining('Error'), retry_in_seconds: 60,
    });
  });

  it('logs a failure for a non-retryable error and keeps the existing failure handling', async () => {
    const { worker, repository } = buildWorker(async () => job({ job_type: 'conversation.time_range_analysis', payload: { patient_id: PATIENT } }));
    await worker.processOnce();

    expect(repository.finalizeJobFailure).toHaveBeenCalledTimes(1);
    expect(repository.finalizeJobRetry).not.toHaveBeenCalled();
    expect(events()[1]).toMatchObject({ level: 'warn', event: 'job_finished', outcome: 'failed', error_code: 'INVALID_TIME_RANGE_ANALYSIS_PAYLOAD' });
    expect(logs.every(({ raw }) => !raw.includes(PATIENT))).toBe(true);
  });

  it('logs a failure on the last attempt even when the error is retryable', async () => {
    const transient = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const { worker, repository } = buildWorker(
      async () => job({ job_type: 'nightscout.sync', attempts: 5, payload: { source_id: 'source-1' } }),
      vi.fn().mockRejectedValue(transient),
    );
    await worker.processOnce();

    expect(repository.finalizeJobFailure).toHaveBeenCalledTimes(1);
    expect(events()[1]).toMatchObject({ outcome: 'failed', error_code: 'ECONNRESET' });
  });

  it('logs job_claim_failed instead of rejecting, and the next poll still runs', async () => {
    const claim = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce(null);
    const { worker, repository } = buildWorker(claim);

    await expect(worker.processOnce()).resolves.toBeUndefined();
    await expect(worker.processOnce()).resolves.toBeUndefined();

    expect(repository.claimNextJob).toHaveBeenCalledTimes(2);
    expect(events()).toEqual([{ level: 'error', event: 'job_claim_failed', error_code: 'ECONNREFUSED' }]);
  });

  it('never logs free-text error messages', () => {
    expect(safeJobErrorCode(new Error('invalid input syntax for type uuid: "secret-value"'))).toBe('UNCLASSIFIED_ERROR');
    expect(safeJobErrorCode(Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }))).toBe('23505');
    expect(safeJobErrorCode(new Error('INVALID_TIME_RANGE_ANALYSIS_PAYLOAD'))).toBe('INVALID_TIME_RANGE_ANALYSIS_PAYLOAD');
    expect(safeJobErrorCode('plain string')).toBe('UNCLASSIFIED_ERROR');
    expect(safeJobErrorCode({ code: 'has spaces in it' })).toBe('UNCLASSIFIED_ERROR');
  });
});
