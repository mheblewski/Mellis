/**
 * Stage 1: Recover execution metadata and assess what data is available
 * Usage: tsx scripts/reconstruction-stage-1-recover.ts --execution-id <ai_executions.id>
 * Writes no files. Stdout carries only an allowlisted summary: no row dumps, identifiers, hashes, message or
 * package content (see summarizeExecutionForStdout).
 */

import { Pool } from 'pg';
import { parseExecutionIdArgument } from './reconstruction/reconstruction-cli';
import { describeErrorSafely, summarizeExecutionForStdout } from './reconstruction/reconstruction-report';

const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/gluco_mind';
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Validated before any database access; the execution is never embedded in the script.
  const EXECUTION_ID = parseExecutionIdArgument(argv);
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    console.log('\n=== STAGE 1: RECOVERY OF EXECUTION METADATA ===\n');

    // 1. Get AI_EXECUTION record
    console.log('1. Querying ai_executions...\n');
    const execResult = await pool.query<any>(
      `SELECT * FROM ai_executions WHERE id = $1`,
      [EXECUTION_ID]
    );

    const exec = execResult.rows[0];
    for (const line of summarizeExecutionForStdout(exec)) console.log(line);
    if (!exec) {
      process.exitCode = 1;
      return;
    }

    // 2. Context package row. ai_executions.context_package_id is normally a composite string while context_packages
    // is keyed by UUID; the lookup is only attempted for a UUID-shaped value (a mismatched value would make the
    // database echo it back in an error).
    console.log('\n2. Checking context_packages...\n');
    const pkgCheckResult = await pool.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'context_packages'
      )`
    );
    if (!pkgCheckResult.rows[0]?.exists) {
      console.log('  context_packages table: absent');
    } else if (!UUID_SHAPE.test(String(exec.context_package_id ?? ''))) {
      console.log('  context_packages table: present; lookup skipped (context_package_id is not a context_packages UUID)');
    } else {
      const pkgResult = await pool.query<any>(`SELECT id FROM context_packages WHERE id = $1`, [exec.context_package_id]);
      console.log(`  context_packages row: ${pkgResult.rows.length > 0 ? 'found' : 'not found'}`);
    }

    // 3. Related job(s), by correlation id
    console.log('\n3. Finding related job...\n');
    const jobResult = await pool.query<any>(
      `SELECT job_type
       FROM jobs
       WHERE correlation_id::text LIKE $1
       LIMIT 5`,
      [`%${exec.correlation_id}`]
    );
    console.log(`  related jobs: ${jobResult.rows.length}`);
    for (const job of jobResult.rows) console.log(`  job_type: ${/^[A-Za-z0-9._:-]{1,60}$/.test(String(job.job_type)) ? job.job_type : 'withheld'}`);

    // 4. Related conversation (correlation_id of a time-range execution is the conversation id)
    console.log('\n4. Finding related conversation...\n');
    const convResult = await pool.query<any>(
      `SELECT conversation_type
       FROM conversations
       WHERE id::text = $1`,
      [exec.correlation_id]
    );
    const conversationType = convResult.rows[0]?.conversation_type;
    console.log(`  conversation: ${convResult.rows.length > 0 ? `found (type ${/^[A-Z0-9_]{1,60}$/.test(String(conversationType)) ? conversationType : 'withheld'})` : 'not found'}`);

    // 5. Summary of what's available
    console.log('\n\n=== STAGE 1 SUMMARY: WHAT IS AVAILABLE FOR RECONSTRUCTION ===\n');
    const availability = {
      'Context package ID': exec.context_package_id ? 'YES' : 'NO',
      'Prompt version': exec.prompt_version ? 'YES' : 'NO',
      'Output schema version': exec.output_schema_version ? 'YES' : 'NO',
      'Model policy version': exec.model_policy_version ? 'YES' : 'NO',
      'Input fingerprint': exec.input_fingerprint ? 'YES' : 'NO',
      'Serialized input bytes': exec.serialized_input_bytes ? 'YES' : 'NO',
      'Context package usage': exec.context_package_usage ? 'YES' : 'NO',
      'Full context size in delivery telemetry': exec.context_package_usage?.delivery?.full_serialized_input_bytes ? 'YES (metadata only)' : 'NO',
      'Normalized result': exec.normalized_result ? 'YES' : 'NO',
    };
    for (const [key, value] of Object.entries(availability)) {
      console.log(`  ${key}: ${value}`);
    }

    console.log('\nNext: run reconstruction-stage-2-build with the same --execution-id and an --output-dir outside every Git working tree.');
  } catch (err) {
    console.error(`Fatal error: ${describeErrorSafely(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(describeErrorSafely(error));
    process.exitCode = 1;
  });
}
