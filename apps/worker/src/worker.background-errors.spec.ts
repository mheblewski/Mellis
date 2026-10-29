import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';

// Fake repository, sync service and config only: no database, no Nightscout, no AI, no push. The database "goes down"
// by rejecting; every background entry point must log and resolve, never reject (Node 20 ends the process on an
// unhandled rejection).
const dbDown = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

function buildWorker(repository: Record<string, unknown>, nightscout: Record<string, unknown> = {}, syncEnabled = false) {
  const configService = {
    getOrThrow: vi.fn().mockReturnValue('synthetic'),
    get: vi.fn((key: string) => (key === 'NIGHTSCOUT_SYNC_ENABLED' ? String(syncEnabled) : undefined)),
  } as any;
  return new WorkerService(repository as any, nightscout as any, configService, {} as any, {} as any, {} as any, {} as any);
}

function job(overrides: Record<string, unknown> = {}) {
  return { id: 'job-1', lease_token: 'lease-1', job_type: 'nightscout.sync', attempts: 1, max_attempts: 5, payload: { source_id: 'source-1' }, ...overrides };
}

describe('worker background loops survive a database outage', () => {
  let logs: Array<Record<string, unknown>>;

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        logs.push({ level, ...JSON.parse(String(message)) });
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a failed job whose retry write fails too is logged, and processOnce resolves', async () => {
    const repository = {
      claimNextJob: vi.fn().mockResolvedValueOnce(job()).mockResolvedValue(null),
      finalizeJobRetry: vi.fn().mockRejectedValue(dbDown()),
      finalizeJobFailure: vi.fn(),
    };
    const worker = buildWorker(repository, { runNightscoutSyncJob: vi.fn().mockRejectedValue(dbDown()) });

    await expect(worker.processOnce()).resolves.toBeUndefined();

    expect(repository.finalizeJobRetry).toHaveBeenCalledTimes(1);
    expect(logs).toContainEqual(expect.objectContaining({ level: 'error', event: 'job_finalize_failed', job_id: 'job-1', error_code: 'ECONNREFUSED' }));
  });

  it('a failed job whose failure write fails too is logged, and the drain resolves', async () => {
    const repository = {
      claimNextJob: vi.fn().mockResolvedValueOnce(job({ job_type: 'conversation.time_range_analysis', payload: {} })).mockResolvedValue(null),
      finalizeJobRetry: vi.fn(),
      finalizeJobFailure: vi.fn().mockRejectedValue(dbDown()),
    };
    const worker = buildWorker(repository);

    await expect((worker as any).drainQueue()).resolves.toBeUndefined();
    expect(logs).toContainEqual(expect.objectContaining({ event: 'job_finalize_failed', error_code: 'ECONNREFUSED' }));
  });

  it('the sync lane resolves when a sync fails and its finalize write fails too', async () => {
    const repository = {
      claimNextJob: vi.fn().mockResolvedValueOnce(job()).mockResolvedValue(null),
      finalizeJobRetry: vi.fn().mockRejectedValue(dbDown()),
      finalizeJobFailure: vi.fn(),
    };
    const worker = buildWorker(repository, { runNightscoutSyncJob: vi.fn().mockRejectedValue(dbDown()) }, true);

    await expect((worker as any).drainSyncLane()).resolves.toBeUndefined();
    expect(logs).toContainEqual(expect.objectContaining({ event: 'job_finalize_failed', job_id: 'job-1' }));
  });

  it('enqueueing the recurring syncs logs a database error instead of rejecting', async () => {
    const worker = buildWorker({ claimNextJob: vi.fn().mockResolvedValue(null) }, { enqueueRecurringSyncJobs: vi.fn().mockRejectedValue(dbDown()) }, true);

    await expect((worker as any).enqueueNightscoutSyncJobs()).resolves.toBeUndefined();
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', event: 'nightscout_sync_enqueue_failed', error_code: 'ECONNREFUSED' }));
  });
});

describe('worker bolus card sessions', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('are dropped when the answer job fails before the answer is stored', async () => {
    const repository = {
      claimNextJob: vi.fn().mockResolvedValueOnce(job({ job_type: 'conversation.direct_response', payload: {} })).mockResolvedValue(null),
      finalizeJobRetry: vi.fn(),
      finalizeJobFailure: vi.fn(),
    };
    const worker = buildWorker(repository) as any;
    vi.spyOn(worker, 'handleConversationDirectResponse').mockImplementation(async () => {
      worker.bolusSessions.set('user-message-1', { used: false, proposed: [] });
      throw new Error('AI_TIMEOUT');
    });

    await worker.processOnce();

    expect(repository.finalizeJobFailure).toHaveBeenCalledTimes(1);
    expect(worker.bolusSessions.size).toBe(0);
  });
});
