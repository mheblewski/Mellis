import 'dotenv/config';
import { Pool } from 'pg';

type NumericValue = number | null;

type AiExecutionRow = {
  id: string;
  task_identity: string;
  task_id: string;
  task_type: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  provider_latency_ms: number | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  total_tokens: string | number | null;
  cached_input_tokens: string | number | null;
  reasoning_tokens: string | number | null;
  input_fingerprint: string | null;
  serialized_input_bytes: string | number | null;
  context_package_id: string | null;
  context_package_version: string | null;
  context_package_hash: string | null;
  estimated_cost: string | number | null;
  cost_currency: string | null;
  pricing_version: string | null;
  context_package_usage: {
    total_serialized_bytes?: string | number | null;
    sections?: Array<{ section_name: string; serialized_bytes: string | number }>;
  } | null;
  created_at: string;
  updated_at: string;
};

type AiAttemptRow = {
  id: string;
  ai_execution_id: string;
  attempt_number: string | number;
  provider: string;
  model: string;
  model_fingerprint: string | null;
  input_fingerprint: string | null;
  started_at: string | null;
  completed_at: string | null;
  provider_latency_ms: string | number | null;
  status: string;
  error_type: string | null;
  error_code: string | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  total_tokens: string | number | null;
  cached_input_tokens: string | number | null;
  reasoning_tokens: string | number | null;
  estimated_cost: string | number | null;
  cost_currency: string | null;
  pricing_version: string | null;
  created_at: string;
};

type ContextPackageRow = {
  id: string;
  package_version: string;
  content_hash: string;
  payload: Record<string, unknown>;
};

type NumericFieldStats = {
  count: number;
  known_count: number;
  unknown_count: number;
  average: NumericValue;
  median: NumericValue;
  p95: NumericValue;
  min: NumericValue;
  max: NumericValue;
  total: NumericValue;
};

type CostFieldStats = NumericFieldStats;

type AttemptGroupStats = {
  execution_count: number;
  success_count: number;
  failure_count: number;
  success_rate: NumericValue;
  attempts_per_execution: NumericValue;
  input_tokens: NumericFieldStats;
  output_tokens: NumericFieldStats;
  total_tokens: NumericFieldStats;
  cached_input_tokens: NumericFieldStats;
  reasoning_tokens: NumericFieldStats;
  estimated_cost: CostFieldStats;
  provider_latency_ms: NumericFieldStats;
};

type SectionStats = {
  section_name: string;
  execution_count: number;
  average_bytes: NumericValue;
  median_bytes: NumericValue;
  p95_bytes: NumericValue;
  total_bytes: NumericValue;
  percentage_of_total_context_bytes: NumericValue;
  average_share: NumericValue;
  median_share: NumericValue;
  p95_share: NumericValue;
};

type OutlierEntry = {
  task_identity: string;
  context_package_id: string | null;
  context_package_version: string | null;
  context_package_hash: string | null;
  value: number;
  status: string;
};

const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/gluco_mind';
const REQUIRED_SECTIONS = [
  'task',
  'trigger',
  'hypo_episode',
  'glucose_evidence',
  'current_state_snapshot',
  'active_therapy_snapshot',
  'conversation_context',
  'event_context_facts',
  'historical_evidence',
  'pattern_evidence',
  'memory_evidence',
  'provenance',
  'source_versions',
] as const;

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(sortedValues: number[], percentileValue: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }

  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const position = (sortedValues.length - 1) * percentileValue;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sortedValues[lowerIndex];
  const upperValue = sortedValues[upperIndex];

  if (lowerIndex === upperIndex) {
    return lowerValue;
  }

  return lowerValue + ((upperValue - lowerValue) * (position - lowerIndex));
}

function buildNumericStats(values: Array<number | null>): NumericFieldStats {
  const knownValues = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const sortedValues = [...knownValues].sort((left, right) => left - right);

  return {
    count: values.length,
    known_count: knownValues.length,
    unknown_count: values.length - knownValues.length,
    average: knownValues.length > 0 ? sum(knownValues) / knownValues.length : null,
    median: percentile(sortedValues, 0.5),
    p95: percentile(sortedValues, 0.95),
    min: sortedValues[0] ?? null,
    max: sortedValues[sortedValues.length - 1] ?? null,
    total: knownValues.length > 0 ? sum(knownValues) : null,
  };
}

function percent(value: number, total: number): number | null {
  if (total <= 0) {
    return null;
  }

  return (value / total) * 100;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function countDuplicates(values: string[]): number {
  return values.length - new Set(values).size;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function extractString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readSectionBytes(sectionUsage: { section_name: string; serialized_bytes: string | number } | undefined): number | null {
  if (!sectionUsage) {
    return null;
  }

  return toNumber(sectionUsage.serialized_bytes);
}

function getContextPackageSections(payload: Record<string, unknown>): Array<{ name: string; value: unknown }> {
  return REQUIRED_SECTIONS.map((name) => ({ name, value: payload[name] ?? null }));
}

function buildSectionRefSets(payload: Record<string, unknown>): Record<string, Set<string>> {
  const historicalEvidence = payload.historical_evidence as Record<string, unknown> | null | undefined;
  const patternEvidence = payload.pattern_evidence as Record<string, unknown> | null | undefined;
  const memoryEvidence = payload.memory_evidence as Record<string, unknown> | null | undefined;
  const conversationContext = payload.conversation_context as Record<string, unknown> | null | undefined;
  const eventContextFacts = payload.event_context_facts as Array<Record<string, unknown>> | null | undefined;
  const provenance = payload.provenance as Record<string, unknown> | null | undefined;

  const historicalRefs = new Set<string>();
  for (const selectedCase of Array.isArray(historicalEvidence?.selected_cases) ? historicalEvidence?.selected_cases as Array<Record<string, unknown>> : []) {
    const caseReference = selectedCase.case_reference;
    if (typeof caseReference === 'string') {
      historicalRefs.add(caseReference);
      continue;
    }

    if (caseReference && typeof caseReference === 'object') {
      const referenceRecord = caseReference as Record<string, unknown>;
      for (const key of ['meal_case_identity', 'meal_case_id', 'case_id', 'id', 'source_record_id']) {
        const candidate = extractString(referenceRecord[key]);
        if (candidate) {
          historicalRefs.add(candidate);
        }
      }
    }
  }

  const patternRefs = new Set<string>();
  for (const selectedPattern of Array.isArray(patternEvidence?.selected_patterns) ? patternEvidence?.selected_patterns as Array<Record<string, unknown>> : []) {
    for (const ref of [...(Array.isArray(selectedPattern.supporting_case_refs) ? selectedPattern.supporting_case_refs : []), ...(Array.isArray(selectedPattern.counterexample_case_refs) ? selectedPattern.counterexample_case_refs : [])]) {
      const candidate = extractString(ref);
      if (candidate) {
        patternRefs.add(candidate);
      }
    }
  }

  const memoryRefs = new Set<string>();
  for (const selectedMemory of Array.isArray(memoryEvidence?.selected_memories) ? memoryEvidence?.selected_memories as Array<Record<string, unknown>> : []) {
    for (const ref of [...(Array.isArray(selectedMemory.evidence_refs) ? selectedMemory.evidence_refs : []), ...(Array.isArray(selectedMemory.contradiction_refs) ? selectedMemory.contradiction_refs : [])]) {
      const candidate = extractString(ref);
      if (candidate) {
        memoryRefs.add(candidate);
      }
    }
  }

  const conversationRefs = new Set<string>();
  for (const message of Array.isArray(conversationContext?.messages) ? conversationContext?.messages as Array<Record<string, unknown>> : []) {
    const candidate = extractString(message.provenance_ref);
    if (candidate) {
      conversationRefs.add(candidate);
    }
  }

  const eventRefs = new Set<string>();
  for (const fact of Array.isArray(eventContextFacts) ? eventContextFacts : []) {
    const source = fact.source as Record<string, unknown> | undefined;
    for (const key of ['source_ref', 'source_event_id', 'source_conversation_id', 'source_question_id']) {
      const candidate = extractString(source?.[key]);
      if (candidate) {
        eventRefs.add(candidate);
      }
    }
  }

  const provenanceRefs = new Set<string>();
  if (provenance) {
    for (const key of ['trigger_id', 'source_event_id', 'current_state_version', 'therapy_version', 'conversation_thread_version']) {
      const candidate = extractString(provenance[key]);
      if (candidate) {
        provenanceRefs.add(candidate);
      }
    }

    for (const ref of Array.isArray(provenance.source_record_ids) ? provenance.source_record_ids : []) {
      const candidate = extractString(ref);
      if (candidate) {
        provenanceRefs.add(candidate);
      }
    }
  }

  return {
    historical_evidence: historicalRefs,
    pattern_evidence: patternRefs,
    memory_evidence: memoryRefs,
    conversation_context: conversationRefs,
    event_context_facts: eventRefs,
    provenance: provenanceRefs,
  };
}

function pairKey(left: string, right: string): string {
  return `${left}↔${right}`;
}

function buildPairwiseOverlapSummary(refSets: Record<string, Set<string>>): Record<string, { shared_ref_count: number }> {
  const sections = Object.keys(refSets);
  const result: Record<string, { shared_ref_count: number }> = {};

  for (let i = 0; i < sections.length; i += 1) {
    for (let j = i + 1; j < sections.length; j += 1) {
      const left = sections[i];
      const right = sections[j];
      const overlap = [...refSets[left]].filter((ref) => refSets[right].has(ref)).length;
      result[pairKey(left, right)] = { shared_ref_count: overlap };
    }
  }

  return result;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const executionResult = await pool.query<AiExecutionRow>(`
      SELECT
        id::text,
        task_identity,
        task_id,
        task_type,
        status,
        started_at::text,
        completed_at::text,
        provider_latency_ms,
        input_tokens,
        output_tokens,
        total_tokens,
        cached_input_tokens,
        reasoning_tokens,
        input_fingerprint,
        serialized_input_bytes,
        context_package_id::text,
        context_package_version,
        context_package_hash,
        estimated_cost,
        cost_currency,
        pricing_version,
        context_package_usage,
        created_at::text,
        updated_at::text
      FROM ai_executions
      ORDER BY created_at ASC, id ASC
    `);

    const attemptResult = await pool.query<AiAttemptRow>(`
      SELECT
        id::text,
        ai_execution_id::text,
        attempt_number,
        provider,
        model,
        model_fingerprint,
        input_fingerprint,
        started_at::text,
        completed_at::text,
        provider_latency_ms,
        status,
        error_type,
        error_code,
        input_tokens,
        output_tokens,
        total_tokens,
        cached_input_tokens,
        reasoning_tokens,
        estimated_cost,
        cost_currency,
        pricing_version,
        created_at::text
      FROM ai_execution_attempts
      ORDER BY created_at ASC, id ASC
    `);

    const executions = executionResult.rows;
    const attempts = attemptResult.rows;
    const contextPackageRows: ContextPackageRow[] = executions.length > 0
      ? (await pool.query<ContextPackageRow>(`
          SELECT cp.id::text, cp.package_version, cp.content_hash, cp.payload
          FROM context_packages cp
          WHERE EXISTS (
            SELECT 1
            FROM ai_executions ae
            WHERE ae.context_package_hash = cp.content_hash
          )
          ORDER BY cp.created_at ASC, cp.id ASC
        `)).rows
      : [];

    const executionById = new Map(executions.map((row) => [row.id, row]));
    const attemptsByExecutionId = new Map<string, AiAttemptRow[]>();
    for (const attempt of attempts) {
      const list = attemptsByExecutionId.get(attempt.ai_execution_id) ?? [];
      list.push(attempt);
      attemptsByExecutionId.set(attempt.ai_execution_id, list);
    }

    const executionAttemptCounts = executions.map((execution) => attemptsByExecutionId.get(execution.id)?.length ?? 0);
    const executionStatuses = executions.reduce<Record<string, number>>((accumulator, execution) => {
      accumulator[execution.status] = (accumulator[execution.status] ?? 0) + 1;
      return accumulator;
    }, {});
    const attemptStatuses = attempts.reduce<Record<string, number>>((accumulator, attempt) => {
      accumulator[attempt.status] = (accumulator[attempt.status] ?? 0) + 1;
      return accumulator;
    }, {});

    const executionInputTokens = executions.map((row) => toNumber(row.input_tokens));
    const executionOutputTokens = executions.map((row) => toNumber(row.output_tokens));
    const executionTotalTokens = executions.map((row) => toNumber(row.total_tokens));
    const executionCachedInputTokens = executions.map((row) => toNumber(row.cached_input_tokens));
    const executionReasoningTokens = executions.map((row) => toNumber(row.reasoning_tokens));
    const executionLatencies = executions.map((row) => toNumber(row.provider_latency_ms));
    const executionCosts = executions.map((row) => toNumber(row.estimated_cost));

    const attemptInputTokens = attempts.map((row) => toNumber(row.input_tokens));
    const attemptOutputTokens = attempts.map((row) => toNumber(row.output_tokens));
    const attemptTotalTokens = attempts.map((row) => toNumber(row.total_tokens));
    const attemptCachedInputTokens = attempts.map((row) => toNumber(row.cached_input_tokens));
    const attemptReasoningTokens = attempts.map((row) => toNumber(row.reasoning_tokens));
    const attemptLatencies = attempts.map((row) => toNumber(row.provider_latency_ms));
    const attemptCosts = attempts.map((row) => toNumber(row.estimated_cost));

    const contextPackageSectionRows: Array<{
      execution_id: string;
      section_name: string;
      bytes: number;
      total_bytes: number;
      share: number;
    }> = [];

    for (const execution of executions) {
      const packageUsage = execution.context_package_usage;
      const totalBytes = toNumber(packageUsage?.total_serialized_bytes) ?? 0;
      const sections = Array.isArray(packageUsage?.sections) ? packageUsage.sections : [];

      for (const section of sections) {
        const bytes = readSectionBytes(section);
        if (bytes === null) {
          continue;
        }

        contextPackageSectionRows.push({
          execution_id: execution.id,
          section_name: section.section_name,
          bytes,
          total_bytes: totalBytes,
          share: totalBytes > 0 ? bytes / totalBytes : 0,
        });
      }
    }

    const totalContextPackageBytes = sum(contextPackageSectionRows.map((row) => row.total_bytes));
    const totalSectionBytes = sum(contextPackageSectionRows.map((row) => row.bytes));

    const sectionStats: SectionStats[] = REQUIRED_SECTIONS.map((sectionName) => {
      const rows = contextPackageSectionRows.filter((row) => row.section_name === sectionName);
      const bytes = rows.map((row) => row.bytes);
      const shares = rows.map((row) => row.share);
      const totalBytes = sum(bytes);

      return {
        section_name: sectionName,
        execution_count: new Set(rows.map((row) => row.execution_id)).size,
        average_bytes: bytes.length > 0 ? totalBytes / bytes.length : null,
        median_bytes: percentile([...bytes].sort((left, right) => left - right), 0.5),
        p95_bytes: percentile([...bytes].sort((left, right) => left - right), 0.95),
        total_bytes: bytes.length > 0 ? totalBytes : null,
        percentage_of_total_context_bytes: totalContextPackageBytes > 0 ? percent(totalBytes, totalContextPackageBytes) : null,
        average_share: shares.length > 0 ? sum(shares) / shares.length : null,
        median_share: percentile([...shares].sort((left, right) => left - right), 0.5),
        p95_share: percentile([...shares].sort((left, right) => left - right), 0.95),
      };
    });

    const duplicationSummary = contextPackageRows.map((contextPackage) => {
      const refSets = buildSectionRefSets(contextPackage.payload);
      const pairwise = buildPairwiseOverlapSummary(refSets);

      return {
        context_package_id: contextPackage.id,
        context_package_version: contextPackage.package_version,
        context_package_hash: contextPackage.content_hash,
        ref_counts: {
          historical_evidence: refSets.historical_evidence.size,
          pattern_evidence: refSets.pattern_evidence.size,
          memory_evidence: refSets.memory_evidence.size,
          conversation_context: refSets.conversation_context.size,
          event_context_facts: refSets.event_context_facts.size,
          provenance: refSets.provenance.size,
        },
        pairwise_overlaps: pairwise,
      };
    });

    const pairwiseAggregate = duplicationSummary.reduce<Record<string, { executions_with_overlap: number; shared_ref_count: number }>>((accumulator, item) => {
      for (const [pair, value] of Object.entries(item.pairwise_overlaps)) {
        const existing = accumulator[pair] ?? { executions_with_overlap: 0, shared_ref_count: 0 };
        accumulator[pair] = {
          executions_with_overlap: existing.executions_with_overlap + (value.shared_ref_count > 0 ? 1 : 0),
          shared_ref_count: existing.shared_ref_count + value.shared_ref_count,
        };
      }

      return accumulator;
    }, {});

    const groupSummaries = [
      {
        key: 'single_attempt',
        executionRows: executions.filter((execution) => (attemptsByExecutionId.get(execution.id)?.length ?? 0) === 1),
      },
      {
        key: 'multi_attempt',
        executionRows: executions.filter((execution) => (attemptsByExecutionId.get(execution.id)?.length ?? 0) > 1),
      },
    ].map(({ key, executionRows }) => {
      const statusCounts = executionRows.reduce<Record<string, number>>((accumulator, execution) => {
        accumulator[execution.status] = (accumulator[execution.status] ?? 0) + 1;
        return accumulator;
      }, {});

      const values = {
        input_tokens: executionRows.map((row) => toNumber(row.input_tokens)),
        output_tokens: executionRows.map((row) => toNumber(row.output_tokens)),
        total_tokens: executionRows.map((row) => toNumber(row.total_tokens)),
        cached_input_tokens: executionRows.map((row) => toNumber(row.cached_input_tokens)),
        reasoning_tokens: executionRows.map((row) => toNumber(row.reasoning_tokens)),
        estimated_cost: executionRows.map((row) => toNumber(row.estimated_cost)),
        provider_latency_ms: executionRows.map((row) => toNumber(row.provider_latency_ms)),
      };

      return {
        key,
        execution_count: executionRows.length,
        status_counts: statusCounts,
        success_rate: executionRows.length > 0 ? (statusCounts.succeeded ?? 0) / executionRows.length : null,
        attempts_per_execution: executionRows.length > 0 ? sum(executionRows.map((row) => attemptsByExecutionId.get(row.id)?.length ?? 0)) / executionRows.length : null,
        input_tokens: buildNumericStats(values.input_tokens),
        output_tokens: buildNumericStats(values.output_tokens),
        total_tokens: buildNumericStats(values.total_tokens),
        cached_input_tokens: buildNumericStats(values.cached_input_tokens),
        reasoning_tokens: buildNumericStats(values.reasoning_tokens),
        estimated_cost: buildNumericStats(values.estimated_cost),
        provider_latency_ms: buildNumericStats(values.provider_latency_ms),
      } as AttemptGroupStats & { key: string; status_counts: Record<string, number> };
    });

    const outlierSorters: Record<string, Array<{ row: AiExecutionRow; value: number }>> = {
      input_tokens: executions
        .map((row) => ({ row, value: toNumber(row.input_tokens) }))
        .filter((entry): entry is { row: AiExecutionRow; value: number } => entry.value !== null)
        .sort((left, right) => right.value - left.value),
      total_tokens: executions
        .map((row) => ({ row, value: toNumber(row.total_tokens) }))
        .filter((entry): entry is { row: AiExecutionRow; value: number } => entry.value !== null)
        .sort((left, right) => right.value - left.value),
      context_package_bytes: executions
        .map((row) => ({ row, value: toNumber(row.context_package_usage?.total_serialized_bytes) ?? toNumber(row.serialized_input_bytes) ?? 0 }))
        .sort((left, right) => right.value - left.value),
      estimated_cost: executions
        .map((row) => ({ row, value: toNumber(row.estimated_cost) }))
        .filter((entry): entry is { row: AiExecutionRow; value: number } => entry.value !== null)
        .sort((left, right) => right.value - left.value),
      latency_ms: executions
        .map((row) => ({ row, value: toNumber(row.provider_latency_ms) }))
        .filter((entry): entry is { row: AiExecutionRow; value: number } => entry.value !== null)
        .sort((left, right) => right.value - left.value),
    };

    const outliers: Record<string, OutlierEntry[]> = {};
    for (const [metric, rows] of Object.entries(outlierSorters)) {
      outliers[metric] = rows.slice(0, 5).map(({ row, value }) => ({
        task_identity: row.task_identity,
        context_package_id: row.context_package_id,
        context_package_version: row.context_package_version,
        context_package_hash: row.context_package_hash,
        value,
        status: row.status,
      }));
    }

    const report = {
      generated_at: new Date().toISOString(),
      database_url_source: process.env.DATABASE_URL ? 'DATABASE_URL' : 'default-local',
      data_volume: {
        ai_executions: executions.length,
        ai_execution_attempts: attempts.length,
        context_packages: contextPackageRows.length,
        executions_with_context_package_usage: executions.filter((row) => Boolean(row.context_package_usage)).length,
        executions_with_cost: executions.filter((row) => toNumber(row.estimated_cost) !== null).length,
        attempts_with_cost: attempts.filter((row) => toNumber(row.estimated_cost) !== null).length,
      },
      execution_overview: {
        logical_executions: executions.length,
        provider_attempts: attempts.length,
        attempts_per_execution: buildNumericStats(executionAttemptCounts),
        execution_status_counts: executionStatuses,
        attempt_status_counts: attemptStatuses,
        executions_with_multiple_attempts: executionAttemptCounts.filter((count) => count > 1).length,
        success_rate: executions.length > 0 ? (executionStatuses.succeeded ?? 0) / executions.length : null,
      },
      token_stats: {
        executions: {
          input_tokens: buildNumericStats(executionInputTokens),
          output_tokens: buildNumericStats(executionOutputTokens),
          total_tokens: buildNumericStats(executionTotalTokens),
          cached_input_tokens: buildNumericStats(executionCachedInputTokens),
          reasoning_tokens: buildNumericStats(executionReasoningTokens),
        },
        attempts: {
          input_tokens: buildNumericStats(attemptInputTokens),
          output_tokens: buildNumericStats(attemptOutputTokens),
          total_tokens: buildNumericStats(attemptTotalTokens),
          cached_input_tokens: buildNumericStats(attemptCachedInputTokens),
          reasoning_tokens: buildNumericStats(attemptReasoningTokens),
        },
      },
      cost_stats: {
        executions: {
          known_count: executionCosts.filter((value) => value !== null).length,
          unknown_count: executionCosts.filter((value) => value === null).length,
          total_known_cost: buildNumericStats(executionCosts).total,
          average_known_cost: buildNumericStats(executionCosts).average,
          median_known_cost: buildNumericStats(executionCosts).median,
          p95_known_cost: buildNumericStats(executionCosts).p95,
        },
        attempts: {
          known_count: attemptCosts.filter((value) => value !== null).length,
          unknown_count: attemptCosts.filter((value) => value === null).length,
          total_known_cost: buildNumericStats(attemptCosts).total,
          average_known_cost: buildNumericStats(attemptCosts).average,
          median_known_cost: buildNumericStats(attemptCosts).median,
          p95_known_cost: buildNumericStats(attemptCosts).p95,
        },
      },
      latency_stats: {
        executions: buildNumericStats(executionLatencies),
        attempts: buildNumericStats(attemptLatencies),
      },
      context_package_sections: sectionStats,
      duplication: {
        per_context_package: duplicationSummary,
        pairwise_aggregate: pairwiseAggregate,
      },
      outliers,
      attempt_groups: groupSummaries,
    };

    console.log('ANALYSIS_JSON_BEGIN');
    console.log(safeJson(report));
    console.log('ANALYSIS_JSON_END');
    console.log('');
    console.log('OBSERVED DATA');
    console.log(`Logical executions: ${report.execution_overview.logical_executions}`);
    console.log(`Provider attempts: ${report.execution_overview.provider_attempts}`);
    console.log(`Executions with multiple attempts: ${report.execution_overview.executions_with_multiple_attempts}`);
    console.log(`Executions with known cost: ${report.cost_stats.executions.known_count}`);
    console.log(`Attempts with known cost: ${report.cost_stats.attempts.known_count}`);
    console.log(`Executions with context_package_usage: ${report.data_volume.executions_with_context_package_usage}`);
    console.log('');
    console.log('INTERPRETATION');
    if (executions.length === 0) {
      console.log('No AI executions were present in the current database snapshot, so no aggregate interpretation is possible.');
    } else {
      console.log('The report is a direct aggregation of persisted ai_executions, ai_execution_attempts, and context_packages rows.');
      console.log('NULL cost remains unknown and is excluded from cost averages and totals.');
      console.log('Section share statistics are computed from persisted context_package_usage byte accounting only.');
      console.log('Duplication results are structural overlap counts based on shared stored references, not semantic similarity.');
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`AI cost/token analysis failed: ${message}`);
  process.exitCode = 1;
});