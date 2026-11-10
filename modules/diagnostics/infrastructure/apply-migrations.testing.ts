import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = resolve(__dirname, '../../../infra/db/migrations');
const SKIPPED_MIGRATIONS = new Set(['026_meal_supersession.sql']);

/** The real schema for the Postgres specs of diagnostics. Local Homebrew Postgres has no pgvector, so 036 is left out there. */
export async function applyMigrationsForDiagnosticsTests(pool: Pool): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const hasVector = ((await pool.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")).rowCount ?? 0) > 0;
  for (const fileName of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    if (SKIPPED_MIGRATIONS.has(fileName) || (!hasVector && fileName.startsWith('036_'))) continue;
    if (((await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [fileName])).rowCount ?? 0) > 0) continue;
    await pool.query(readFileSync(resolve(MIGRATIONS_DIR, fileName), 'utf8'));
    await pool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [fileName]);
  }
}
