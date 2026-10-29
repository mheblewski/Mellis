import { describe, expect, it, vi } from 'vitest';
import { AUDIT_RETENTION_BATCH, pruneAuditEventsIfDue } from './audit-retention';

const NOW = new Date('2026-10-21T12:00:00.000Z');

describe('pruneAuditEventsIfDue', () => {
  it('deletes one batch older than 180 days, then waits an hour before the next run', async () => {
    const store = { deleteAuditEventsOlderThan: vi.fn(async () => 3) };
    const log = vi.fn();
    const state = { lastRunMs: null };

    expect(await pruneAuditEventsIfDue(store, log, NOW, state)).toBe(3);
    expect(store.deleteAuditEventsOlderThan).toHaveBeenCalledWith('2026-04-24T12:00:00.000Z', AUDIT_RETENTION_BATCH);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit_events_pruned', deleted: 3 }));

    expect(await pruneAuditEventsIfDue(store, log, new Date(NOW.getTime() + 59 * 60_000), state)).toBe(0);
    expect(store.deleteAuditEventsOlderThan).toHaveBeenCalledTimes(1);
    await pruneAuditEventsIfDue(store, log, new Date(NOW.getTime() + 60 * 60_000), state);
    expect(store.deleteAuditEventsOlderThan).toHaveBeenCalledTimes(2);
  });

  it('never throws: a database error is logged', async () => {
    const store = { deleteAuditEventsOlderThan: vi.fn(async () => { throw new Error('connection terminated'); }) };
    const log = vi.fn();
    await expect(pruneAuditEventsIfDue(store, log, NOW, { lastRunMs: null })).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith({ event: 'audit_events_prune_failed', error: 'connection terminated' });
  });
});
