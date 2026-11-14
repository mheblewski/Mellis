import { describe, expect, it, vi } from 'vitest';
import { GlucoseAlertWorker } from './application/glucose-alert-worker';
import { glucoseReadingSignal } from './application/glucose-reading-signal';

// glucose-push-fast (2026-11-14): a new reading judged by the rescue alert runs the glucose push at once; a signal
// during a run gives one more run with that judgement. Fake service only.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function workerWith(run: (now: Date, options: { rescueJudgedAt?: Date }) => Promise<void>) {
  const worker = Object.create(GlucoseAlertWorker.prototype) as GlucoseAlertWorker;
  Object.assign(worker, { service: { run }, running: false, rerun: false, pendingRescueJudgedAt: null, timer: null, unsubscribe: null });
  return worker;
}

describe('GlucoseAlertWorker after a new reading', () => {
  it('runs on the signal with the judgement and stops listening on destroy', async () => {
    const run = vi.fn(async () => undefined);
    const worker = workerWith(run);
    worker.onModuleInit();
    const at = new Date('2026-11-14T14:33:15Z');
    glucoseReadingSignal.notify(at);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledWith(expect.any(Date), { rescueJudgedAt: at });
    worker.onModuleDestroy();
    glucoseReadingSignal.notify(at);
    await new Promise((done) => setTimeout(done, 0));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a signal during a minute run gives one more run right after it', async () => {
    const first = deferred();
    const run = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    const worker = workerWith(run);
    const minute = worker.tick();
    const at = new Date('2026-11-14T14:33:15Z');
    void worker.tick(at);
    void worker.tick(new Date('2026-11-14T14:33:10Z'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenNthCalledWith(1, expect.any(Date), {});
    first.resolve();
    await minute;
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(2, expect.any(Date), { rescueJudgedAt: at });
  });
});
