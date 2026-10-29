import { describe, expect, it } from 'vitest';
import { createDatabasePool } from './database.module';

describe('createDatabasePool', () => {
  it('survives an idle client error (a Postgres restart) instead of crashing the process', async () => {
    const pool = createDatabasePool('postgresql://offline-test-invalid@127.0.0.1:1/none');
    expect(pool.listenerCount('error')).toBe(1);
    expect(() => pool.emit('error', Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }), {} as never)).not.toThrow();
    await pool.end();
  });
});
