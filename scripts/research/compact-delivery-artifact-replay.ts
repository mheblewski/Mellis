import { Pool } from 'pg';
import {
  buildCompactDeliveryArtifact,
  isCoreTaskFamily,
} from '@modules/context/application/compact-delivery-artifact';
import type { EvidenceSelectionShadowResult } from '@modules/context/application/evidence-selection-shadow';
import type {
  AiTask,
  DirectResponseContextRecord,
  TimeRangeAnalysisContextRecord,
} from '@modules/ai-gateway/domain/ai-gateway';
import type { ContextPackageRecord } from '@modules/context/domain/context-package';

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
  created_at: string;
  input_tokens: string | null;
  serialized_input_bytes: string | null;
  context_package_usage: unknown;
  payload: unknown;
}

function hydrateShadowFromPersisted(args: {
  row: ReplayRow;
  contextPackage: ContextPackageRecord | DirectResponseContextRecord | TimeRangeAnalysisContextRecord;
}): EvidenceSelectionShadowResult | null {
  const usage = (args.row.context_package_usage ?? {}) as Record<string, unknown>;
  const shadow = (usage.shadow_selection ?? null) as Record<string, unknown> | null;

  if (!shadow) {
    return null;
  }

  const selectedFamilies = Array.isArray(shadow.selected_evidence_families)
    ? (shadow.selected_evidence_families as string[])
    : [];

  const context = args.contextPackage as unknown as Record<string, unknown>;

  return {
    shadow_version: String(shadow.shadow_version ?? 'evidence-selection-shadow.v1') as 'evidence-selection-shadow.v1',
    task_type: args.row.task_type,
    task_identity: args.row.task_identity,
    patient_id: args.row.patient_id,
    context_package_id: args.row.context_package_id,
    context_package_version: args.row.context_package_version,
    context_package_hash: args.row.context_package_hash,
    evidence_representation_version: args.row.context_package_version,
    task_evidence_policy_version: 'task-evidence-policy.v1',
    evidence_selection_policy_version: 'evidence-selection-policy.v1',
    evidence_relationship_semantics_version: 'evidence-relationship-semantics.v1',
    selection_profile: String(shadow.selection_profile ?? 'UNKNOWN'),
    default_level: String(shadow.selected_level ?? 'UNKNOWN'),
    selected_level: String(shadow.selected_level ?? 'UNKNOWN'),
    status: String(shadow.status ?? 'SHADOW_SELECTION_FAILED') as EvidenceSelectionShadowResult['status'],
    selected_evidence_families: selectedFamilies as EvidenceSelectionShadowResult['selected_evidence_families'],
    selected_evidence_ref_count: Number(shadow.selected_evidence_ref_count ?? 0),
    selected_evidence_refs_sample: [],
    omitted_evidence_ref_count: Number(shadow.omitted_evidence_ref_count ?? 0),
    omitted_evidence_refs_sample: [],
    relationship_decisions: [],
    unresolved_reasons: Array.isArray(shadow.unresolved_reasons)
      ? (shadow.unresolved_reasons as string[])
      : [],
    unknowns: [],
    missing: [],
    excluded: [],
    not_selected: [],
    provenance_refs_sample: Array.isArray((context as { source_refs?: unknown[] }).source_refs)
      ? ((context as { source_refs: unknown[] }).source_refs.map((value) => String(value)).slice(0, 64))
      : [],
    input_material_hash: 'sha256:unavailable-from-persisted-shadow-summary',
    selection_material_hash: String(shadow.selection_material_hash ?? 'sha256:unavailable-from-persisted-shadow-summary'),
    current_payload_bytes: 0,
    current_payload_tokens: null,
    current_payload_tokens_kind: 'UNAVAILABLE',
    shadow_payload_bytes: 0,
    shadow_payload_tokens_estimate: null,
    shadow_payload_tokens_kind: 'UNAVAILABLE',
    bytes_saved: Number(shadow.bytes_saved ?? 0),
    bytes_reduction_pct: Number(shadow.bytes_reduction_pct ?? 0),
    token_reduction_estimate: typeof shadow.token_reduction_estimate === 'number' ? shadow.token_reduction_estimate : null,
    token_reduction_pct_estimate: typeof shadow.token_reduction_pct_estimate === 'number' ? shadow.token_reduction_pct_estimate : null,
    family_counts: {},
    telemetry_bounded: true,
  };
}

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stablePercent(saved: number, original: number): number {
  if (original <= 0) {
    return 0;
  }
  return Number(((saved / original) * 100).toFixed(4));
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

function asContextPackage(row: ReplayRow): ContextPackageRecord | DirectResponseContextRecord | TimeRangeAnalysisContextRecord {
  return row.payload as ContextPackageRecord | DirectResponseContextRecord | TimeRangeAnalysisContextRecord;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/gluco_mind' });

  try {
    const result = await pool.query<ReplayRow>(
      `
      WITH base AS (
        SELECT
          e.id,
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
          e.created_at::text,
          e.input_tokens::text,
          e.serialized_input_bytes::text,
          e.context_package_usage,
          cp.payload,
          row_number() OVER (PARTITION BY e.task_type ORDER BY e.created_at DESC) AS rn
        FROM ai_executions e
        JOIN context_packages cp
          ON cp.package_version = e.context_package_version
         AND cp.content_hash = e.context_package_hash
        WHERE e.status = 'succeeded'
          AND e.context_package_usage ? 'shadow_selection'
          AND e.task_type IN ('CONVERSATION_DIRECT_RESPONSE','CONVERSATION_TIME_RANGE_ANALYSIS')
      )
      SELECT *
      FROM base
      WHERE rn <= 2
      ORDER BY task_type, created_at DESC
      `,
    );

    const rows = result.rows.filter((row) => isCoreTaskFamily(row.task_type));

    const entries = rows.map((row) => {
      const task = asTask(row);
      const contextPackage = asContextPackage(row);
      const persistedShadow = hydrateShadowFromPersisted({ row, contextPackage });
      const artifact = buildCompactDeliveryArtifact({
        contextPackage,
        task,
        shadowSelection: persistedShadow ?? undefined,
      });

      const usage = (row.context_package_usage ?? {}) as Record<string, unknown>;
      const usageTotal = typeof usage.total_serialized_bytes === 'number' ? usage.total_serialized_bytes : null;
      const serializedInputBytes = toNumber(row.serialized_input_bytes);
      const currentBytes = serializedInputBytes ?? usageTotal ?? 0;
      const savedBytes = Math.max(0, currentBytes - artifact.artifact_bytes);

      return {
        task_type: row.task_type,
        execution_id: row.id,
        task_identity: row.task_identity,
        context_package_hash: row.context_package_hash,
        context_package_version: row.context_package_version,
        artifact_bytes: artifact.artifact_bytes,
        artifact_hash: artifact.artifact_content_hash,
        selected_families: artifact.selected_families,
        selected_ref_count: artifact.selected_evidence_refs.length,
        omitted_families: artifact.omitted_families,
        omitted_ref_count: artifact.omitted_evidence_refs.length,
        omission_reasons: artifact.omitted_families.map((item) => ({ family: item.family, reason_code: item.reason_code })),
        provenance_count: artifact.provenance.count,
        provenance_bytes: artifact.provenance.bytes,
        unknown_count: artifact.unknown_states.length,
        missing_count: artifact.missing_states.length,
        excluded_count: artifact.excluded_states.length,
        not_selected_count: artifact.not_selected_states.length,
        relationship_decisions: artifact.relationship_decisions,
        unresolved_reasons: artifact.unresolved_reasons,
        current_provider_input_tokens: toNumber(row.input_tokens),
        current_provider_input_bytes: currentBytes,
        reduction_bytes: savedBytes,
        reduction_pct: stablePercent(savedBytes, currentBytes),
        deterministic_replay_metadata: artifact.deterministic_replay_metadata,
      };
    });

    const aggregate = entries.reduce<Record<string, {
      samples: number;
      avg_artifact_bytes: number;
      avg_current_bytes: number;
      avg_reduction_pct: number;
      avg_tokens: number | null;
    }>>((acc, entry) => {
      const existing = acc[entry.task_type] ?? {
        samples: 0,
        avg_artifact_bytes: 0,
        avg_current_bytes: 0,
        avg_reduction_pct: 0,
        avg_tokens: 0,
      };

      const nextSamples = existing.samples + 1;
      const tokens = entry.current_provider_input_tokens ?? 0;
      const existingTokens = existing.avg_tokens ?? 0;

      acc[entry.task_type] = {
        samples: nextSamples,
        avg_artifact_bytes: Number(((existing.avg_artifact_bytes * existing.samples + entry.artifact_bytes) / nextSamples).toFixed(2)),
        avg_current_bytes: Number(((existing.avg_current_bytes * existing.samples + entry.current_provider_input_bytes) / nextSamples).toFixed(2)),
        avg_reduction_pct: Number(((existing.avg_reduction_pct * existing.samples + entry.reduction_pct) / nextSamples).toFixed(4)),
        avg_tokens: Number(((existingTokens * existing.samples + tokens) / nextSamples).toFixed(2)),
      };

      return acc;
    }, {});

    const report = {
      generated_at: new Date().toISOString(),
      source_database: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/gluco_mind',
      requirement_check: {
        direct_status: 'NOT_APPLICABLE_BY_DESIGN',
        direct_samples: entries.filter((entry) => entry.task_type === 'CONVERSATION_DIRECT_RESPONSE').length,
        time_range_status: 'REQUIRED',
        time_range_samples: entries.filter((entry) => entry.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS').length,
      },
      entries,
      aggregate,
    };

    console.log('COMPACT_ARTIFACT_REPLAY_JSON_BEGIN');
    console.log(JSON.stringify(report, null, 2));
    console.log('COMPACT_ARTIFACT_REPLAY_JSON_END');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  console.error(`Compact artifact replay failed: ${message}`);
  process.exitCode = 1;
});
