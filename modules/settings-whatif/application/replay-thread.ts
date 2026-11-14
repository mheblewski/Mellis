import { existsSync } from 'fs';
import { Worker } from 'worker_threads';

/**
 * Replays are seconds of pure computing (a minute and more on a small server). In the API they run in a worker thread,
 * so the dashboard, remote commands and everything else keep answering meanwhile. Where the compiled thread file is not
 * there (tests, tsx), the task runs inline.
 */
export const REPLAY_THREAD_TIME_LIMIT_MS = 5 * 60_000;

export function runInThread<T>(file: string, task: unknown, inline: () => T, timeLimitMs: number = REPLAY_THREAD_TIME_LIMIT_MS): Promise<T> {
  if (!existsSync(file)) return Promise.resolve().then(inline);
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(file, { workerData: task });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => done(() => { void worker.terminate(); reject(new Error('REPLAY_TIME_LIMIT')); }), timeLimitMs);
    worker.once('message', (result: T) => done(() => { resolve(result); void worker.terminate(); }));
    worker.once('error', (error) => done(() => reject(error)));
    worker.once('exit', (code) => done(() => reject(new Error(`REPLAY_THREAD_EXIT_${code}`))));
  });
}
