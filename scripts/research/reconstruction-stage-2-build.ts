/**
 * Stage 2: Reconstruct the TimeRangeAnalysisContextRecord and full prompt
 * This traces through the worker service to understand what was built
 *
 * Usage: tsx scripts/reconstruction-stage-2-build.ts --execution-id <ai_executions.id> --output-dir <dir outside every Git working tree>
 */

import { Pool } from 'pg';
import { createHash } from 'crypto';
import { deriveTimeRangeExecutionIdentifiers, parseReconstructionArguments, writeReconstructionOutput } from './reconstruction/reconstruction-cli';
import { describeErrorSafely, glucoseSummary } from './reconstruction/reconstruction-report';

const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/gluco_mind';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Validated before any database access. The output is patient-derived, so it goes only to a guarded --output-dir.
  const { executionId: EXECUTION_ID, outputDir } = parseReconstructionArguments(argv);
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    console.log('\n=== STAGE 2: RECONSTRUCT REQUEST ===\n');

    // 1. Get the execution with all metadata
    const execResult = await pool.query<any>(
      `SELECT * FROM ai_executions WHERE id = $1`,
      [EXECUTION_ID]
    );
    const exec = execResult.rows[0];
    // Conversation, user message, patient and analysis window of this execution, as stored by the worker.
    const {
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      patientId: PATIENT_ID,
      rangeType: RANGE_TYPE,
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
    } = deriveTimeRangeExecutionIdentifiers(exec);

    // 2. Get the message
    console.log('1. Retrieving user message...');
    const msgResult = await pool.query<any>(
      `SELECT id, conversation_id, patient_id, role, content, question_id, metadata, created_at, provenance_ref 
       FROM messages 
       WHERE id = $1`,
      [MESSAGE_ID]
    );

    if (msgResult.rows.length === 0) {
      console.log('[ERROR] Message not found');
      process.exitCode = 1;
      return;
    }

    const message = msgResult.rows[0];
    console.log('[OK] Message found:');
    // The message text is patient-authored: only its length goes to stdout (the text itself is in the guarded file).
    console.log(`  Content length: ${String(message.content ?? '').length} characters`);
    console.log(`  Created: ${message.created_at}`);

    // 3. Get the conversation
    console.log('\n2. Retrieving conversation...');
    const convResult = await pool.query<any>(
      `SELECT id, patient_id, episode_id, analysis_id, recommendation_id, conversation_type, 
              thread_state_version, awaiting_user_answer, created_at 
       FROM conversations 
       WHERE id = $1`,
      [CONVERSATION_ID]
    );

    const conversation = convResult.rows[0];
    console.log('[OK] Conversation found:');
    console.log(`  Type: ${conversation.conversation_type}`);
    console.log(`  Thread state: ${conversation.thread_state_version}`);

    // 4. Get conversation messages (last 12 for context)
    console.log('\n3. Retrieving conversation message history...');
    const msgsResult = await pool.query<any>(
      `SELECT id, role, content, message_type, provenance_ref, created_at 
       FROM messages 
       WHERE conversation_id = $1 
       ORDER BY created_at ASC`,
      [CONVERSATION_ID]
    );

    console.log(`[OK] Found ${msgsResult.rows.length} message(s) in conversation`);
    const recentMessages = msgsResult.rows.slice(-12);

    // 5. Get current state
    console.log('\n4. Retrieving current state snapshot...');
    const stateResult = await pool.query<any>(
      `SELECT id, patient_id, state_version, as_of, snapshot, created_at 
       FROM current_states 
       WHERE patient_id = $1 AND state_version = 'current-state.v1'
       ORDER BY as_of DESC LIMIT 1`,
      [PATIENT_ID]
    );

    let currentState = null;
    if (stateResult.rows.length > 0) {
      currentState = stateResult.rows[0];
      console.log('[OK] Current state found:');
      console.log(`  As of: ${currentState.as_of}`);
      console.log(`  Snapshot keys: ${Object.keys(currentState.snapshot || {}).join(', ')}`);
    } else {
      console.log('[WARNING] No current state found');
    }

    // 6. Get glucose events in the time range
    console.log('\n5. Querying glucose events for the analysis window...');
    const glucoseResult = await pool.query<any>(
      `SELECT e.id, e.type, e.occurred_at, e.payload, e.source_record_id, sr.canonical_hash
       FROM events e
       JOIN source_records sr ON e.source_record_id = sr.id
       WHERE e.patient_id = $1 AND e.type = 'GLUCOSE_READING' 
         AND e.occurred_at BETWEEN $2 AND $3
       ORDER BY e.occurred_at ASC`,
      [PATIENT_ID, RANGE_START, RANGE_END]
    );

    console.log(`[OK] Found ${glucoseResult.rows.length} glucose reading(s)`);

    // 7. Get insulin events
    console.log('\n6. Querying insulin treatment events...');
    const insulinResult = await pool.query<any>(
      `SELECT e.id, e.type, e.occurred_at, e.payload, e.source_record_id
       FROM events e
       WHERE e.patient_id = $1 AND e.type IN ('INSULIN_BOLUS', 'BASAL_RATE_CHANGE', 'TEMP_BASAL_RATE', 'TEMP_BASAL')
         AND e.occurred_at BETWEEN $2 AND $3
       ORDER BY e.occurred_at ASC`,
      [PATIENT_ID, RANGE_START, RANGE_END]
    );

    console.log(`[OK] Found ${insulinResult.rows.length} insulin treatment event(s)`);

    // 8. Get meal events
    console.log('\n7. Querying meal/carb events...');
    const mealResult = await pool.query<any>(
      `SELECT e.id, e.type, e.occurred_at, e.payload, e.source_record_id
       FROM events e
       WHERE e.patient_id = $1 AND e.type IN ('MEAL', 'FOOD_ENTRY')
         AND e.occurred_at BETWEEN $2 AND $3
       ORDER BY e.occurred_at ASC`,
      [PATIENT_ID, RANGE_START, RANGE_END]
    );

    console.log(`[OK] Found ${mealResult.rows.length} meal event(s)`);

    // 9. Get hypo episodes
    console.log('\n8. Querying hypo episodes...');
    const hypoResult = await pool.query<any>(
      `SELECT id, trigger_id, start_event_id, started_at, ended_at, severity, state, rule_version
       FROM hypo_episodes
       WHERE patient_id = $1 AND (
         started_at BETWEEN $2 AND $3 OR 
         (started_at < $2 AND (ended_at IS NULL OR ended_at > $2))
       )
       ORDER BY started_at ASC`,
      [PATIENT_ID, RANGE_START, RANGE_END]
    );

    console.log(`[OK] Found ${hypoResult.rows.length} hypo episode(s)`);

    // 10. Now build the reconstructed request object
    console.log('\n9. Building reconstructed TimeRangeAnalysisContextRecord...\n');

    const reconstructedContext = {
      context_package_id: exec.context_package_id,
      context_package_version: exec.context_package_version,
      content_hash: exec.context_package_hash,
      created_at: new Date().toISOString(),
      patient_ref: { patient_id: PATIENT_ID },
      analysis_request_input: {
        user_message_id: MESSAGE_ID,
        user_message_text: message.content,
        range_type: RANGE_TYPE,
        // Not stored on ai_executions (see reconstruction_notes); never assumed.
        timezone: null,
        range_start: RANGE_START,
        range_end: RANGE_END,
        requested_at: message.created_at,
        normalization_policy_version: null,
      },
      conversation_context: {
        thread_id: CONVERSATION_ID,
        thread_state_version: conversation.thread_state_version,
        awaiting_user_answer: conversation.awaiting_user_answer,
        messages: recentMessages.map(msg => ({
          message_id: msg.id,
          role: msg.role,
          created_at: msg.created_at,
          content: msg.content,
          provenance_ref: msg.provenance_ref,
          message_type: msg.message_type,
        })),
      },
      current_state_snapshot: currentState ? {
        as_of: currentState.as_of,
        current_glucose: currentState.snapshot?.current_glucose || 'UNKNOWN',
        trend: currentState.snapshot?.trend || 'UNKNOWN',
        iob: currentState.snapshot?.iob || 'UNKNOWN',
      } : null,
      analytical_evidence: {
        glucose_events: glucoseResult.rows.map(r => ({
          event_id: r.id,
          occurred_at: r.occurred_at,
          glucose_value: r.payload?.glucose_value,
          glucose_unit: r.payload?.glucose_unit || 'mg/dL',
          source_record_id: r.source_record_id,
          payload: r.payload,
          canonical_hash: r.canonical_hash,
        })),
        insulin_treatment_events: insulinResult.rows.map(r => ({
          event_id: r.id,
          occurred_at: r.occurred_at,
          event_type: r.type,
          source_record_id: r.source_record_id,
          payload: r.payload,
        })),
        meal_events: mealResult.rows.map(r => ({
          event_id: r.id,
          occurred_at: r.occurred_at,
          source_record_id: r.source_record_id,
          payload: r.payload,
        })),
        activity_events: [],
        hypo_episodes: hypoResult.rows.map(r => ({
          episode_id: r.id,
          trigger_id: r.trigger_id,
          state: r.state,
          severity: r.severity,
          started_at: r.started_at,
          ended_at: r.ended_at,
        })),
        range_event_facts: [],
        summaries: {
          total_events: glucoseResult.rows.length + insulinResult.rows.length + mealResult.rows.length + hypoResult.rows.length,
          glucose_count: glucoseResult.rows.length,
          insulin_treatment_count: insulinResult.rows.length,
          meal_count: mealResult.rows.length,
          activity_count: 0,
          hypo_episode_count: hypoResult.rows.length,
          // Calculated over readings with a numeric value only; null when there are none.
          ...glucoseSummary(glucoseResult.rows.map((r: any) => r.payload?.glucose_value)),
          missing_sections: ['activity_events'],
        },
      },
      provenance: {
        source_refs: [MESSAGE_ID],
        selection_policy_version: null,
      },
    };

    // 11. Save the reconstructed context
    // Notes are written next to the context, outside the hashed object.
    const reconstructionNotes = {
      values: 'Rows and fields are read from the database; summaries are calculated from them.',
      unavailable: {
        timezone: 'not stored on ai_executions; this tool does not read the context package payload',
        normalization_policy_version: 'not stored on ai_executions',
        selection_policy_version: 'not stored on ai_executions',
        activity_events: 'not queried by this tool',
        range_event_facts: 'not queried by this tool',
      },
      derived_from_task_id: ['analysis_request_input.user_message_id', 'analysis_request_input.range_type', 'analysis_request_input.range_start', 'analysis_request_input.range_end', 'conversation_context.thread_id', 'patient_ref (ai_executions.patient_id)'],
    };
    const contextPath = writeReconstructionOutput(
      outputDir,
      'reconstructed-context.json',
      JSON.stringify({ ...reconstructedContext, reconstruction_notes: reconstructionNotes }, null, 2),
    );
    console.log(`[OK] Reconstructed context saved to: ${contextPath}`);

    // 12. Compute hashes to compare with original
    console.log('\n10. Computing hashes for validation...\n');

    // Simple canonical JSON for hashing
    const contextJson = JSON.stringify(reconstructedContext, Object.keys(reconstructedContext).sort());
    const contextHash = createHash('sha256').update(contextJson).digest('hex');
    const contextBytes = Buffer.byteLength(contextJson, 'utf8');

    console.log(`Reconstructed context:`);
    console.log(`  Canonical SHA256: sha256:${contextHash}`);
    console.log(`  Serialized bytes: ${contextBytes}`);
    console.log(`\nOriginal from DB:`);
    console.log(`  Context hash: ${exec.context_package_hash}`);
    console.log(`  Serialized bytes: ${exec.serialized_input_bytes}`);
    console.log(`\nComparison:`);
    const storedHash = typeof exec.context_package_hash === 'string' ? exec.context_package_hash.replace('sha256:', '') : null;
    const storedBytes = typeof exec.serialized_input_bytes === 'number' ? exec.serialized_input_bytes : null;
    console.log(`  Hash match: ${storedHash === null ? 'unavailable (no stored hash)' : contextHash === storedHash ? 'YES' : 'NO (expected - we\'re building incrementally)'}`);
    console.log(`  Bytes match: ${storedBytes === null ? 'unavailable (no stored size)' : contextBytes === storedBytes ? 'YES' : 'NO'}`);
    console.log(`  Byte difference: ${storedBytes === null ? 'unavailable' : `${Math.abs(contextBytes - storedBytes)} bytes`}`);

    // 13. Summary
    console.log('\n\n=== STAGE 2 SUMMARY ===\n');
    console.log('Reconstructed data:');
    console.log(`  Messages in conversation: ${msgsResult.rows.length}`);
    console.log(`  Recent messages (last 12): ${recentMessages.length}`);
    console.log(`  Glucose events: ${glucoseResult.rows.length}`);
    console.log(`  Insulin events: ${insulinResult.rows.length}`);
    console.log(`  Meal events: ${mealResult.rows.length}`);
    console.log(`  Hypo episodes: ${hypoResult.rows.length}`);
    console.log(`  Current state: ${currentState ? 'Found' : 'Not found'}`);
    console.log(`\nArtifact saved to: ${contextPath}`);
    console.log(`\nNext: Build system instructions and user payload using prompt builder code`);

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
