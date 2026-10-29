import { describeErrorSafely as describeEvaluationErrorSafely } from '../../evaluation/evaluation-output-dir';
import { ReconstructionArgumentError, type TimeRangeExecutionIdentifiers } from './reconstruction-cli';

/**
 * Pure report builders for the scripts/reconstruction-*.ts tools. Every figure is taken from the selected execution
 * and its related rows and labelled with where it came from:
 *   stored      - read verbatim from a database column,
 *   calculated  - computed here from stored values (the method is named),
 *   unavailable - not stored, or not well-defined; never replaced by a guess.
 * Statements that were only observed during the 2026-10-09 investigation are labelled as such and never presented
 * as measurements of the selected execution.
 */

export type ReportedValue =
  | { status: 'stored'; value: string | number; source: string }
  | { status: 'calculated'; value: string | number; method: string }
  | { status: 'unavailable'; reason: string };

export const HISTORICAL_LABEL = 'Historical observation from the 2026-10-09 investigation (not re-verified for this execution)';

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;
}

/** Finite number from a number or numeric string (pg returns bigint and numeric columns as strings). */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function asTimestamp(value: unknown): Date | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stored(value: unknown, source: string, missing = `${source} is not set`): ReportedValue {
  if (typeof value === 'number' && Number.isFinite(value)) return { status: 'stored', value, source };
  if (typeof value === 'string' && value.trim()) return { status: 'stored', value, source };
  const date = value instanceof Date ? asTimestamp(value) : null;
  if (date) return { status: 'stored', value: date.toISOString(), source };
  return { status: 'unavailable', reason: missing };
}

function storedNumber(value: unknown, source: string): ReportedValue {
  const number = asNumber(value);
  return number === null ? { status: 'unavailable', reason: `${source} is not set` } : { status: 'stored', value: number, source };
}

export function renderValue(value: ReportedValue): string {
  switch (value.status) {
    case 'stored':
      return `${value.value} (stored: ${value.source})`;
    case 'calculated':
      return `${value.value} (calculated: ${value.method})`;
    case 'unavailable':
      return `unavailable (${value.reason})`;
  }
}

function percent(part: number, total: number): string {
  return `${((part / total) * 100).toFixed(1)}%`;
}

export interface SectionFigure {
  name: string;
  bytes: ReportedValue;
  share: ReportedValue;
}

export interface ExecutionFigures {
  inputTokens: ReportedValue;
  outputTokens: ReportedValue;
  serializedInputBytes: ReportedValue;
  contextPackageBytes: ReportedValue;
  sections: SectionFigure[];
  analyticalEvidence: SectionFigure;
  historicalEvidence: SectionFigure;
  estimatedCost: ReportedValue;
  costSplit: ReportedValue;
  duration: ReportedValue;
  delivery: Array<[string, ReportedValue]>;
  bytesSavedByDelivery: ReportedValue;
  timezone: ReportedValue;
}

const DELIVERY_FIELDS = [
  'delivery_mode_used',
  'compact_build_status',
  'full_input_tokens',
  'compact_input_tokens',
  'byte_reduction_pct',
  'full_serialized_input_bytes',
  'compact_serialized_input_bytes',
] as const;

/** Figures for one execution, from its ai_executions row only. */
export function computeExecutionFigures(execution: Row): ExecutionFigures {
  const usage = asRecord(execution.context_package_usage);
  const rawSections = Array.isArray(usage?.sections) ? (usage.sections as unknown[]).map(asRecord).filter((section): section is Row => section !== null) : [];

  let contextPackageBytes: ReportedValue;
  const storedTotal = asNumber(usage?.total_serialized_bytes);
  const sectionBytes = rawSections.map((section) => asNumber(section.serialized_bytes));
  if (storedTotal !== null) {
    contextPackageBytes = { status: 'stored', value: storedTotal, source: 'ai_executions.context_package_usage.total_serialized_bytes' };
  } else if (rawSections.length > 0 && sectionBytes.every((bytes) => bytes !== null)) {
    contextPackageBytes = { status: 'calculated', value: sectionBytes.reduce<number>((sum, bytes) => sum + (bytes as number), 0), method: 'sum of context_package_usage.sections' };
  } else {
    contextPackageBytes = { status: 'unavailable', reason: 'context_package_usage has no section sizes' };
  }
  const total = contextPackageBytes.status === 'unavailable' ? null : Number(contextPackageBytes.value);

  const toFigure = (name: string, section: Row | undefined): SectionFigure => {
    if (!section) {
      const reason = `section ${name} is not recorded in context_package_usage`;
      return { name, bytes: { status: 'unavailable', reason }, share: { status: 'unavailable', reason } };
    }
    const bytes = asNumber(section.serialized_bytes);
    if (bytes === null) {
      const reason = `serialized_bytes of section ${name} is not set`;
      return { name, bytes: { status: 'unavailable', reason }, share: { status: 'unavailable', reason } };
    }
    return {
      name,
      bytes: { status: 'stored', value: bytes, source: 'ai_executions.context_package_usage.sections' },
      share: total && total > 0
        ? { status: 'calculated', value: percent(bytes, total), method: 'section bytes / context package bytes' }
        : { status: 'unavailable', reason: 'context package size is unknown' },
    };
  };
  const sections = rawSections.map((section) => toFigure(String(section.section_name ?? 'unnamed'), section));
  const findSection = (name: string) => rawSections.find((section) => section.section_name === name);

  const started = asTimestamp(execution.started_at);
  const completed = asTimestamp(execution.completed_at);
  const duration: ReportedValue = started && completed && completed >= started
    ? { status: 'calculated', value: `${completed.getTime() - started.getTime()} ms`, method: 'completed_at - started_at' }
    : { status: 'unavailable', reason: 'started_at or completed_at is not set' };

  const cost = asNumber(execution.estimated_cost);
  const currency = typeof execution.cost_currency === 'string' && execution.cost_currency.trim() ? execution.cost_currency.trim() : null;
  const pricing = typeof execution.pricing_version === 'string' && execution.pricing_version.trim() ? execution.pricing_version.trim() : null;
  const estimatedCost: ReportedValue = cost === null
    ? { status: 'unavailable', reason: 'ai_executions.estimated_cost is not set (no pricing configured for this execution)' }
    : { status: 'stored', value: `${cost} ${currency ?? '(currency not stored)'}${pricing ? `, pricing ${pricing}` : ''}`, source: 'ai_executions.estimated_cost, cost_currency, pricing_version' };

  const delivery = asRecord(usage?.delivery);
  const deliveryFigures = DELIVERY_FIELDS.map((field): [string, ReportedValue] => [
    field,
    delivery ? stored(delivery[field], `context_package_usage.delivery.${field}`) : { status: 'unavailable', reason: 'context_package_usage.delivery is not recorded' },
  ]);
  const fullBytes = asNumber(delivery?.full_serialized_input_bytes);
  const compactBytes = asNumber(delivery?.compact_serialized_input_bytes);
  const bytesSavedByDelivery: ReportedValue = fullBytes !== null && compactBytes !== null
    ? { status: 'calculated', value: fullBytes - compactBytes, method: 'full_serialized_input_bytes - compact_serialized_input_bytes' }
    : { status: 'unavailable', reason: 'full or compact delivery size is not recorded' };

  return {
    inputTokens: storedNumber(execution.input_tokens, 'ai_executions.input_tokens'),
    outputTokens: storedNumber(execution.output_tokens, 'ai_executions.output_tokens'),
    serializedInputBytes: storedNumber(execution.serialized_input_bytes, 'ai_executions.serialized_input_bytes'),
    contextPackageBytes,
    sections,
    analyticalEvidence: toFigure('analytical_evidence', findSection('analytical_evidence')),
    historicalEvidence: toFigure('historical_evidence', findSection('historical_evidence')),
    estimatedCost,
    costSplit: { status: 'unavailable', reason: 'ai_executions stores only the total estimate, not input/output costs' },
    duration,
    delivery: deliveryFigures,
    bytesSavedByDelivery,
    timezone: { status: 'unavailable', reason: 'the request timezone is not stored on ai_executions; this tool does not read the context package payload' },
  };
}

/** glucose_min/max/avg over numeric readings only (missing values are skipped, not counted as 0 or 999). */
export function glucoseSummary(values: unknown[]): { glucose_min: number | null; glucose_max: number | null; glucose_avg: string | null } {
  const readings = values.map(asNumber).filter((value): value is number => value !== null);
  if (readings.length === 0) return { glucose_min: null, glucose_max: null, glucose_avg: null };
  return {
    glucose_min: Math.min(...readings),
    glucose_max: Math.max(...readings),
    glucose_avg: (readings.reduce((sum, value) => sum + value, 0) / readings.length).toFixed(1),
  };
}

function text(value: unknown): string {
  return value === null || value === undefined ? 'not set' : String(value);
}

function hashLine(label: string, value: unknown): string {
  return `${label.padEnd(23)}${typeof value === 'string' && value.trim() ? value : 'unavailable (not set)'}\n`;
}

export interface FinalReportInput {
  executionId: string;
  outputDir: string;
  execution: Row;
  identifiers: TimeRangeExecutionIdentifiers;
  message: Row;
  conversation: Row | undefined;
  conversationMessages: Row[];
  job: Row | undefined;
}

/** FINAL_RECONSTRUCTION_REPORT.md. Contains patient data (question and message excerpts): write it only through the guard. */
export function buildFinalReconstructionReport(input: FinalReportInput): string {
  const { execution: exec, identifiers, message, conversation } = input;
  const figures = computeExecutionFigures(exec);
  const recent = input.conversationMessages.slice(-12);
  let report = '';

  report += `# RECONSTRUCTION REPORT: ${text(exec.task_type)}\n\n`;
  report += `**Execution ID**: \`${input.executionId}\`\n`;
  report += `**User Question**: "${text(message.content)}"\n`;
  report += `**Timestamp**: ${text(message.created_at)}\n`;
  report += `**Status**: Partial reconstruction. This tool does not rebuild analytical evidence.\n\n`;
  report += `Values are labelled *stored* (read from a column), *calculated* (computed from stored values) or *unavailable*.\n\n`;

  report += `## 1. EXECUTION METRICS\n\n| Metric | Value |\n|--------|-------|\n`;
  report += `| Task Type | ${text(exec.task_type)} |\n| Task Version | ${text(exec.task_version)} |\n| Prompt Version | ${text(exec.prompt_version)} |\n`;
  report += `| Model | ${text(exec.model)} |\n| Provider | ${text(exec.provider)} |\n| Status | ${text(exec.status)} |\n`;
  report += `| Input Tokens | ${renderValue(figures.inputTokens)} |\n| Output Tokens | ${renderValue(figures.outputTokens)} |\n`;
  report += `| Serialized Input Bytes | ${renderValue(figures.serializedInputBytes)} |\n| Duration | ${renderValue(figures.duration)} |\n`;
  report += `| Estimated Cost | ${renderValue(figures.estimatedCost)} |\n| Input/Output Cost Split | ${renderValue(figures.costSplit)} |\n\n`;

  report += `## 2. FINGERPRINTS, HASHES & CHECKSUMS\n\n\`\`\`\n`;
  report += hashLine('Input Fingerprint:', exec.input_fingerprint);
  report += hashLine('Input Hash (Canonical):', exec.input_hash);
  report += hashLine('Context Package Hash:', exec.context_package_hash);
  report += hashLine('Task Identity:', exec.task_identity);
  report += hashLine('Model Fingerprint:', exec.model_fingerprint);
  report += `\`\`\`\n\n**Note**: These stored hashes are what a reconstructed request would have to match.\n\n`;

  report += `## 3. REQUEST STRUCTURE BREAKDOWN\n\n### Context package: ${renderValue(figures.contextPackageBytes)}\n\n`;
  if (figures.sections.length > 0) {
    report += `| Section | Bytes | Share | Rebuilt by this tool |\n|---------|-------|-------|----------------------|\n`;
    for (const section of figures.sections) {
      report += `| ${section.name} | ${renderValue(section.bytes)} | ${renderValue(section.share)} | ${section.name === 'analytical_evidence' ? 'no' : 'not verified'} |\n`;
    }
  } else {
    report += `Section sizes: unavailable (context_package_usage has no sections).\n`;
  }
  report += `\n### Delivery telemetry\n\n\`\`\`\n`;
  for (const [field, value] of figures.delivery) report += `${field}: ${renderValue(value)}\n`;
  report += `bytes_saved: ${renderValue(figures.bytesSavedByDelivery)}\n\`\`\`\n\n`;

  report += `## 4. RECONSTRUCTED REQUEST COMPONENTS\n\n### 4.1 System Instructions\n\n`;
  report += `Built by \`buildTimeRangeAnalysisSystemInstructions()\` in \`modules/ai-gateway/application/time-range-analysis-prompt.ts\`; `;
  report += `the execution used prompt version ${text(exec.prompt_version)}. Compare against that version of the source; this report does not reproduce the instructions.\n\n`;

  report += `### 4.2 Analysis Request Input\n\n\`\`\`json\n{\n`;
  report += `  "user_message_id": "${identifiers.messageId}",\n`;
  report += `  "user_message_text": "${text(message.content)}",\n`;
  report += `  "range_type": "${identifiers.rangeType}",\n`;
  report += `  "timezone": null,\n`;
  report += `  "range_start": "${identifiers.rangeStart}",\n`;
  report += `  "range_end": "${identifiers.rangeEnd}",\n`;
  report += `  "requested_at": "${text(message.created_at)}"\n}\n\`\`\`\n\n`;
  report += `- Message ID, range type, range start and range end: calculated from ai_executions.task_id (cross-checked with correlation_id and context_package_id).\n`;
  report += `- requested_at: stored messages.created_at of the user message.\n`;
  report += `- timezone: ${renderValue(figures.timezone)}.\n\n`;

  report += `### 4.3 Conversation Context\n\n`;
  report += `**Messages in conversation**: ${input.conversationMessages.length} (stored rows)\n`;
  report += `**Most recent messages shown (up to 12)**: ${recent.length}\n\n\`\`\`json\n{\n`;
  report += `  "thread_id": "${identifiers.conversationId}",\n`;
  report += `  "thread_state_version": "${text(conversation?.thread_state_version)}",\n`;
  report += `  "awaiting_user_answer": ${conversation ? text(conversation.awaiting_user_answer) : 'null'},\n  "messages": [\n`;
  recent.forEach((item, index) => {
    report += `    {\n      "role": "${text(item.role)}",\n      "content": "${String(item.content ?? '').substring(0, 50)}...",\n      "created_at": "${text(item.created_at)}"\n    }${index < recent.length - 1 ? ',' : ''}\n`;
  });
  report += `  ]\n}\n\`\`\`\n\n`;

  report += `### 4.4 Analytical Evidence (not rebuilt)\n\n`;
  report += `Size: ${renderValue(figures.analyticalEvidence.bytes)}; share of context package: ${renderValue(figures.analyticalEvidence.share)}.\n\n`;
  report += `Historical evidence size: ${renderValue(figures.historicalEvidence.bytes)}; share: ${renderValue(figures.historicalEvidence.share)}.\n\n`;
  report += `${HISTORICAL_LABEL}:\n`;
  report += `- raw event payloads were not stored in ai_executions;\n`;
  report += `- the context_packages row could not be looked up by ai_executions.context_package_id (a composite string, not the table's UUID key);\n`;
  report += `- the exact serialization existed only in memory during the execution;\n`;
  report += `- the raw provider request body was not persisted (only the normalized result).\n\n`;

  report += `## 5. SOURCES OF THE RECONSTRUCTED PARTS\n\n`;
  report += `| Part | Source | Verified against the original request |\n|------|--------|---------------------------------------|\n`;
  report += `| User message and timestamp | messages row ${input.message ? 'found' : 'not found'} | no |\n`;
  report += `| Conversation context | ${input.conversationMessages.length} messages rows | no |\n`;
  report += `| Range and request identifiers | ai_executions.task_id | no |\n`;
  report += `| Job | jobs row ${input.job ? `found (type ${text(input.job.job_type)})` : 'not found'} | no |\n`;
  report += `| Hashes and fingerprints | ai_executions | stored values only |\n`;
  report += `| Analytical and historical evidence | not rebuilt | no |\n\n`;
  report += `Nothing in this report has been matched against the original request: a fingerprint match would require the analytical evidence.\n\n`;

  report += `## 6. MOCK SIMULATION NOTES\n\n${HISTORICAL_LABEL}:\n`;
  report += `- the request structure could be rebuilt from database rows and code and run against the mock provider without an API call;\n`;
  report += `- the analytical evidence and the input fingerprint could not be verified that way;\n`;
  report += `- a mock response would be the stored normalized_result, not a live model answer.\n\n`;

  report += `## 7. ARTIFACTS\n\nOutput directory: \`${input.outputDir}\`\n\n`;
  report += `1. **reconstructed-context.json** - written by reconstruction-stage-2-build (if it was run with this directory)\n`;
  report += `2. **reconstruction-analysis.txt** - written by reconstruction-stage-2b-analysis (if it was run with this directory)\n`;
  report += `3. **FINAL_RECONSTRUCTION_REPORT.md** - this report\n\n`;

  report += `## 8. CONCLUSION\n\n### Reconstruction status: PARTIAL\n\n**Available from stored records** (not verified against the original request):\n`;
  report += `- the user question and its timestamp (messages)\n`;
  report += `- the analysed range ${identifiers.rangeStart} to ${identifiers.rangeEnd} (UTC, from task_id); timezone unavailable\n`;
  report += `- the conversation messages (messages)\n`;
  report += `- task parameters, versions, hashes and fingerprints (ai_executions)\n`;
  report += `- estimated cost: ${renderValue(figures.estimatedCost)}\n\n`;
  report += `**Not available** without the full context package: the exact glucose, insulin and meal events, the historical case references, and a byte-for-byte fingerprint match.\n\n`;
  report += `### Safe experimentation\n\n- Use the mock provider; do not call the OpenAI API (it incurs cost).\n- Compare a mock run with the stored normalized_result.\n`;
  return report;
}

/** reconstruction-analysis.txt for stage 2b. Contains no patient text, only stored metadata and calculated figures. */
export function buildReconstructionAnalysis(executionId: string, execution: Row): string {
  const figures = computeExecutionFigures(execution);
  const lines = [
    `RECONSTRUCTION ANALYSIS FOR EXECUTION: ${executionId}`,
    '',
    'Values are labelled stored (read from a column), calculated (computed from stored values) or unavailable.',
    '',
    'EXECUTION METRICS:',
    `- Task Type: ${text(execution.task_type)} (stored)`,
    `- Prompt Version: ${text(execution.prompt_version)} (stored)`,
    `- Output Schema Version: ${text(execution.output_schema_version)} (stored)`,
    `- Input Tokens: ${renderValue(figures.inputTokens)}`,
    `- Output Tokens: ${renderValue(figures.outputTokens)}`,
    `- Serialized Input Bytes: ${renderValue(figures.serializedInputBytes)}`,
    `- Input Fingerprint: ${text(execution.input_fingerprint)} (stored)`,
    `- Input Hash: ${text(execution.input_hash)} (stored)`,
    `- Estimated Cost: ${renderValue(figures.estimatedCost)}`,
    '',
    `SECTION BREAKDOWN (context package: ${renderValue(figures.contextPackageBytes)}):`,
    ...(figures.sections.length > 0
      ? figures.sections.map((section) => `  - ${section.name}: ${renderValue(section.bytes)}, share ${renderValue(section.share)}`)
      : ['  unavailable (context_package_usage has no sections)']),
    '',
    'DELIVERY TELEMETRY:',
    ...figures.delivery.map(([field, value]) => `  - ${field}: ${renderValue(value)}`),
    '',
    'RECONSTRUCTION STATUS:',
    '- System instructions: can be rebuilt from the prompt builder for the stored prompt version (not verified)',
    '- User payload: structure can be rebuilt from database rows (not verified)',
    `- Analytical evidence: not rebuilt; size ${renderValue(figures.analyticalEvidence.bytes)}`,
    `- Historical evidence: not rebuilt; size ${renderValue(figures.historicalEvidence.bytes)}`,
    '- Fingerprint verification: not possible without the analytical evidence',
    `- context_package_id ${UUID_SHAPE.test(String(execution.context_package_id ?? '')) ? 'is' : 'is not'} UUID-shaped (calculated); context_packages rows are keyed by UUID`,
    '',
    `${HISTORICAL_LABEL}:`,
    '- the raw request body sent to the provider was not persisted, only the normalized result;',
    '- a mock simulation with the reconstructed system instructions was the recommended next step.',
    '',
  ];
  return lines.join('\n');
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_TOKEN = /^[A-Za-z0-9._:+\- ]{1,100}$/;

/** Scalar safe to print: short, plain tokens only. Anything else (free text, JSON, long values) is withheld. */
function safeScalar(value: unknown): string {
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'withheld';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'withheld' : value.toISOString();
  if (typeof value === 'string' && SAFE_TOKEN.test(value)) return value;
  return 'withheld';
}

/** Allowlisted ai_executions columns printed to stdout. Identifiers, hashes, results, errors and usage JSON are never printed. */
export const STDOUT_EXECUTION_FIELDS = [
  'task_type',
  'task_version',
  'prompt_version',
  'output_schema_version',
  'model_policy_version',
  'provider',
  'model',
  'status',
  'created_at',
  'started_at',
  'completed_at',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'serialized_input_bytes',
] as const;

/** Minimal stdout summary that confirms which execution was selected without exposing patient data. */
export function summarizeExecutionForStdout(execution: Row | undefined): string[] {
  if (!execution) return ['Execution: not found'];
  const usage = asRecord(execution.context_package_usage);
  return [
    'Execution: found',
    ...STDOUT_EXECUTION_FIELDS.map((field) => `  ${field}: ${safeScalar(execution[field])}`),
    `  context_package_usage: ${usage ? `present (${Array.isArray(usage.sections) ? usage.sections.length : 0} sections)` : 'absent'}`,
    `  normalized_result: ${execution.normalized_result ? 'present' : 'absent'}`,
    `  error: ${execution.error ? 'present' : 'absent'}`,
  ];
}

/** describeErrorSafely from the output-dir module, also trusting ReconstructionArgumentError (written to exclude values). */
export function describeErrorSafely(error: unknown): string {
  return describeEvaluationErrorSafely(error, [ReconstructionArgumentError]);
}
