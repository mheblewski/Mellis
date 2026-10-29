/**
 * Applies exactly one migration file, for controlled rollouts where `npm run migrate` would also apply other
 * pending files (for example 027 without 026). Dry-run by default: the migration runs inside a transaction that is
 * rolled back after its checks. Prints only database name, port and counts, never the connection string.
 *
 *   tsx scripts/apply-single-migration.ts <file.sql> --database <name> [--allow-pending <file.sql> ...] [--execute]
 *
 * Refuses when: the database name differs from --database, the file's sha256 differs from migration-checksums.json,
 * the version is already applied, or an earlier migration is unapplied and not listed in --allow-pending.
 * Lock waits inside the transaction are bounded by lock_timeout (MIGRATION_LOCK_TIMEOUT); on timeout everything rolls back.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = resolve(__dirname, '../infra/db/migrations');
const CHECKSUMS = resolve(__dirname, '../infra/db/migration-checksums.json');

/**
 * DDL that adds foreign keys locks the referenced tables (patients, users, events) against writes until COMMIT.
 * Waiting for a lock held by another session is bounded so the migration aborts and rolls back instead of queueing
 * writers indefinitely. No statement_timeout: the DDL itself runs on new, empty tables.
 */
export const MIGRATION_LOCK_TIMEOUT = '5s';

/** Read-only checks run after the migration SQL, before COMMIT or ROLLBACK. */
const POST_CHECKS: Record<string, Array<{ name: string; sql: string; expect: (row: Record<string, unknown>) => boolean }>> = {
  '075_drop_after_the_fact_meal_logging.sql': [
    {
      name: 'the retired tables are gone',
      sql: `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'
            AND table_name IN ('meal_candidates','meal_cases','patterns','memories','meal_description_prompts')`,
      expect: (row) => row.n === 0,
    },
    {
      name: 'loop actions and meal records are kept',
      sql: `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'
            AND table_name IN ('loop_actions','loop_action_events','meal_records','meal_record_entry_detachments')`,
      expect: (row) => row.n === 4,
    },
  ],
};

export interface ApplySingleMigrationOptions {
  file: string;
  database: string;
  allowPending: string[];
  execute: boolean;
}

export function parseArgs(argv: string[]): ApplySingleMigrationOptions {
  const [file, ...rest] = argv;
  const options: ApplySingleMigrationOptions = { file: file ?? '', database: '', allowPending: [], execute: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--execute') options.execute = true;
    else if (flag === '--database') options.database = rest[++index] ?? '';
    else if (flag === '--allow-pending') options.allowPending.push(rest[++index] ?? '');
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(options.file) || !options.database) {
    throw new Error('Usage: apply-single-migration.ts <NNN_name.sql> --database <name> [--allow-pending <file.sql>] [--execute]');
  }
  return options;
}

export async function applySingleMigration(client: Client, options: ApplySingleMigrationOptions, log: (line: string) => void): Promise<'DRY_RUN_OK' | 'APPLIED'> {
  const identity = (await client.query(`SELECT current_database() AS database, inet_server_port() AS port`)).rows[0];
  log(`database=${identity.database} port=${identity.port ?? 'local'} mode=${options.execute ? 'EXECUTE' : 'DRY_RUN'}`);
  if (identity.database !== options.database) {
    throw new Error(`REFUSED: connected to ${identity.database}, expected ${options.database}`);
  }

  const sql = readFileSync(resolve(MIGRATIONS_DIR, options.file));
  const expected = (JSON.parse(readFileSync(CHECKSUMS, 'utf8')) as { checksums: Record<string, string> }).checksums[options.file];
  const actual = createHash('sha256').update(sql).digest('hex');
  if (!expected || expected !== actual) {
    throw new Error(`REFUSED: checksum of ${options.file} does not match migration-checksums.json`);
  }

  const applied = new Set((await client.query(`SELECT version FROM schema_migrations`)).rows.map((row) => String(row.version)));
  if (applied.has(options.file)) {
    throw new Error(`REFUSED: ${options.file} is already applied`);
  }
  const missing = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && name < options.file && !applied.has(name) && !options.allowPending.includes(name))
    .sort();
  if (missing.length > 0) {
    throw new Error(`REFUSED: earlier migrations are not applied: ${missing.join(', ')}`);
  }

  await client.query('BEGIN');
  try {
    // SET LOCAL ends with the transaction (COMMIT or ROLLBACK); the session setting is never changed.
    await client.query(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
    await client.query(sql.toString('utf8'));
    await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [options.file]);
    for (const check of POST_CHECKS[options.file] ?? []) {
      const row = (await client.query(check.sql)).rows[0] ?? {};
      if (!check.expect(row)) {
        throw new Error(`REFUSED: post-check failed: ${check.name} (${JSON.stringify(row)})`);
      }
      log(`check ok: ${check.name}`);
    }
    if (!options.execute) {
      await client.query('ROLLBACK');
      log('dry run: rolled back, nothing changed');
      return 'DRY_RUN_OK';
    }
    await client.query('COMMIT');
    log(`applied: ${options.file}`);
    return 'APPLIED';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('Missing required environment variable: DATABASE_URL');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applySingleMigration(client, options, (line) => console.log(line));
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
