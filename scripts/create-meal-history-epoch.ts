/**
 * Records the first meal history epoch for one patient. Dry-run by default: everything runs inside a
 * transaction that is rolled back after its checks; --execute commits. Never changes the schema, never starts a
 * worker, a sync, an AI call or a push. Prints database name, host and port, never the connection string.
 *
 *   tsx scripts/create-meal-history-epoch.ts --database <name> --patient <uuid> --starts-at <ISO with zone>
 *     --policy new-meal-assignment.v1 --decided-by <who> --note <why> [--execute]
 *
 * Enforced: starts_at has an explicit zone and lies in the future (local and database clock), the policy is exactly
 * the code's NEW_MEAL_ASSIGNMENT_POLICY, migration 027 is applied, the patient exists and has no active epoch. One
 * transaction, serialised per patient with the per-patient meal lock (loop actions and meal entry detachment).
 * deploy/sql/bootstrap-patient.sql starts a patient's loop actions too; this script records the epoch only.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { NEW_MEAL_ASSIGNMENT_POLICY } from '@modules/meal-candidates/application/meal-history-boundary';

/** Bounds waits for the advisory lock or row locks held by an in-flight loop action assignment. */
export const EPOCH_LOCK_TIMEOUT = '5s';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const MIN_NOTE_LENGTH = 10;

export interface CreateEpochOptions {
  database: string;
  patientId: string;
  startsAt: string;
  policy: string;
  decidedBy: string;
  note: string;
  execute: boolean;
}

export function parseArgs(argv: string[]): CreateEpochOptions {
  const options: CreateEpochOptions = { database: '', patientId: '', startsAt: '', policy: '', decidedBy: '', note: '', execute: false };
  const valued: Record<string, keyof Omit<CreateEpochOptions, 'execute'>> = {
    '--database': 'database',
    '--patient': 'patientId',
    '--starts-at': 'startsAt',
    '--policy': 'policy',
    '--decided-by': 'decidedBy',
    '--note': 'note',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--execute') {
      options.execute = true;
    } else if (flag in valued) {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      options[valued[flag]] = value;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return options;
}

/** Pure validation; returns starts_at normalised to UTC ISO. */
export function validateEpochRequest(options: CreateEpochOptions, now: Date): { startsAtIso: string } {
  if (!options.database) throw new Error('REFUSED: --database is required');
  if (!UUID_PATTERN.test(options.patientId)) throw new Error('REFUSED: --patient must be a UUID');
  if (!ZONED_TIMESTAMP.test(options.startsAt)) {
    throw new Error('REFUSED: --starts-at must be an ISO timestamp with an explicit zone (Z or ±HH:MM)');
  }
  const startsAtMs = Date.parse(options.startsAt);
  // Date.parse rolls impossible days over (2026-02-30 becomes 2026-03-02); refuse them instead.
  const [year, month, day] = options.startsAt.slice(0, 10).split('-').map(Number);
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(startsAtMs) || calendarDay.getUTCMonth() !== month - 1 || calendarDay.getUTCDate() !== day) {
    throw new Error('REFUSED: --starts-at is not a valid timestamp');
  }
  if (startsAtMs <= now.getTime()) throw new Error('REFUSED: --starts-at must be in the future');
  if (options.policy !== NEW_MEAL_ASSIGNMENT_POLICY.version) {
    throw new Error(`REFUSED: --policy must be exactly ${NEW_MEAL_ASSIGNMENT_POLICY.version}`);
  }
  if (!options.decidedBy.trim()) throw new Error('REFUSED: --decided-by is required');
  if (options.note.trim().length < MIN_NOTE_LENGTH) throw new Error(`REFUSED: --note must explain the decision (at least ${MIN_NOTE_LENGTH} characters)`);
  return { startsAtIso: new Date(startsAtMs).toISOString() };
}

type Count = { n: number };

export async function createMealHistoryEpoch(
  client: Pick<Client, 'query'>,
  options: CreateEpochOptions,
  log: (line: string) => void,
  now: Date = new Date(),
): Promise<{ status: 'DRY_RUN_OK' | 'CREATED'; epochId: string }> {
  const { startsAtIso } = validateEpochRequest(options, now);

  const identity = (await client.query(`SELECT current_database() AS database, inet_server_addr()::text AS host, inet_server_port() AS port`)).rows[0];
  log(`database=${identity.database} host=${identity.host ?? 'local'} port=${identity.port ?? 'local'} mode=${options.execute ? 'EXECUTE' : 'DRY_RUN'}`);
  if (identity.database !== options.database) {
    throw new Error(`REFUSED: connected to ${identity.database}, expected ${options.database}`);
  }

  const count = async (sql: string, params: unknown[] = []) => Number(((await client.query(sql, params)).rows[0] as Count).n);

  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '${EPOCH_LOCK_TIMEOUT}'`);

    const schema = (await client.query(
      `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '027_meal_history.sql') AS migrated,
              to_regclass('public.meal_history_epochs') IS NOT NULL
                AND to_regclass('public.meal_records') IS NOT NULL
                AND to_regclass('public.meal_record_entries') IS NOT NULL AS tables`,
    )).rows[0];
    if (!schema?.migrated || !schema?.tables) {
      throw new Error('REFUSED: migration 027_meal_history.sql is not applied');
    }

    // Same key as loop actions and meal entry detachment: concurrent epoch creations for one patient and an in-flight
    // meal write are serialised. The partial unique index stays the durable backstop.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`meal-history:${options.patientId}`]);

    if ((await count(`SELECT count(*)::int AS n FROM patients WHERE id = $1::uuid`, [options.patientId])) !== 1) {
      throw new Error('REFUSED: patient does not exist');
    }
    if ((await count(`SELECT count(*)::int AS n FROM meal_history_epochs WHERE patient_id = $1::uuid AND retired_at IS NULL`, [options.patientId])) > 0) {
      throw new Error('REFUSED: patient already has an active meal history epoch');
    }
    const future = (await client.query(`SELECT $1::timestamptz > now() AS future`, [startsAtIso])).rows[0];
    if (!future?.future) {
      throw new Error('REFUSED: --starts-at is not in the future according to the database clock');
    }

    const before = {
      epochs: await count(`SELECT count(*)::int AS n FROM meal_history_epochs WHERE patient_id = $1::uuid`, [options.patientId]),
      jobs: await count(`SELECT count(*)::int AS n FROM jobs`),
      pushes: await count(`SELECT count(*)::int AS n FROM push_notifications`),
    };

    const inserted = (await client.query(
      `INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by, note)
       VALUES ($1::uuid, $2::timestamptz, $3, $4, $5)
       RETURNING id::text, starts_at, assignment_policy_version`,
      [options.patientId, startsAtIso, NEW_MEAL_ASSIGNMENT_POLICY.version, options.decidedBy.trim(), options.note.trim()],
    )).rows[0];

    const checks: Array<[string, boolean]> = [
      ['exactly one active epoch for the patient', (await count(`SELECT count(*)::int AS n FROM meal_history_epochs WHERE patient_id = $1::uuid AND retired_at IS NULL`, [options.patientId])) === 1],
      ['exactly one epoch created', (await count(`SELECT count(*)::int AS n FROM meal_history_epochs WHERE patient_id = $1::uuid`, [options.patientId])) === before.epochs + 1],
      ['epoch starts at starts_at with the code\'s policy', new Date(inserted.starts_at).toISOString() === startsAtIso
        && inserted.assignment_policy_version === NEW_MEAL_ASSIGNMENT_POLICY.version],
      ['no meal record for the patient', (await count(`SELECT count(*)::int AS n FROM meal_records WHERE patient_id = $1::uuid`, [options.patientId])) === 0],
      ['no meal entry for the patient', (await count(`SELECT count(*)::int AS n FROM meal_record_entries WHERE patient_id = $1::uuid`, [options.patientId])) === 0],
      ['no job created', (await count(`SELECT count(*)::int AS n FROM jobs`)) === before.jobs],
      ['no push notification created', (await count(`SELECT count(*)::int AS n FROM push_notifications`)) === before.pushes],
    ];
    for (const [name, ok] of checks) {
      if (!ok) throw new Error(`REFUSED: post-check failed: ${name}`);
      log(`check ok: ${name}`);
    }

    if (!options.execute) {
      await client.query('ROLLBACK');
      log(`dry run: rolled back, nothing changed (would create an epoch starting ${startsAtIso})`);
      return { status: 'DRY_RUN_OK', epochId: inserted.id };
    }
    await client.query('COMMIT');
    log(`created: epoch ${inserted.id}, starts_at=${startsAtIso}`);
    return { status: 'CREATED', epochId: inserted.id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  validateEpochRequest(options, new Date());
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('Missing required environment variable: DATABASE_URL');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await createMealHistoryEpoch(client, options, (line) => console.log(line));
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
