import { Pool } from 'pg';
import { buildAiTaskIdentity } from '@modules/ai-gateway/application/ai-task';
import { buildExactInputFingerprint } from '@modules/ai-gateway/application/ai-observability';
import { buildTimeRangeAnalysisPrompt } from '@modules/ai-gateway/application/time-range-analysis-prompt';
import { buildOpenAiResponsesRequestBody } from '@modules/ai-gateway/infrastructure/openai-provider';
import type { AiTask, TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import {
  TIME_RANGE_FULL_REPLAY_NORMALIZER_V1,
  type LegacyTimeRangePayloadV1,
  normalizeTimeRangeFullReplayInputV1,
} from './replay/time-range-full-replay-normalizer-v1';

interface ReplayRow {
  id: string;
  task_identity: string;
  task_id: string;
  task_type: string;
  task_version: string;
  patient_id: string | null;
  trigger_id: string | null;
  analysis_id: string | null;
  context_package_id: string;
  context_package_version: string;
  context_package_hash: string;
  correlation_id: string;
  prompt_version: string;
  output_schema_version: string;
  model_policy_version: string;
  provider: string | null;
  model: string | null;
  model_fingerprint: string | null;
  input_fingerprint: string | null;
  serialized_input_bytes: string | null;
  created_at: string;
  payload: unknown;
}

interface ForensicExecutionEvidence {
  execution_id: string;
  task_id: string;
  task_type: string;
  task_version: string;
  prompt_version: string;
  output_schema_version: string;
  model: string | null;
  provider: string | null;
  model_fingerprint: string | null;
  task_identity_persisted: string;
  task_identity_rebuilt: string;
  context_package_hash: string;
  context_package_version: string;
  persisted_input_fingerprint: string | null;
  reconstructed_input_fingerprint: string | null;
  persisted_serialized_input_bytes: number | null;
  reconstructed_serialized_input_bytes: number | null;
  context_hash_rebuilt: string | null;
  full_input_exact_match: boolean;
  blocked_reasons: string[];
  reconstructed_via: 'CURRENT_TIME_RANGE_CONTEXT' | 'TIME_RANGE_FULL_REPLAY_NORMALIZER_V1';
}

interface DeterminismAudit {
  provider: string;
  model: string;
  temperature: 'NOT_EXPLICITLY_CONFIGURED';
  seed: 'NOT_EXPLICITLY_CONFIGURED';
  structured_output: 'JSON_SCHEMA_STRICT';
  deterministic_replay_guaranteed: false;
  repeated_replay_plan: {
    full_runs_per_case: 5;
    compact_runs_per_case: 5;
    compare_distributions_not_single_pair: true;
  };
}

function asTask(row: ReplayRow): AiTask {
  return {
    task_id: row.task_id,
    task_type: row.task_type as AiTask['task_type'],
    task_version: row.task_version,
    patient_id: row.patient_id ?? undefined,
    trigger_id: row.trigger_id ?? undefined,
    analysis_id: row.analysis_id ?? undefined,
    context_package_id: row.context_package_id,
    context_package_version: row.context_package_version,
    context_package_hash: row.context_package_hash,
    correlation_id: row.correlation_id,
    prompt_version: row.prompt_version,
    output_schema_version: row.output_schema_version,
    model_policy_version: row.model_policy_version,
    created_at: row.created_at,
  };
}

function parseLegacyTimeRangePayload(payload: unknown): LegacyTimeRangePayloadV1 | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (record.context_package_version !== 'conversation-time-range-context.v1') {
    return null;
  }

  if (record.analysis_request_input) {
    return null;
  }

  const range = record.range as Record<string, unknown> | undefined;
  const evidence = record.evidence_sections as Record<string, unknown> | undefined;
  if (!range || !evidence) {
    return null;
  }

  return {
    capability: 'ANALYSIS_REQUEST',
    range: {
      user_message_id: String(range.user_message_id ?? ''),
      user_message_text: String(range.user_message_text ?? ''),
      range_type: 'TODAY',
      timezone: String(range.timezone ?? 'UTC'),
      range_start: String(range.range_start ?? ''),
      range_end: String(range.range_end ?? ''),
      requested_at: String(range.requested_at ?? ''),
    },
    selection_policy_version: String(record.selection_policy_version ?? 'conversation-time-range-context-selection.v1'),
    evidence_sections: {
      glucose_events: Number(evidence.glucose_events ?? 0),
      insulin_treatment_events: Number(evidence.insulin_treatment_events ?? 0),
      meal_events: Number(evidence.meal_events ?? 0),
      activity_events: Number(evidence.activity_events ?? 0),
      hypo_episodes: Number(evidence.hypo_episodes ?? 0),
      range_event_facts: Number(evidence.range_event_facts ?? 0),
    },
    source_refs: Array.isArray(record.source_refs) ? record.source_refs.map((item) => String(item)) : [],
    context_package_id: String(record.context_package_id ?? ''),
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: String(record.content_hash ?? ''),
  };
}

function parseIntOrNull(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadTimeRangeInputsFromDb(args: {
  pool: Pool;
  patientId: string;
  conversationId: string;
  userMessageId: string;
  rangeStartIso: string;
  rangeEndIso: string;
  requestedAtIso: string;
}): Promise<{
  conversation: { id: string; thread_state_version: string | null; awaiting_user_answer: boolean };
  userMessage: { id: string; content: string; created_at: string; provenance_ref: string | null };
  messages: Array<{ id: string; role: string | null; created_at: string; content: string | null; provenance_ref: string | null; message_type: string | null }>;
  currentState: Record<string, unknown> | null;
  events: Array<{ id: string; type: string; occurred_at: string; payload: Record<string, unknown>; source_record_id: string | null }>;
  hypoEpisodes: Array<{ id: string; state: string; severity: string; started_at: string; ended_at: string | null; trigger_id: string | null }>;
  facts: Array<{
    id: string;
    fact_key: string;
    fact_name: string;
    value: unknown;
    value_type: string;
    knowledge_status: string;
    source_ref: string;
    source_event_id: string | null;
    source_conversation_id: string | null;
    recorded_at: string;
    created_at: string;
  }>;
} | null> {
  const conversationResult = await args.pool.query(
    `SELECT id::text, thread_state_version, awaiting_user_answer FROM conversations WHERE patient_id = $1::uuid AND id = $2::uuid LIMIT 1`,
    [args.patientId, args.conversationId],
  );
  const conversation = conversationResult.rows[0];
  if (!conversation) {
    return null;
  }

  const userMessageResult = await args.pool.query(
    `SELECT id::text, content, created_at::text, provenance_ref FROM messages WHERE conversation_id = $1::uuid AND id = $2::uuid LIMIT 1`,
    [args.conversationId, args.userMessageId],
  );
  const userMessage = userMessageResult.rows[0];
  if (!userMessage) {
    return null;
  }

  const messagesResult = await args.pool.query(
    `SELECT id::text, role, created_at::text, content, provenance_ref, message_type FROM messages WHERE patient_id = $1::uuid AND conversation_id = $2::uuid ORDER BY created_at ASC`,
    [args.patientId, args.conversationId],
  );

  const currentStateResult = await args.pool.query<{ snapshot: Record<string, unknown> }>(
    `SELECT snapshot FROM current_states WHERE patient_id = $1::uuid AND updated_at <= $2::timestamptz ORDER BY updated_at DESC LIMIT 1`,
    [args.patientId, args.requestedAtIso],
  );

  const fallbackStateResult = currentStateResult.rows[0]
    ? null
    : await args.pool.query<{ snapshot: Record<string, unknown> }>(
      `SELECT snapshot FROM current_states WHERE patient_id = $1::uuid ORDER BY updated_at DESC LIMIT 1`,
      [args.patientId],
    );

  const eventsResult = await args.pool.query(
    `
      SELECT id::text, type, occurred_at::text, payload, source_record_id::text
      FROM events
      WHERE patient_id = $1::uuid
        AND occurred_at >= $2::timestamptz
        AND occurred_at <= $3::timestamptz
      ORDER BY occurred_at ASC, created_at ASC, id ASC
      LIMIT 1800
    `,
    [args.patientId, args.rangeStartIso, args.rangeEndIso],
  );

  const episodesResult = await args.pool.query(
    `
      SELECT id::text, state, severity, started_at::text, ended_at::text, trigger_id::text
      FROM hypo_episodes
      WHERE patient_id = $1::uuid
        AND started_at <= $3::timestamptz
        AND COALESCE(ended_at, $3::timestamptz) >= $2::timestamptz
      ORDER BY started_at ASC, created_at ASC, id ASC
      LIMIT 50
    `,
    [args.patientId, args.rangeStartIso, args.rangeEndIso],
  );

  const factsResult = await args.pool.query(
    `
      SELECT id::text, fact_key, fact_name, value, value_type, knowledge_status, source_ref, source_event_id::text, source_conversation_id::text, recorded_at::text, created_at::text
      FROM patient_context
      WHERE patient_id = $1::uuid
        AND scope = 'EVENT'
        AND recorded_at >= $2::timestamptz
        AND recorded_at <= $3::timestamptz
      ORDER BY recorded_at ASC, created_at ASC, id ASC
      LIMIT 150
    `,
    [args.patientId, args.rangeStartIso, args.rangeEndIso],
  );

  return {
    conversation: {
      id: String(conversation.id),
      thread_state_version: conversation.thread_state_version ? String(conversation.thread_state_version) : null,
      awaiting_user_answer: Boolean(conversation.awaiting_user_answer),
    },
    userMessage: {
      id: String(userMessage.id),
      content: String(userMessage.content ?? ''),
      created_at: String(userMessage.created_at),
      provenance_ref: userMessage.provenance_ref ? String(userMessage.provenance_ref) : null,
    },
    messages: messagesResult.rows.map((row) => ({
      id: String(row.id),
      role: row.role ? String(row.role) : null,
      created_at: String(row.created_at),
      content: row.content === null ? null : String(row.content),
      provenance_ref: row.provenance_ref ? String(row.provenance_ref) : null,
      message_type: row.message_type ? String(row.message_type) : null,
    })),
    currentState: currentStateResult.rows[0]?.snapshot ?? fallbackStateResult?.rows[0]?.snapshot ?? null,
    events: eventsResult.rows.map((row) => ({
      id: String(row.id),
      type: String(row.type),
      occurred_at: String(row.occurred_at),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      source_record_id: row.source_record_id ? String(row.source_record_id) : null,
    })),
    hypoEpisodes: episodesResult.rows.map((row) => ({
      id: String(row.id),
      state: String(row.state ?? ''),
      severity: String(row.severity ?? ''),
      started_at: String(row.started_at ?? ''),
      ended_at: row.ended_at ? String(row.ended_at) : null,
      trigger_id: row.trigger_id ? String(row.trigger_id) : null,
    })),
    facts: factsResult.rows.map((row) => ({
      id: String(row.id),
      fact_key: String(row.fact_key ?? ''),
      fact_name: String(row.fact_name ?? ''),
      value: row.value,
      value_type: String(row.value_type ?? ''),
      knowledge_status: String(row.knowledge_status ?? ''),
      source_ref: String(row.source_ref ?? ''),
      source_event_id: row.source_event_id ? String(row.source_event_id) : null,
      source_conversation_id: row.source_conversation_id ? String(row.source_conversation_id) : null,
      recorded_at: String(row.recorded_at ?? ''),
      created_at: String(row.created_at ?? ''),
    })),
  };
}

async function reconstructContextPackage(args: {
  pool: Pool;
  row: ReplayRow;
  task: AiTask;
}): Promise<{ contextPackage: TimeRangeAnalysisContextRecord | null; reconstructed_via: ForensicExecutionEvidence['reconstructed_via']; error: string | null }> {
  const payload = args.row.payload as Record<string, unknown>;
  if (payload.analysis_request_input && payload.conversation_context && payload.analytical_evidence) {
    return {
      contextPackage: payload as unknown as TimeRangeAnalysisContextRecord,
      reconstructed_via: 'CURRENT_TIME_RANGE_CONTEXT',
      error: null,
    };
  }

  const legacy = parseLegacyTimeRangePayload(payload);
  if (!legacy) {
    return {
      contextPackage: null,
      reconstructed_via: 'TIME_RANGE_FULL_REPLAY_NORMALIZER_V1',
      error: 'UNSUPPORTED_TIME_RANGE_PAYLOAD_SHAPE',
    };
  }

  const patientId = args.row.patient_id ?? '';
  if (!patientId) {
    return {
      contextPackage: null,
      reconstructed_via: 'TIME_RANGE_FULL_REPLAY_NORMALIZER_V1',
      error: 'MISSING_PATIENT_ID',
    };
  }

  const loaded = await loadTimeRangeInputsFromDb({
    pool: args.pool,
    patientId,
    conversationId: args.row.correlation_id,
    userMessageId: legacy.range.user_message_id,
    rangeStartIso: legacy.range.range_start,
    rangeEndIso: legacy.range.range_end,
    requestedAtIso: legacy.range.requested_at,
  });

  if (!loaded) {
    return {
      contextPackage: null,
      reconstructed_via: 'TIME_RANGE_FULL_REPLAY_NORMALIZER_V1',
      error: 'TIME_RANGE_RUNTIME_INPUTS_NOT_FOUND',
    };
  }

  const normalized = normalizeTimeRangeFullReplayInputV1({
    patient_id: patientId,
    conversation: loaded.conversation,
    user_message: loaded.userMessage,
    conversation_messages: loaded.messages,
    current_state: loaded.currentState as unknown as { as_of?: string; glucose?: { value?: number; trend?: string }; iob?: { value?: number } } | null,
    events: loaded.events,
    hypo_episodes: loaded.hypoEpisodes,
    range_facts: loaded.facts,
    legacy_payload: legacy,
  });

  return {
    contextPackage: normalized,
    reconstructed_via: TIME_RANGE_FULL_REPLAY_NORMALIZER_V1,
    error: null,
  };
}

function buildDeterminismAudit(rows: ReplayRow[]): DeterminismAudit {
  const first = rows[0];
  return {
    provider: first?.provider ?? 'unknown',
    model: first?.model ?? 'unknown',
    temperature: 'NOT_EXPLICITLY_CONFIGURED',
    seed: 'NOT_EXPLICITLY_CONFIGURED',
    structured_output: 'JSON_SCHEMA_STRICT',
    deterministic_replay_guaranteed: false,
    repeated_replay_plan: {
      full_runs_per_case: 5,
      compact_runs_per_case: 5,
      compare_distributions_not_single_pair: true,
    },
  };
}

function summarizeMissingInfo(evidence: ForensicExecutionEvidence[]): string[] {
  const reasons = new Set<string>();
  for (const item of evidence) {
    for (const reason of item.blocked_reasons) {
      if (reason.startsWith('MISSING_') || reason.includes('NOT_FOUND') || reason.includes('UNSUPPORTED')) {
        reasons.add(reason);
      }
      if (reason.startsWith('TIME_RANGE_HISTORICAL_DATA_DRIFT:')) {
        reasons.add('MISSING_FROZEN_TIME_RANGE_EVENT_IDENTITY_SET_AT_EXECUTION_TIME');
      }
      if (reason === 'CONTEXT_PACKAGE_HASH_MISMATCH') {
        reasons.add('MISSING_EXACT_TIME_RANGE_CONTEXT_SNAPSHOT_FIELDS_USED_FOR_CONTEXT_HASH');
      }
    }
  }
  return [...reasons];
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/gluco_mind' });

  try {
    const result = await pool.query<ReplayRow>(`
      WITH base AS (
        SELECT
          e.id::text,
          e.task_identity,
          e.task_id,
          e.task_type,
          e.task_version,
          e.patient_id,
          e.trigger_id,
          e.analysis_id,
          e.context_package_id,
          e.context_package_version,
          e.context_package_hash,
          e.correlation_id,
          e.prompt_version,
          e.output_schema_version,
          e.model_policy_version,
          e.provider,
          e.model,
          e.model_fingerprint,
          e.input_fingerprint,
          e.serialized_input_bytes::text,
          e.created_at::text,
          cp.payload,
          row_number() OVER (PARTITION BY e.task_type ORDER BY e.created_at DESC) AS rn
        FROM ai_executions e
        JOIN context_packages cp
          ON cp.package_version = e.context_package_version
         AND cp.content_hash = e.context_package_hash
        WHERE e.status = 'succeeded'
          AND e.task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS'
      )
      SELECT *
      FROM base
      WHERE rn <= 2
      ORDER BY task_type ASC, created_at DESC
    `);

    const observed = {
      CONVERSATION_TIME_RANGE_ANALYSIS: result.rows.filter((row) => row.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS').length,
    };

    const evidence: ForensicExecutionEvidence[] = [];

    for (const row of result.rows) {
      const task = asTask(row);
      const rebuiltTaskIdentity = buildAiTaskIdentity(task);
      const blockedReasons: string[] = [];

      const contextRebuild = await reconstructContextPackage({ pool, row, task });
      if (contextRebuild.error || !contextRebuild.contextPackage) {
        blockedReasons.push(`FULL_INPUT_RECONSTRUCTION_ERROR:${contextRebuild.error ?? 'UNKNOWN'}`);
      }

      const taskIdentityMatch = rebuiltTaskIdentity === row.task_identity;
      if (!taskIdentityMatch) blockedReasons.push('TASK_IDENTITY_MISMATCH');
      if (task.task_version !== row.task_version) blockedReasons.push('TASK_VERSION_MISMATCH');
      if (task.prompt_version !== row.prompt_version) blockedReasons.push('PROMPT_VERSION_MISMATCH');
      if (task.output_schema_version !== row.output_schema_version) blockedReasons.push('OUTPUT_SCHEMA_VERSION_MISMATCH');
      if (task.context_package_hash !== row.context_package_hash) blockedReasons.push('TASK_CONTEXT_HASH_MISMATCH');
      if (!row.provider || !row.model) blockedReasons.push('MISSING_PROVIDER_OR_MODEL');
      if ((row.provider ?? '').toLowerCase() !== 'openai') blockedReasons.push('UNSUPPORTED_PROVIDER_FOR_FORENSIC_REPLAY');
      if (!row.input_fingerprint) blockedReasons.push('MISSING_PERSISTED_INPUT_FINGERPRINT');
      const persistedBytes = parseIntOrNull(row.serialized_input_bytes);
      if (persistedBytes === null) blockedReasons.push('MISSING_PERSISTED_SERIALIZED_INPUT_BYTES');

      let reconstructedFingerprint: string | null = null;
      let reconstructedBytes: number | null = null;
      let rebuiltContextHash: string | null = null;

      if (contextRebuild.contextPackage && row.model) {
        rebuiltContextHash = String((contextRebuild.contextPackage as TimeRangeAnalysisContextRecord).content_hash ?? null);
        if (row.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS' && rebuiltContextHash !== row.context_package_hash) {
          blockedReasons.push('CONTEXT_PACKAGE_HASH_MISMATCH');
        }

        if (row.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS') {
          const legacy = parseLegacyTimeRangePayload(row.payload);
          const rebuilt = contextRebuild.contextPackage as TimeRangeAnalysisContextRecord;
          if (legacy) {
            const rebuiltCounts = {
              glucose_events: rebuilt.analytical_evidence.glucose_events.length,
              insulin_treatment_events: rebuilt.analytical_evidence.insulin_treatment_events.length,
              meal_events: rebuilt.analytical_evidence.meal_events.length,
              activity_events: rebuilt.analytical_evidence.activity_events.length,
              hypo_episodes: rebuilt.analytical_evidence.hypo_episodes.length,
              range_event_facts: rebuilt.analytical_evidence.range_event_facts.length,
            };

            for (const key of Object.keys(legacy.evidence_sections) as Array<keyof LegacyTimeRangePayloadV1['evidence_sections']>) {
              if (legacy.evidence_sections[key] !== rebuiltCounts[key]) {
                blockedReasons.push(`TIME_RANGE_HISTORICAL_DATA_DRIFT:${key}:${legacy.evidence_sections[key]}!=${rebuiltCounts[key]}`);
              }
            }
          }
        }

        const prompt = buildTimeRangeAnalysisPrompt(task, contextRebuild.contextPackage as TimeRangeAnalysisContextRecord);

        const requestBody = buildOpenAiResponsesRequestBody({
          model: row.model,
          task_type: row.task_type,
          system_instructions: prompt.system_instructions,
          user_payload: prompt.user_payload,
        });

        reconstructedFingerprint = buildExactInputFingerprint(requestBody);
        reconstructedBytes = Buffer.byteLength(JSON.stringify(requestBody), 'utf8');
      }

      const fullInputExactMatch =
        blockedReasons.length === 0
        && reconstructedFingerprint === row.input_fingerprint
        && reconstructedBytes === persistedBytes;

      if (!fullInputExactMatch && blockedReasons.length === 0) {
        blockedReasons.push('FULL_INPUT_FINGERPRINT_OR_BYTES_MISMATCH');
      }

      evidence.push({
        execution_id: row.id,
        task_id: row.task_id,
        task_type: row.task_type,
        task_version: row.task_version,
        prompt_version: row.prompt_version,
        output_schema_version: row.output_schema_version,
        model: row.model,
        provider: row.provider,
        model_fingerprint: row.model_fingerprint,
        task_identity_persisted: row.task_identity,
        task_identity_rebuilt: rebuiltTaskIdentity,
        context_package_hash: row.context_package_hash,
        context_package_version: row.context_package_version,
        persisted_input_fingerprint: row.input_fingerprint,
        reconstructed_input_fingerprint: reconstructedFingerprint,
        persisted_serialized_input_bytes: persistedBytes,
        reconstructed_serialized_input_bytes: reconstructedBytes,
        context_hash_rebuilt: rebuiltContextHash,
        full_input_exact_match: fullInputExactMatch,
        blocked_reasons: blockedReasons,
        reconstructed_via: contextRebuild.reconstructed_via,
      });
    }

    const timeRangeEvidence = evidence.filter((item) => item.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS');

    const allCoverageOk = observed.CONVERSATION_TIME_RANGE_ANALYSIS >= 2;
    const timeRangePass = timeRangeEvidence.length >= 2 && timeRangeEvidence.every((item) => item.fullInputExactMatch);
    const fullReady = allCoverageOk && timeRangePass;

    const finalStatus = fullReady ? 'FULL_RECONSTRUCTION_READY' : 'TIME_RANGE_FULL_RECONSTRUCTION_BLOCKED';

    const report = {
      generated_at: new Date().toISOString(),
      source_database: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/gluco_mind',
      phase_1_trace: {
        production_path: {
          user_request_to_task: 'apps/api/src/application/api.service.ts -> conversation.time_range_analysis job',
          task_to_context_package: 'apps/worker/src/worker.service.ts handleConversationTimeRangeAnalysis',
          prompt_builder: 'modules/ai-gateway/application/time-range-analysis-prompt.ts',
          ai_gateway_input: 'modules/ai-gateway/application/ai-gateway.service.ts execute()',
          provider_request: 'modules/ai-gateway/infrastructure/openai-provider.ts buildOpenAiResponsesRequestBody()',
          fingerprint: 'modules/ai-gateway/application/ai-observability.ts buildExactInputFingerprint()',
        },
        observed_samples: observed,
        required_samples: {
          CONVERSATION_TIME_RANGE_ANALYSIS: 2,
        },
        executions: evidence,
      },
      phase_2_determinism_audit: buildDeterminismAudit(result.rows),
      phase_3_replay_gate: {
        allowed: fullReady,
        reason: fullReady
          ? 'Exact FULL reconstruction is proven for 2/2 TIME_RANGE.'
          : 'Blocked until strict FULL fingerprint and byte equality is proven for all required samples.',
      },
      missing_persisted_information: summarizeMissingInfo(evidence),
      final_status: finalStatus,
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
