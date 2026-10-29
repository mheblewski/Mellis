import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveClaimableJobTypes, resolveNightscoutSyncEnabled, WorkerService, WORKER_HANDLED_JOB_TYPES } from './worker.service';

// Fake repository, sync service and config only: no database, no Nightscout, no AI, no push. Timers are faked.
function buildWorker(config: Record<string, unknown>) {
  const repository = {
    claimNextJob: vi.fn().mockResolvedValue(null),
    finalizeJobSuccess: vi.fn(),
    finalizeJobRetry: vi.fn(),
    finalizeJobFailure: vi.fn(),
  } as any;
  const nightscoutSyncService = {
    ensureNightscoutSource: vi.fn().mockResolvedValue({}), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }),
    enqueueRecurringSyncJobs: vi.fn().mockResolvedValue({ sources: 1, jobs_enqueued: 1 }),
  } as any;
  const configService = {
    getOrThrow: vi.fn().mockReturnValue('synthetic'),
    get: vi.fn((key: string) => config[key]),
  } as any;
  const create = () => new WorkerService(repository, nightscoutSyncService, configService, {} as any, {} as any, {} as any, {} as any);
  return { repository, nightscoutSyncService, create };
}

describe('NIGHTSCOUT_SYNC_ENABLED worker switch', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it('keeps the default behaviour when unset: prepares the sources and schedules sync at start and every minute', async () => {
    const { repository, nightscoutSyncService, create } = buildWorker({});
    const worker = create();
    await worker.onModuleInit();

    expect(nightscoutSyncService.prepareNightscoutSources).toHaveBeenCalledTimes(1);
    expect(nightscoutSyncService.enqueueRecurringSyncJobs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(nightscoutSyncService.enqueueRecurringSyncJobs).toHaveBeenCalledTimes(2);
    // Unrestricted: Nightscout syncs run in their own lane (fresh-glucose.v1).
    expect(repository.claimNextJob).toHaveBeenCalledWith('worker-1', expect.any(String), 300, null, ['nightscout.sync']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"nightscout_sync":"ENABLED"'));

    await worker.onModuleDestroy();
  });

  it('registers no source, schedules no sync and claims no nightscout.sync when disabled', async () => {
    const { repository, nightscoutSyncService, create } = buildWorker({ NIGHTSCOUT_SYNC_ENABLED: false });
    const worker = create();
    await worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(180_000);

    expect(nightscoutSyncService.prepareNightscoutSources).not.toHaveBeenCalled();
    expect(nightscoutSyncService.enqueueRecurringSyncJobs).not.toHaveBeenCalled();
    const claimedTypes = repository.claimNextJob.mock.calls[0][3] as string[];
    expect(claimedTypes).not.toContain('nightscout.sync');
    expect(claimedTypes).toContain('conversation.time_range_analysis');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"nightscout_sync":"DISABLED"'));

    await worker.onModuleDestroy();
  });

  it('still claims conversation.time_range_analysis in the local restricted setup (raw string config)', async () => {
    const { repository, nightscoutSyncService, create } = buildWorker({
      NIGHTSCOUT_SYNC_ENABLED: 'false',
      WORKER_JOB_TYPES: 'conversation.time_range_analysis',
    });
    const worker = create();
    await worker.onModuleInit();

    expect(nightscoutSyncService.prepareNightscoutSources).not.toHaveBeenCalled();
    expect(nightscoutSyncService.enqueueRecurringSyncJobs).not.toHaveBeenCalled();
    expect(repository.claimNextJob).toHaveBeenCalledWith('worker-1', expect.any(String), 300, ['conversation.time_range_analysis']);

    await worker.onModuleDestroy();
  });

  it('refuses to start when nightscout.sync is requested while sync is disabled, or the value is malformed', () => {
    expect(() => buildWorker({ NIGHTSCOUT_SYNC_ENABLED: false, WORKER_JOB_TYPES: 'nightscout.sync' }).create())
      .toThrow('WORKER_JOB_TYPES includes nightscout.sync while NIGHTSCOUT_SYNC_ENABLED=false');
    expect(() => buildWorker({ NIGHTSCOUT_SYNC_ENABLED: 'off' }).create()).toThrow('NIGHTSCOUT_SYNC_ENABLED must be true/false or 1/0');
  });

  it('resolves the switch and the claimable job types', () => {
    expect(resolveNightscoutSyncEnabled(undefined)).toBe(true);
    expect(resolveNightscoutSyncEnabled('')).toBe(true);
    expect(resolveNightscoutSyncEnabled(true)).toBe(true);
    expect(resolveNightscoutSyncEnabled('1')).toBe(true);
    expect(resolveNightscoutSyncEnabled(' FALSE ')).toBe(false);
    expect(resolveNightscoutSyncEnabled('0')).toBe(false);

    expect(resolveClaimableJobTypes(null, true)).toBeNull();
    expect(resolveClaimableJobTypes(['nightscout.sync'], true)).toEqual(['nightscout.sync']);
    expect(resolveClaimableJobTypes(null, false)).toEqual(WORKER_HANDLED_JOB_TYPES.filter((type) => type !== 'nightscout.sync'));
    expect(resolveClaimableJobTypes(['conversation.time_range_analysis'], false)).toEqual(['conversation.time_range_analysis']);
  });
});
