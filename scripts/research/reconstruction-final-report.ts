#!/usr/bin/env node
/**
 * FINAL RECONSTRUCTION & ANALYSIS REPORT
 * Usage: tsx scripts/reconstruction-final-report.ts --execution-id <ai_executions.id> --output-dir <dir outside every Git working tree>
 * Run stages 2 and 2b with the same --output-dir first; this report refers to their files.
 * The report content comes from buildFinalReconstructionReport: figures are recomputed for the selected execution
 * and labelled stored, calculated or unavailable; observations from earlier investigations are labelled historical.
 */

import { Pool } from 'pg';
import { ReconstructionArgumentError, deriveTimeRangeExecutionIdentifiers, parseReconstructionArguments, writeReconstructionOutput } from './reconstruction/reconstruction-cli';
import { buildFinalReconstructionReport, computeExecutionFigures, describeErrorSafely, renderValue } from './reconstruction/reconstruction-report';

const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/gluco_mind';
const REPORT_FILE_NAME = 'FINAL_RECONSTRUCTION_REPORT.md';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Validated before any database access. The report is patient-derived, so it goes only to a guarded --output-dir.
  const { executionId: EXECUTION_ID, outputDir: OUTPUT_DIR } = parseReconstructionArguments(argv);
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Get all data
    const execResult = await pool.query<any>(`SELECT * FROM ai_executions WHERE id = $1`, [EXECUTION_ID]);
    const exec = execResult.rows[0];
    // Job, conversation, user message and analysis window of this execution, as stored by the worker.
    const identifiers = deriveTimeRangeExecutionIdentifiers(exec);

    const msgResult = await pool.query<any>(`SELECT * FROM messages WHERE id = $1`, [identifiers.messageId]);
    const message = msgResult.rows[0];
    if (!message) throw new ReconstructionArgumentError('User message of the execution not found.');

    const convResult = await pool.query<any>(`SELECT * FROM conversations WHERE id = $1`, [identifiers.conversationId]);
    const conversation = convResult.rows[0];

    const msgsResult = await pool.query<any>(
      `SELECT id, role, content, message_type, provenance_ref, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [identifiers.conversationId]
    );

    const jobResult = await pool.query<any>(
      `SELECT id, job_type, payload, created_at FROM jobs WHERE id::text = $1`,
      [identifiers.jobId]
    );
    const job = jobResult.rows[0];

    const report = buildFinalReconstructionReport({
      executionId: EXECUTION_ID,
      outputDir: OUTPUT_DIR,
      execution: exec,
      identifiers,
      message,
      conversation,
      conversationMessages: msgsResult.rows,
      job,
    });

    // Write report
    const REPORT_FILE = writeReconstructionOutput(OUTPUT_DIR, REPORT_FILE_NAME, report);

    // Stdout: figures only, no patient text or identifiers.
    const figures = computeExecutionFigures(exec);
    console.log('\n=== FINAL RECONSTRUCTION REPORT GENERATED ===\n');
    console.log(`Report saved to: ${REPORT_FILE}\n`);
    console.log('Key findings:');
    console.log(`  - Context package size: ${renderValue(figures.contextPackageBytes)}`);
    console.log(`  - Analytical evidence (not rebuilt): ${renderValue(figures.analyticalEvidence.bytes)}, share ${renderValue(figures.analyticalEvidence.share)}`);
    console.log(`  - Estimated cost: ${renderValue(figures.estimatedCost)}`);
    console.log('  - Fingerprint verification: not possible without the analytical evidence');
    console.log('  - Use the mock provider only; do not call the OpenAI API\n');
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
