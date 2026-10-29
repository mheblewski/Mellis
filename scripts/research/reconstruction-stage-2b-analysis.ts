/**
 * Stage 2B: Reconstruction Analysis & Report
 *
 * Analysis of what can and cannot be reconstructed for one execution, from its ai_executions row. Every figure is
 * labelled stored, calculated or unavailable (see buildReconstructionAnalysis); nothing from earlier investigations
 * is presented as a measurement of the selected execution.
 *
 * Usage: tsx scripts/reconstruction-stage-2b-analysis.ts --execution-id <ai_executions.id> --output-dir <dir outside every Git working tree>
 */

import { Pool } from 'pg';
import { ReconstructionArgumentError, parseReconstructionArguments, writeReconstructionOutput } from './reconstruction/reconstruction-cli';
import { buildReconstructionAnalysis, describeErrorSafely, summarizeExecutionForStdout } from './reconstruction/reconstruction-report';

const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/gluco_mind';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Validated before any database access. The output is patient-derived, so it goes only to a guarded --output-dir.
  const { executionId: EXECUTION_ID, outputDir } = parseReconstructionArguments(argv);
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    console.log('\n=== STAGE 2B: RECONSTRUCTION ANALYSIS ===\n');

    // Get full execution data
    const execResult = await pool.query<any>(
      `SELECT * FROM ai_executions WHERE id = $1`,
      [EXECUTION_ID]
    );
    const exec = execResult.rows[0];
    // Stdout: allowlisted summary only. The figures and identifiers go to the guarded file.
    for (const line of summarizeExecutionForStdout(exec)) console.log(line);
    if (!exec) throw new ReconstructionArgumentError('Execution not found.');

    const analysisPath = writeReconstructionOutput(outputDir, 'reconstruction-analysis.txt', buildReconstructionAnalysis(EXECUTION_ID, exec));
    console.log(`\nAnalysis saved to: ${analysisPath}`);
    console.log('Next: run reconstruction-final-report with the same --execution-id and --output-dir.');
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
