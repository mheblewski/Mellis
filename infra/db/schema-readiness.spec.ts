import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertRequiredSchemaMigration,
  DatabaseSchemaOutOfDateError,
  MINIMUM_SCHEMA_MIGRATION,
  REQUIRED_SCHEMA_MIGRATION,
  resolveRequiredSchemaMigration,
} from './schema-readiness';

const REQUIRED_PREFIX = REQUIRED_SCHEMA_MIGRATION.slice(0, 3);

describe('schema readiness', () => {
  it('succeeds when required migration is present', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { version: '001_init.sql' },
        { version: '011_memory_phase1.sql' },
        { version: REQUIRED_SCHEMA_MIGRATION },
      ],
    });

    await expect(assertRequiredSchemaMigration({ query } as any)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('fails deterministically when required migration is missing', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { version: '001_init.sql' },
        { version: '011_memory_phase1.sql' },
      ],
    });

    await expect(assertRequiredSchemaMigration({ query } as any)).rejects.toMatchObject({
      name: 'DatabaseSchemaOutOfDateError',
      code: 'DATABASE_SCHEMA_OUT_OF_DATE',
    });

    await expect(assertRequiredSchemaMigration({ query } as any)).rejects.toThrow(`required migration: ${REQUIRED_PREFIX}`);
    await expect(assertRequiredSchemaMigration({ query } as any)).rejects.toThrow('applied migration: 011');
    await expect(assertRequiredSchemaMigration({ query } as any)).rejects.not.toThrow('postgresql://');
  });

  it('fails when schema_migrations table is missing', async () => {
    const error = Object.assign(new Error('relation "schema_migrations" does not exist'), { code: '42P01' });
    const query = vi.fn().mockRejectedValue(error);

    await expect(assertRequiredSchemaMigration({ query } as any)).rejects.toBeInstanceOf(DatabaseSchemaOutOfDateError);
    await expect(assertRequiredSchemaMigration({ query } as any)).rejects.toThrow(`required migration: ${REQUIRED_PREFIX}`);
    await expect(assertRequiredSchemaMigration({ query } as any)).rejects.toThrow('applied migration: none');
  });

  it('requires the newest migration file shipped with the code, so it never lags behind', () => {
    const newest = readdirSync(resolve(__dirname, 'migrations')).filter((name) => name.endsWith('.sql')).sort().at(-1);
    expect(REQUIRED_SCHEMA_MIGRATION).toBe(newest);
    expect(REQUIRED_SCHEMA_MIGRATION > MINIMUM_SCHEMA_MIGRATION).toBe(true);
  });

  it('takes the newest file of a directory and falls back to the minimum without files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glucomind-migrations-'));
    writeFileSync(join(dir, '002_b.sql'), '');
    writeFileSync(join(dir, '010_c.sql'), '');
    writeFileSync(join(dir, '001_a.sql'), '');
    writeFileSync(join(dir, 'README.md'), '');
    expect(resolveRequiredSchemaMigration(dir)).toBe('010_c.sql');
    expect(resolveRequiredSchemaMigration(null)).toBe(MINIMUM_SCHEMA_MIGRATION);
  });

  it('refuses a database migrated up to an older version than the newest file', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ version: '001_init.sql' }, { version: '060_deferred_meal_bolus.sql' }] });
    await expect(assertRequiredSchemaMigration({ query } as any, '061_next.sql')).rejects.toThrow('required migration: 061');
  });
});
