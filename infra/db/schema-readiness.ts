import { Pool } from 'pg';
import { newestMigrationFile, resolveMigrationsDir } from './migration-files';

/** Used only when no migration files can be found next to the code or under the working directory. */
export const MINIMUM_SCHEMA_MIGRATION = '016_auth_identity_boundary_v1.sql';

/**
 * The schema the code needs: the newest migration file shipped with it, so the requirement never lags behind a new
 * migration (it once stayed at 016 while the code used 060). Falls back to MINIMUM_SCHEMA_MIGRATION without files.
 */
export function resolveRequiredSchemaMigration(migrationsDir: string | null = resolveMigrationsDir()): string {
  return (migrationsDir ? newestMigrationFile(migrationsDir) : null) ?? MINIMUM_SCHEMA_MIGRATION;
}

export const REQUIRED_SCHEMA_MIGRATION = resolveRequiredSchemaMigration();

function migrationPrefix(version: string | null): string {
  if (!version) {
    return 'none';
  }

  const match = /^(\d{3})/.exec(version);
  return match ? match[1] : version;
}

export class DatabaseSchemaOutOfDateError extends Error {
  readonly code = 'DATABASE_SCHEMA_OUT_OF_DATE' as const;

  constructor(args: { requiredMigration: string; appliedMigration: string }) {
    const required = migrationPrefix(args.requiredMigration);
    super([
      'DATABASE_SCHEMA_OUT_OF_DATE',
      `required migration: ${required}`,
      `applied migration: ${args.appliedMigration}`,
    ].join('\n'));
    this.name = 'DatabaseSchemaOutOfDateError';
  }
}

export async function assertRequiredSchemaMigration(pool: Pick<Pool, 'query'>, requiredMigration: string = REQUIRED_SCHEMA_MIGRATION): Promise<void> {
  const requiredPrefix = migrationPrefix(requiredMigration);

  let result: { rows: Array<{ version: string }> };
  try {
    result = await pool.query<{ version: string }>(`SELECT version FROM schema_migrations ORDER BY version ASC`);
  } catch (error) {
    const databaseError = error as { code?: string };
    if (databaseError.code === '42P01') {
      throw new DatabaseSchemaOutOfDateError({
        requiredMigration,
        appliedMigration: 'none',
      });
    }

    throw error;
  }

  const versions = result.rows.map((row) => String(row.version));
  const applied = versions.at(-1) ?? null;
  const requiredPresent = versions.includes(requiredMigration);

  if (!requiredPresent) {
    throw new DatabaseSchemaOutOfDateError({
      requiredMigration,
      appliedMigration: migrationPrefix(applied),
    });
  }

  if (migrationPrefix(applied) < requiredPrefix) {
    throw new DatabaseSchemaOutOfDateError({
      requiredMigration,
      appliedMigration: migrationPrefix(applied),
    });
  }
}
