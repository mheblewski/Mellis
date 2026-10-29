import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGracefulShutdown, type ShutdownProcess } from './shutdown';
import { WorkerService, WORKER_SHUTDOWN_GRACE_MS } from './worker.service';

// Fake repository, config and process only: no database, no Nightscout, no AI, no push, no real signals. Timers are faked.
function claim(id: string) {
  return { id, lease_token: `lease-${id}`, job_type: 'unknown.type', payload_version: 1, payload: {}, attempts: 1, max_attempts: 5 };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function buildWorker(repository: Record<string, unknown>) {
  const configService = {
    getOrThrow: vi.fn().mockReturnValue('synthetic'),
    get: vi.fn((key: string) => (key === 'NIGHTSCOUT_SYNC_ENABLED' ? 'false' : undefined)),
  } as any;
  const nightscoutSyncService = { ensureNightscoutSource: vi.fn(), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }), enqueueRecurringSyncJobs: vi.fn() } as any;
  return new WorkerService(repository as any, nightscoutSyncService, configService, {} as any, {} as any, {} as any, {} as any);
}

function fakeProcess() {
  const listeners = new Map<string, (signal: NodeJS.Signals) => void>();
  const proc: ShutdownProcess & { exit: ReturnType<typeof vi.fn> } = {
    on: (signal, listener) => listeners.set(signal, listener),
    exit: vi.fn(),
  };
  return { proc, emit: (signal: NodeJS.Signals) => listeners.get(signal)?.(signal) };
}

const silentLogger = { log: vi.fn(), error: vi.fn() };

describe('worker graceful shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('WorkerService.stop', () => {
    it('clears the poll timer so nothing is claimed after the stop', async () => {
      const repository = { claimNextJob: vi.fn().mockResolvedValue(null), releaseJobLease: vi.fn() };
      const worker = buildWorker(repository);
      await worker.onModuleInit();
      await vi.advanceTimersByTimeAsync(0);
      const claimsBeforeStop = repository.claimNextJob.mock.calls.length;

      await worker.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(repository.claimNextJob).toHaveBeenCalledTimes(claimsBeforeStop);
      expect(repository.releaseJobLease).not.toHaveBeenCalled();
    });

    it('lets an in-flight job that finishes within the grace period complete, without releasing its lease', async () => {
      const finalize = deferred<{ rowCount: number; ownershipLost: boolean }>();
      const repository = {
        claimNextJob: vi.fn().mockResolvedValueOnce(claim('job-1')).mockResolvedValue(null),
        finalizeJobSuccess: vi.fn().mockReturnValue(finalize.promise),
        releaseJobLease: vi.fn(),
      };
      const worker = buildWorker(repository);
      const processing = worker.processOnce();
      await vi.advanceTimersByTimeAsync(0);

      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopped).toBe(false);

      finalize.resolve({ rowCount: 1, ownershipLost: false });
      await stopping;
      await processing;

      expect(repository.finalizeJobSuccess).toHaveBeenCalledWith('job-1', 'lease-job-1', expect.any(String));
      expect(repository.releaseJobLease).not.toHaveBeenCalled();
      expect(repository.claimNextJob).toHaveBeenCalledTimes(1);
    });

    it('releases the lease of a job still running after the grace period, so stop resolves in bounded time', async () => {
      const repository = {
        claimNextJob: vi.fn().mockResolvedValueOnce(claim('job-slow')),
        finalizeJobSuccess: vi.fn().mockReturnValue(new Promise(() => undefined)),
        releaseJobLease: vi.fn().mockResolvedValue({ rowCount: 1, ownershipLost: false }),
      };
      const worker = buildWorker(repository);
      void worker.processOnce();
      await vi.advanceTimersByTimeAsync(0);

      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(WORKER_SHUTDOWN_GRACE_MS - 1);
      expect(stopped).toBe(false);
      expect(repository.releaseJobLease).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await stopping;

      expect(repository.releaseJobLease).toHaveBeenCalledTimes(1);
      expect(repository.releaseJobLease).toHaveBeenCalledWith('job-slow', 'lease-job-slow', expect.any(String));
    });

    it('does not start a job claimed while the stop began, and hands its lease back', async () => {
      const claimResult = deferred<ReturnType<typeof claim>>();
      const repository = {
        claimNextJob: vi.fn().mockReturnValueOnce(claimResult.promise),
        finalizeJobSuccess: vi.fn(),
        releaseJobLease: vi.fn().mockResolvedValue({ rowCount: 1, ownershipLost: false }),
      };
      const worker = buildWorker(repository);
      const processing = worker.processOnce();

      const stopping = worker.stop();
      claimResult.resolve(claim('job-late'));
      await processing;
      await stopping;

      expect(repository.finalizeJobSuccess).not.toHaveBeenCalled();
      expect(repository.releaseJobLease).toHaveBeenCalledWith('job-late', 'lease-job-late', expect.any(String));
    });

    it('is idempotent: repeated stops share one wait and release at most once', async () => {
      const repository = {
        claimNextJob: vi.fn().mockResolvedValueOnce(claim('job-twice')),
        finalizeJobSuccess: vi.fn().mockReturnValue(new Promise(() => undefined)),
        releaseJobLease: vi.fn().mockResolvedValue({ rowCount: 1, ownershipLost: false }),
      };
      const worker = buildWorker(repository);
      void worker.processOnce();
      await vi.advanceTimersByTimeAsync(0);

      const first = worker.stop();
      const second = worker.onModuleDestroy();
      expect(second).toBe(first);
      await vi.advanceTimersByTimeAsync(WORKER_SHUTDOWN_GRACE_MS);
      await first;

      expect(repository.releaseJobLease).toHaveBeenCalledTimes(1);
    });

    it('waits for a running timer task (a reminder marked SENT, its push still on the way) before it resolves', async () => {
      const worker = buildWorker({ claimNextJob: vi.fn().mockResolvedValue(null) });
      const push = deferred();
      const internals = worker as any;
      internals.runInBackground(() => push.promise);

      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopped).toBe(false);

      push.resolve();
      await stopping;
      expect(internals.backgroundRuns.size).toBe(0);
    });

    it('stops waiting for a hanging timer task after the grace period', async () => {
      const worker = buildWorker({ claimNextJob: vi.fn().mockResolvedValue(null) });
      (worker as any).runInBackground(() => new Promise<void>(() => undefined));

      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(WORKER_SHUTDOWN_GRACE_MS - 1);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toBe(true);
    });

    it('runs the loop-action and reminder timers through the tracked runner', async () => {
      const worker = buildWorker({ claimNextJob: vi.fn().mockResolvedValue(null) });
      const internals = worker as any;
      // The unrestricted worker runs these timers.
      internals.allowedJobTypes = null;
      internals.loopActionRepository = {};
      internals.mealWbtRepository = {};
      const runner = vi.spyOn(internals, 'runInBackground').mockImplementation(() => undefined);
      await worker.onModuleInit();
      await vi.advanceTimersByTimeAsync(60_000);

      // Loop actions twice (every 30 s), the audit retention and the WBT reminders once.
      expect(runner).toHaveBeenCalledTimes(4);
      await worker.stop();
    });
  });

  describe('installGracefulShutdown', () => {
    it('closes the app once on SIGTERM and exits 0, ignoring a repeated signal', async () => {
      const app = { close: vi.fn().mockResolvedValue(undefined) };
      const { proc, emit } = fakeProcess();
      installGracefulShutdown(app, { process: proc, deadlineMs: 10_000, logger: silentLogger });

      emit('SIGTERM');
      emit('SIGTERM');
      emit('SIGINT');
      await vi.advanceTimersByTimeAsync(0);

      expect(app.close).toHaveBeenCalledTimes(1);
      expect(proc.exit).toHaveBeenCalledTimes(1);
      expect(proc.exit).toHaveBeenCalledWith(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(proc.exit).toHaveBeenCalledTimes(1);
    });

    it('exits 1 at the deadline when close hangs', async () => {
      const app = { close: vi.fn().mockReturnValue(new Promise(() => undefined)) };
      const { proc, emit } = fakeProcess();
      installGracefulShutdown(app, { process: proc, deadlineMs: 10_000, logger: silentLogger });

      emit('SIGTERM');
      await vi.advanceTimersByTimeAsync(9_999);
      expect(proc.exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(proc.exit).toHaveBeenCalledWith(1);
    });

    it('exits 1 when close fails', async () => {
      const app = { close: vi.fn().mockRejectedValue(new Error('pool end failed')) };
      const { proc, emit } = fakeProcess();
      installGracefulShutdown(app, { process: proc, logger: silentLogger });

      emit('SIGINT');
      await vi.advanceTimersByTimeAsync(0);

      expect(proc.exit).toHaveBeenCalledWith(1);
    });
  });
});
