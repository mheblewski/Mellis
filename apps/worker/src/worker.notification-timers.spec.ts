import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { glucoseReadingSignal } from '@modules/glucose-alerts/application/glucose-reading-signal';
import { WorkerService } from './worker.service';

// Audit 2026-10-26: rescue carb alerts are evaluated right after a sync stored new readings (the minute timer stays as
// the fallback), and a slow WBT reminder run is never overlapped by the next minute's. Fakes only: no database,
// Nightscout or push.
function buildWorker() {
  const repository = {
    claimNextJob: vi.fn().mockResolvedValue(null),
    finalizeJobSuccess: vi.fn(),
  } as any;
  const nightscoutSyncService = {
    runNightscoutSyncJob: vi.fn().mockResolvedValue({ entries: { imported: 1 } }),
  } as any;
  const configService = { getOrThrow: vi.fn().mockReturnValue('synthetic'), get: vi.fn((key: string) => (key === 'NIGHTSCOUT_SYNC_ENABLED' ? false : undefined)) } as any;
  const worker = new WorkerService(repository, nightscoutSyncService, configService, {} as any, {} as any);
  return { worker, nightscoutSyncService };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle(worker: WorkerService): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.all([...(worker as any).backgroundRuns]);
}

describe('rescue carb alerts after a new reading', () => {
  it('evaluates once a sync stored new readings, only where the minute timer runs', async () => {
    const { worker, nightscoutSyncService } = buildWorker();
    const run = vi.fn().mockResolvedValue({});
    (worker as any).rescueCarbAlerts = { run };

    // No timer (restricted worker or RESCUE_CARB_ALERTS_ENABLED off): nothing.
    await (worker as any).runSourceSync('source-1');
    await settle(worker);
    expect(run).not.toHaveBeenCalled();

    (worker as any).rescueCarbTimer = setInterval(() => undefined, 60_000);
    try {
      await (worker as any).runSourceSync('source-1');
      await settle(worker);
      expect(run).toHaveBeenCalledTimes(1);

      // A sync without new readings evaluates nothing.
      nightscoutSyncService.runNightscoutSyncJob.mockResolvedValueOnce({ entries: { imported: 0 } });
      await (worker as any).runSourceSync('source-1');
      await settle(worker);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      clearInterval((worker as any).rescueCarbTimer);
    }
  });

  it('a reading that comes during a running evaluation gets one more evaluation after it', async () => {
    const { worker } = buildWorker();
    const first = deferred();
    const run = vi.fn().mockReturnValueOnce(first.promise.then(() => ({}))).mockResolvedValue({});
    (worker as any).rescueCarbAlerts = { run };
    (worker as any).rescueCarbTimer = setInterval(() => undefined, 60_000);
    try {
      const timerRun = worker.evaluateRescueCarbAlerts();
      await (worker as any).runSourceSync('source-1');
      await (worker as any).runSourceSync('source-1');
      expect(run).toHaveBeenCalledTimes(1);
      first.resolve();
      await timerRun;
      await settle(worker);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      clearInterval((worker as any).rescueCarbTimer);
    }
  });
  it('signals the glucose push after the rescue run that saw the reading, not after a minute run (2026-11-14)', async () => {
    const { worker, nightscoutSyncService } = buildWorker();
    const order: string[] = [];
    const signals: Date[] = [];
    const unsubscribe = glucoseReadingSignal.subscribe((at) => { order.push('glucose'); signals.push(at); });
    const first = deferred();
    const run = vi.fn()
      .mockImplementationOnce(() => first.promise.then(() => { order.push('rescue-minute'); return {}; }))
      .mockImplementation(async () => { order.push('rescue-after-reading'); return {}; });
    (worker as any).rescueCarbAlerts = { run };
    (worker as any).rescueCarbTimer = setInterval(() => undefined, 60_000);
    try {
      // A minute run alone signals nothing.
      const minute = worker.evaluateRescueCarbAlerts();
      // The reading is stored while it runs: the glucose push waits for the rerun that sees it.
      const syncedAt = Date.now();
      await (worker as any).runSourceSync('source-1');
      expect(order).toEqual([]);
      first.resolve();
      await minute;
      await settle(worker);
      expect(order).toEqual(['rescue-minute', 'rescue-after-reading', 'glucose']);
      expect(signals[0].getTime()).toBeGreaterThanOrEqual(syncedAt);

      // A sync without new readings signals nothing.
      nightscoutSyncService.runNightscoutSyncJob.mockResolvedValueOnce({ entries: { imported: 0 } });
      await (worker as any).runSourceSync('source-1');
      await settle(worker);
      expect(signals).toHaveLength(1);
    } finally {
      clearInterval((worker as any).rescueCarbTimer);
      unsubscribe();
    }
  });

  it('signals the glucose push at once where rescue alerts do not run', async () => {
    const { worker } = buildWorker();
    const signals: Date[] = [];
    const unsubscribe = glucoseReadingSignal.subscribe((at) => signals.push(at));
    try {
      await (worker as any).runSourceSync('source-1');
      await settle(worker);
      expect(signals).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });
});

describe('WBT reminder timer', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it('never starts a run while the previous one is still going', async () => {
    const { worker } = buildWorker();
    // The unrestricted worker (NIGHTSCOUT_SYNC_ENABLED=false alone would make it restricted).
    (worker as any).allowedJobTypes = null;
    (worker as any).mealWbtRepository = {};
    const slow = deferred();
    const dispatch = vi.spyOn(worker, 'dispatchDueWbtReminders').mockReturnValueOnce(slow.promise).mockResolvedValue(undefined);
    await worker.onModuleInit();

    await vi.advanceTimersByTimeAsync(180_000);
    expect(dispatch).toHaveBeenCalledTimes(1);

    slow.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dispatch).toHaveBeenCalledTimes(2);

    await worker.onModuleDestroy();
  });
});
