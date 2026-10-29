import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import { applySingleMigration, MIGRATION_LOCK_TIMEOUT, parseArgs } from './apply-single-migration';

describe('apply-single-migration arguments', () => {
  it('defaults to a dry run and requires the expected database name', () => {
    expect(parseArgs(['027_meal_history.sql', '--database', 'gluco_mind', '--allow-pending', '026_meal_supersession.sql'])).toEqual({
      file: '027_meal_history.sql',
      database: 'gluco_mind',
      allowPending: ['026_meal_supersession.sql'],
      execute: false,
    });
    expect(parseArgs(['027_meal_history.sql', '--database', 'gluco_mind', '--execute']).execute).toBe(true);
  });

  it('refuses missing database names, unknown flags and non-migration paths', () => {
    expect(() => parseArgs(['027_meal_history.sql'])).toThrow('Usage');
    expect(() => parseArgs(['../027_meal_history.sql', '--database', 'x'])).toThrow('Usage');
    expect(() => parseArgs(['027_meal_history.sql', '--database', 'x', '--force'])).toThrow('Unknown argument');
  });
});

// Fake client only: records statements, no database.
function fakeClient(options: { failOnMigrationSql?: Error } = {}) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.startsWith('SELECT current_database()')) return { rows: [{ database: 'target_db', port: 5432 }] };
    if (sql === 'SELECT version FROM schema_migrations') {
      return { rows: Array.from({ length: 25 }, (_, index) => ({ version: `${String(index + 1).padStart(3, '0')}` })) };
    }
    if (sql.includes('CREATE TABLE IF NOT EXISTS meal_history_epochs') && options.failOnMigrationSql) throw options.failOnMigrationSql;
    if (sql.startsWith('SELECT count(*)::int AS n FROM information_schema.tables')) return { rows: [{ n: 4 }] };
    if (sql.startsWith('SELECT count(*)::int AS n FROM')) return { rows: [{ n: 0 }] };
    return { rows: [] };
  });
  return { client: { query } as unknown as Client, statements };
}

describe('apply-single-migration transaction', () => {
  // The fake schema_migrations lists bare numbers, so every real earlier file counts as pending and is allowed.
  const pending = readdirSync(resolve(__dirname, '../infra/db/migrations')).filter((name) => name.endsWith('.sql') && name < '027_meal_history.sql');
  const allow = { file: '027_meal_history.sql', database: 'target_db', allowPending: pending, execute: false };

  it('bounds lock waits with SET LOCAL lock_timeout before any migration DDL', async () => {
    const { client, statements } = fakeClient();
    await expect(applySingleMigration(client, allow, () => undefined)).resolves.toBe('DRY_RUN_OK');

    const begin = statements.indexOf('BEGIN');
    expect(MIGRATION_LOCK_TIMEOUT).toBe('5s');
    expect(statements[begin + 1]).toBe(`SET LOCAL lock_timeout = '5s'`);
    expect(statements[begin + 2]).toContain('CREATE TABLE IF NOT EXISTS meal_history_epochs');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(statements.some((sql) => /statement_timeout/.test(sql))).toBe(false);
  });

  it('rolls back and rethrows when the migration hits the lock timeout, never committing', async () => {
    const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const { client, statements } = fakeClient({ failOnMigrationSql: lockTimeout });
    await expect(applySingleMigration(client, { ...allow, execute: true }, () => undefined)).rejects.toThrow('lock timeout');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(statements.some((sql) => sql.startsWith('INSERT INTO schema_migrations'))).toBe(false);
  });
});
