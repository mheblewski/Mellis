import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MIGRATION_ADVISORY_LOCK_KEY, runMigrations } from './migrate';
import { listMigrationFiles, resolveMigrationsDir } from './migration-files';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'glucomind-migrate-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

function fakeClient(appliedVersions: string[]) {
  const queries: string[] = [];
  return {
    queries,
    async query(sql: string, params?: unknown[]) {
      queries.push(params ? `${sql.trim()} ${JSON.stringify(params)}` : sql.trim());
      if (sql.startsWith('SELECT 1 FROM schema_migrations')) {
        return { rowCount: appliedVersions.includes(String(params?.[0])) ? 1 : 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

describe('runMigrations', () => {
  it('takes the advisory lock first and applies only pending migrations in order', async () => {
    const dir = migrationsDir({ '001_a.sql': 'SELECT a;', '002_b.sql': 'SELECT b;', '003_c.sql': 'SELECT c;' });
    const client = fakeClient(['001_a.sql']);

    const applied = await runMigrations(client, dir, { '001_a.sql': sha('SELECT a;'), '002_b.sql': sha('SELECT b;') });

    expect(applied).toEqual(['002_b.sql', '003_c.sql']);
    expect(client.queries[0]).toBe('BEGIN');
    expect(client.queries[1]).toBe(`SELECT pg_advisory_xact_lock($1) [${MIGRATION_ADVISORY_LOCK_KEY}]`);
    expect(client.queries).not.toContain('SELECT a;');
    expect(client.queries.indexOf('SELECT b;')).toBeLessThan(client.queries.indexOf('SELECT c;'));
    expect(client.queries.at(-1)).toBe('COMMIT');
  });

  it('fails loudly and applies nothing when an applied migration was edited', async () => {
    const dir = migrationsDir({ '001_a.sql': 'SELECT a; -- edited', '002_b.sql': 'SELECT b;' });
    const client = fakeClient(['001_a.sql']);

    await expect(runMigrations(client, dir, { '001_a.sql': sha('SELECT a;') })).rejects.toThrow('MIGRATION_CHECKSUM_MISMATCH: these migration files differ from migration-checksums.json (never edit an applied migration; add a new one): 001_a.sql');
    expect(client.queries).not.toContain('SELECT b;');
    expect(client.queries.at(-1)).toBe('ROLLBACK');
  });

  it('accepts the repository migrations against the recorded checksums', async () => {
    const dir = resolveMigrationsDir();
    expect(dir).not.toBeNull();
    const client = fakeClient([]);
    await expect(runMigrations(client, dir as string)).resolves.toEqual(listMigrationFiles(dir as string));
  });
});

describe('resolveMigrationsDir', () => {
  it('takes the first candidate with migration files, then null', () => {
    const empty = mkdtempSync(join(tmpdir(), 'glucomind-empty-'));
    const full = migrationsDir({ '001_a.sql': '' });
    expect(resolveMigrationsDir([join(empty, 'missing'), empty, full])).toBe(full);
    expect(resolveMigrationsDir([empty])).toBeNull();
  });
});
