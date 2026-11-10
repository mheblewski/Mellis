import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticConsoleLogger } from './diagnostic-console-logger';
import { DiagnosticRecorder, type DiagnosticEventRow } from './diagnostic-recorder';

describe('DiagnosticConsoleLogger', () => {
  afterEach(() => {
    Logger.overrideLogger(undefined as never);
    vi.restoreAllMocks();
  });

  it('keeps structured lines of a normal Nest Logger and still prints them', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const recorder = new DiagnosticRecorder();
    const logger = new DiagnosticConsoleLogger().useRecorder(recorder);
    Logger.overrideLogger(logger);

    new Logger('Worker').warn(JSON.stringify({ event: 'push_outbox_send_failed', error_code: 'BadDeviceToken', patient_id: 'p-1' }));
    new Logger('Worker').log('plain line about Kuba');

    expect(stdout).toHaveBeenCalled();
    expect(stdout.mock.calls.map(([text]) => String(text)).join('')).toContain('push_outbox_send_failed');
    const written: DiagnosticEventRow[] = [];
    recorder.attach({ writeDiagnosticEvents: async (rows) => { written.push(...rows); }, deleteDiagnosticEventsBefore: async () => 0 }, { source: 'worker', prunes: false });
    recorder.stop();
    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toMatchObject({ event: 'push_outbox_send_failed', level: 'warn', fields: { error_code: 'BadDeviceToken' } });
    expect(JSON.stringify(written)).not.toContain('p-1');
    expect(JSON.stringify(written)).not.toContain('Kuba');
  });

  it('never fails a log call when the recorder fails', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const recorder = new DiagnosticRecorder();
    vi.spyOn(recorder, 'record').mockImplementation(() => { throw new Error('boom'); });
    const logger = new DiagnosticConsoleLogger().useRecorder(recorder);
    expect(() => logger.warn(JSON.stringify({ event: 'x' }))).not.toThrow();
  });
});
