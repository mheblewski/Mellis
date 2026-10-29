import { describe, expect, it, vi } from 'vitest';
import { resolveAllowedJobTypes, WorkerService, WORKER_HANDLED_JOB_TYPES } from './worker.service';

// Fake repository and config only: no database, no worker timers, no Nightscout sync, no AI, no push.
function buildWorker(workerJobTypes: unknown) {
  const repository = {
    claimNextJob: vi.fn().mockResolvedValue(null),
    finalizeJobSuccess: vi.fn(),
    finalizeJobRetry: vi.fn(),
    finalizeJobFailure: vi.fn(),
  } as any;
  const config = { getOrThrow: vi.fn().mockReturnValue('test'), get: vi.fn((key: string) => (key === 'WORKER_JOB_TYPES' ? workerJobTypes : undefined)) } as any;
  const create = () => new WorkerService(repository, { ensureNightscoutSource: vi.fn(), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }), enqueueRecurringSyncJobs: vi.fn() } as any, config, {} as any, {} as any, {} as any, {} as any);
  return { repository, create };
}

describe('restricted worker job types (WORKER_JOB_TYPES)', () => {
  it('passes only the allowed job types to claimNextJob', async () => {
    const { repository, create } = buildWorker(['nightscout.sync', 'meal.wbt_suggestion']);
    await create().processOnce();
    expect(repository.claimNextJob).toHaveBeenCalledWith('worker-1', expect.any(String), 300, ['nightscout.sync', 'meal.wbt_suggestion']);
  });

  it('keeps the default behaviour (no filter) when unset', async () => {
    const { repository, create } = buildWorker(undefined);
    await create().processOnce();
    // Unrestricted: Nightscout syncs run in their own lane (fresh-glucose.v1).
    expect(repository.claimNextJob).toHaveBeenCalledWith('worker-1', expect.any(String), 300, null, ['nightscout.sync']);
  });

  it('refuses to start with an empty, malformed or unhandled list instead of claiming everything', () => {
    expect(() => buildWorker('').create()).toThrow('WORKER_JOB_TYPES is set but empty');
    expect(() => buildWorker([]).create()).toThrow('WORKER_JOB_TYPES is set but empty');
    expect(() => buildWorker('nightscout sync').create()).toThrow('invalid job types');
    expect(() => buildWorker('nightscout.sync,meal-history.intake_carb_entry').create()).toThrow('does not handle: meal-history.intake_carb_entry');
    // The macro proposal job was removed with the old meal description endpoints.
    expect(() => buildWorker('meal-history.propose_macros').create()).toThrow('does not handle: meal-history.propose_macros');
  });

  it('accepts the raw string form and every handled job type', () => {
    expect(resolveAllowedJobTypes('nightscout.sync, meal.wbt_suggestion')).toEqual(['nightscout.sync', 'meal.wbt_suggestion']);
    expect(resolveAllowedJobTypes('nightscout.sync,meal.wbt_suggestion,meal.chat_reply'))
      .toEqual(['nightscout.sync', 'meal.wbt_suggestion', 'meal.chat_reply']);
    expect(resolveAllowedJobTypes(WORKER_HANDLED_JOB_TYPES.join(','))).toEqual([...WORKER_HANDLED_JOB_TYPES]);
    expect(resolveAllowedJobTypes(null)).toBeNull();
  });
});
