import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresMealEntryDetachment } from './postgres-meal-history.repository';

const PATIENT = '11111111-1111-4111-8111-111111111111';

function fakePool(options: { failRollback: boolean }) {
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql === 'ROLLBACK' && options.failRollback) throw new Error('connection terminated');
      return { rows: [], rowCount: 0 };
    }),
    release,
  };
  return { pool: { connect: vi.fn(async () => client) } as unknown as Pool, client, release };
}

// A malformed event id finds no meal: nothing to detach from a non-meal anchor (commit), and "not part of a meal" for a
// caregiver's detach (rollback), so both transaction endings run without a database.
describe('PostgresMealEntryDetachment transaction handling', () => {
  it('commits under the per-patient meal lock and returns the client to the pool', async () => {
    const { pool, client, release } = fakePool({ failRollback: false });
    await expect(new PostgresMealEntryDetachment(pool).detachMealEntriesFromNonMealAnchor(PATIENT, 'not-a-uuid', null))
      .resolves.toEqual({ detached_event_ids: [], meal_record_id: null });
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SELECT pg_advisory_xact_lock(hashtext($1))', 'COMMIT']);
    expect(release).toHaveBeenCalledWith();
  });

  it('rolls back, rethrows the original error and keeps a healthy client', async () => {
    const { pool, client, release } = fakePool({ failRollback: false });
    await expect(new PostgresMealEntryDetachment(pool).detachEntry(PATIENT, 'not-a-uuid', null)).rejects.toThrow('Carb entry is not part of a meal');
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledWith(false);
  });

  it('rethrows the original error and destroys the client when the rollback itself fails', async () => {
    const { pool, release } = fakePool({ failRollback: true });
    await expect(new PostgresMealEntryDetachment(pool).detachEntry(PATIENT, 'not-a-uuid', null)).rejects.toThrow('Carb entry is not part of a meal');
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ message: 'connection terminated' }));
  });

  it('refuses non-uuid patient ids before opening a transaction', async () => {
    const { pool } = fakePool({ failRollback: false });
    await expect(new PostgresMealEntryDetachment(pool).detachEntry('patient-a', 'not-a-uuid', null)).rejects.toThrow('Invalid patient id');
    expect((pool.connect as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
