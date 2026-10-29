import 'dotenv/config';
import { readFileSync } from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { findChecksumMismatches, KNOWN_MIGRATION_CHECKSUMS, listMigrationFiles, resolveMigrationsDir } from './migration-files';

/**
 * Key of the transaction-level advisory lock held for a whole run: a second `migrate` started at the same time (two
 * containers, a deploy racing a manual run) waits for the first one to commit and then finds everything applied.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 7_314_022_610;

interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<{ rowCount?: number | null; rows: unknown[] }>;
}

/**
 * Applies every pending migration of the directory in one transaction, under the advisory lock. Before anything is
 * applied, every migration file is compared with its recorded checksum (migration-checksums.json): an edited applied
 * migration fails the run loudly instead of being skipped. Returns the versions applied by this run.
 */
export async function runMigrations(
  client: MigrationClient,
  migrationsDir: string,
  knownChecksums: Readonly<Record<string, string>> = KNOWN_MIGRATION_CHECKSUMS,
): Promise<string[]> {
  const migrationFiles = listMigrationFiles(migrationsDir);
  const applied: string[] = [];

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const mismatched = findChecksumMismatches(migrationsDir, migrationFiles, knownChecksums);
    if (mismatched.length > 0) {
      throw new Error(`MIGRATION_CHECKSUM_MISMATCH: these migration files differ from migration-checksums.json (never edit an applied migration; add a new one): ${mismatched.join(', ')}`);
    }

    for (const fileName of migrationFiles) {
      const version = fileName;
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (existing.rowCount && existing.rowCount > 0) {
        continue;
      }

      const sql = readFileSync(path.join(migrationsDir, fileName), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
      applied.push(version);
    }

    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function migrate(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const migrationsDir = resolveMigrationsDir();
  if (!migrationsDir) {
    throw new Error(`No migrations found next to ${__dirname} or in ${path.resolve(process.cwd(), 'infra/db/migrations')}`);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await runMigrations(client, migrationsDir);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  void migrate().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
