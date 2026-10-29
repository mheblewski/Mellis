import { describe, expect, it, vi } from 'vitest';
import { PostgresGlucoMindRepository } from './postgres-glucomind.repository';

const ARGS = { providerSubject: 'subject-1', username: 'piotr', email: 'a@example.com', fullName: null };

function poolWith(knownRow: Record<string, unknown> | null) {
  const clientQuery = vi.fn(async (sql: string) => (sql.includes('SELECT user_id') ? { rows: [{ user_id: 'user-1' }] } : { rows: [] }));
  const client = { query: clientQuery, release: vi.fn() };
  const pool = {
    query: vi.fn(async () => ({ rows: knownRow ? [knownRow] : [] })),
    connect: vi.fn(async () => client),
  };
  return { pool, clientQuery };
}

describe('PostgresGlucoMindRepository.resolveOrCreateUserByCognitoSubject', () => {
  it('writes nothing for an identity seen within the touch interval with the same claims', async () => {
    const { pool } = poolWith({ user_id: 'user-1', fresh: true, provider_username: 'piotr', email: 'a@example.com', full_name: 'M' });
    const repository = new PostgresGlucoMindRepository(pool as any);

    await expect(repository.resolveOrCreateUserByCognitoSubject(ARGS)).resolves.toEqual({ userId: 'user-1', touched: false });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('updates last_seen_at once the identity was not seen for the interval', async () => {
    const { pool, clientQuery } = poolWith({ user_id: 'user-1', fresh: false, provider_username: 'piotr', email: 'a@example.com', full_name: null });
    const repository = new PostgresGlucoMindRepository(pool as any);

    await expect(repository.resolveOrCreateUserByCognitoSubject(ARGS)).resolves.toEqual({ userId: 'user-1', touched: true });
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE auth_identities'))).toBe(true);
  });

  it('updates a fresh identity whose claims changed (new e-mail)', async () => {
    const { pool, clientQuery } = poolWith({ user_id: 'user-1', fresh: true, provider_username: 'piotr', email: 'old@example.com', full_name: null });
    const repository = new PostgresGlucoMindRepository(pool as any);

    await expect(repository.resolveOrCreateUserByCognitoSubject(ARGS)).resolves.toEqual({ userId: 'user-1', touched: true });
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE auth_identities'))).toBe(true);
  });
});

describe('PostgresGlucoMindRepository audit retention and device sign-out', () => {
  it('deletes one bounded batch of audit events older than the cutoff', async () => {
    const query = vi.fn(async () => ({ rowCount: 12, rows: [] }));
    const repository = new PostgresGlucoMindRepository({ query } as any);

    await expect(repository.deleteAuditEventsOlderThan('2026-04-24T00:00:00.000Z', 5000)).resolves.toBe(12);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('DELETE FROM audit_events');
    expect(sql).toContain('LIMIT $2');
    expect(params).toEqual(['2026-04-24T00:00:00.000Z', 5000]);
  });

  it('deactivates the token only on patients the user cares for', async () => {
    const query = vi.fn(async () => ({ rowCount: 2, rows: [] }));
    const repository = new PostgresGlucoMindRepository({ query } as any);

    await expect(repository.deactivatePatientDevicesForUser('user-1', 'ios', 'token-a')).resolves.toBe(2);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('SET active = false');
    expect(sql).toContain('FROM caregiver_relationships r');
    expect(sql).toContain('r.user_id = $1');
    expect(params).toEqual(['user-1', 'ios', 'token-a']);
  });
});
