import { describe, expect, it, vi } from 'vitest';
import { DIAGNOSTIC_MAX_PENDING, DiagnosticRecorder, type DiagnosticEventRow } from './diagnostic-recorder';

function writer(fail = false) {
  const written: DiagnosticEventRow[][] = [];
  return {
    written,
    deleted: [] as string[],
    fail,
    async writeDiagnosticEvents(rows: DiagnosticEventRow[]) {
      if (this.fail) throw new Error('db down');
      written.push(rows);
    },
    async deleteDiagnosticEventsBefore(cutoff: string) {
      this.deleted.push(cutoff);
      return 0;
    },
  };
}

const event = (name: string, duration_ms: number | null = null) => ({ level: 'warn' as const, event: name, fields: { code: 'X' }, duration_ms });

describe('DiagnosticRecorder', () => {
  it('counts the same event within ten minutes as one row', async () => {
    const recorder = new DiagnosticRecorder();
    const store = writer();
    recorder.record(event('a', 10), new Date('2026-11-07T10:01:00Z'));
    recorder.record(event('a', 30), new Date('2026-11-07T10:02:00Z'));
    recorder.record(event('a'), new Date('2026-11-07T10:11:00Z'));
    recorder.attach(store, { source: 'worker', prunes: false });
    recorder.stop();
    await vi.waitFor(() => expect(store.written.length).toBe(1));
    const [first, second] = store.written[0];
    expect(first).toMatchObject({ source: 'worker', count: 2, first_at: '2026-11-07T10:01:00.000Z', last_at: '2026-11-07T10:02:00.000Z', duration_ms_total: 40, duration_ms_max: 30, bucket_start: '2026-11-07T10:00:00.000Z' });
    expect(second).toMatchObject({ count: 1, bucket_start: '2026-11-07T10:10:00.000Z' });
  });

  it('keeps rows after a failed write, and never grows past the limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const recorder = new DiagnosticRecorder();
    const store = writer(true);
    recorder.attach(store, { source: 'api', prunes: false });
    recorder.stop();
    await vi.waitFor(() => expect(warn).not.toHaveBeenCalled());
    for (let index = 0; index < DIAGNOSTIC_MAX_PENDING + 50; index += 1) recorder.record(event(`e${index}`), new Date('2026-11-07T10:01:00Z'));
    await recorder.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    store.fail = false;
    await recorder.flush();
    expect(store.written[0]).toHaveLength(DIAGNOSTIC_MAX_PENDING);
    warn.mockRestore();
  });

  it('prunes at most hourly, and only where asked', async () => {
    const recorder = new DiagnosticRecorder();
    const store = writer();
    recorder.attach(store, { source: 'worker', prunes: true });
    recorder.stop();
    await vi.waitFor(() => expect(store.deleted.length).toBe(1));
    await recorder.flush(new Date(Date.now() + 30 * 60_000));
    expect(store.deleted.length).toBe(1);
    await recorder.flush(new Date(Date.now() + 90 * 60_000));
    expect(store.deleted.length).toBe(2);
  });
});
