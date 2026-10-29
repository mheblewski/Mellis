import { Logger } from '@nestjs/common';

// Hard upper bound for the whole shutdown (job grace period + pool end). Past it the process exits anyway, so a
// hung pg client, an open APNs http2 session or a stuck provider call can never leave a second worker running.
export const WORKER_SHUTDOWN_DEADLINE_MS = 10_000;

export interface ClosableApp {
  close(): Promise<void>;
}

export interface ShutdownProcess {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  exit(code: number): void;
}

/**
 * SIGTERM/SIGINT close the Nest context (WorkerService stops claiming and settles its in-flight job, then the pool is
 * ended) and always end with process.exit: app.close() resolving does not end the process while any socket or timer
 * is still referenced. Repeated signals are ignored (`kill` on both the tsx parent and the node child delivers the
 * same SIGTERM twice); the deadline still applies.
 */
export function installGracefulShutdown(
  app: ClosableApp,
  options: { process?: ShutdownProcess; deadlineMs?: number; logger?: Pick<Logger, 'log' | 'error'> } = {},
): void {
  const proc = options.process ?? process;
  const deadlineMs = options.deadlineMs ?? WORKER_SHUTDOWN_DEADLINE_MS;
  const logger = options.logger ?? new Logger('WorkerShutdown');
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const startedAtMs = Date.now();
    logger.log(JSON.stringify({ event: 'worker_shutdown_started', signal }));

    const deadline = setTimeout(() => {
      logger.error(JSON.stringify({ event: 'worker_shutdown_deadline_exceeded', signal, deadline_ms: deadlineMs }));
      proc.exit(1);
    }, deadlineMs);

    app.close().then(
      () => {
        clearTimeout(deadline);
        logger.log(JSON.stringify({ event: 'worker_shutdown_completed', signal, duration_ms: Date.now() - startedAtMs }));
        proc.exit(0);
      },
      (error: unknown) => {
        clearTimeout(deadline);
        logger.error(JSON.stringify({ event: 'worker_shutdown_failed', signal, error: error instanceof Error ? error.name : 'unknown' }));
        proc.exit(1);
      },
    );
  };

  proc.on('SIGTERM', shutdown);
  proc.on('SIGINT', shutdown);
}
