import type { EvidenceToolName } from '@modules/evidence-tools';

/**
 * Model-facing copy of time-range evidence: drops what the model cannot act on or cite, nothing else. The evidence
 * tools take only time ranges and the output schema has no reference fields, so opaque record ids, ref digests
 * (sha256/first/last id), content hashes and version labels only cost input tokens. Applied at the provider
 * boundary; the stored context package, the evidence session audit and the provenance computed from the full
 * results are unchanged. Audit 2026-10-18: −797 tokens on a one-day question, −4,174 on a seven-day one.
 */

/** Opaque ids, hashes and derivation labels: dropped wherever they appear in the evidence. */
const DROPPED_KEYS = new Set([
  'provenance_ref',
  'source_record_id',
  'source_boundary_refs',
  'protected_event_refs',
  'content_hash',
  'source_refs',
  'source_refs_sha256',
  'derivation_policy_version',
  'selection_policy_version',
  'evidence_view_version',
  // Record ids the tools never take (they take time ranges): audit 2026-10-26.
  'event_id',
]);

/** Flags whose false (or default) value is the rule the notes and instructions state; only the exception is sent. */
const DEFAULT_VALUES: Record<string, unknown> = {
  clipped_to_range_start: false,
  capped_to_tool_max_range: false,
  mentioned_in_conversation: false,
  availability: 'RECORDS_FOUND',
};

/** "glucose-semantic-summary.v1", "glucose-time-in-range.v1": a version label, not data. */
const VERSION_LABEL = /^[a-z0-9][a-z0-9_.-]*\.v\d+$/i;
const VERSION_LABEL_KEYS = new Set(['model', 'policy_version']);

/** { count, sha256, first, last } digest of a dropped id list (see refDigest in ai-gateway.service.ts). */
function isRefDigest(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).sha256 === 'string';
}

/** 12.599999999999998 -> 12.6; three decimals keep 0.025 U/h basal steps exact. */
function roundFloat(value: number): number {
  return Number.isInteger(value) || !Number.isFinite(value) ? value : Math.round(value * 1000) / 1000;
}

/** UTC ISO timestamps as the evidence writes them ("2026-10-18T09:20:00.000Z", with or without seconds). */
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;

/**
 * "2026-10-18T09:20:00.000Z" -> "2026-10-18T11:20+02:00" in the request timezone: the model reads local wall-clock
 * time without converting, the offset keeps it exact (and parseable when echoed back in a tool request), and the
 * string is shorter. Readings are 5-min data, so seconds carry nothing. Null when the timezone is unusable.
 */
export function createLocalTimeFormatter(timezone: unknown): ((iso: string) => string) | null {
  if (typeof timezone !== 'string' || !timezone) return null;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' });
  } catch {
    return null;
  }
  return (iso: string) => {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return iso;
    const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
    const offset = String(parts.timeZoneName ?? '').replace('GMT', '') || '+00:00';
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}${offset}`;
  };
}

/** Lists at least this long of same-shaped flat records are sent as columns and rows (compact format only). */
const COLUMNAR_MIN_ROWS = 3;

/**
 * Limitations every result of a kind repeats word for word; the system instructions say the same once (associations are
 * never computed; WBT entries are explained with the WBT rules).
 */
const BOILERPLATE_LIMITATIONS = [
  /^Meal and activity association remains explicit UNKNOWN/,
  /^Meal evidence is scoped to deterministic event selection/,
  /^fat_protein_unit_entries are carbs logged in the loop only/,
];

/** Evidence tools whose coverage only repeats their first and last event (the gaps are the hours without events). */
const EVENT_SPAN_TOOLS = new Set(['get_insulin_evidence', 'get_meal_evidence']);

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Fields of one evidence record that only repeat a default or another field (audit 2026-10-26): the model reads the
 * same facts with fewer tokens. Lossless: every dropped value is a default the instructions state, a sum of fields
 * kept, or a copy of a field kept.
 */
function pruneRepeats(out: Record<string, unknown>): void {
  const tir = out.time_in_range as Record<string, unknown> | undefined;
  if (tir && typeof tir === 'object' && !Array.isArray(tir)) {
    const next = { ...tir };
    // Sums of the bands kept (very_low + low, high + very_high).
    delete next.below_range_percent;
    delete next.above_range_percent;
    // The standard target (the instructions say 70-180 unless stated).
    if (sameJson(next.target_mg_dl, { low: 70, high: 180 })) delete next.target_mg_dl;
    if (next.readings_count !== undefined && next.readings_count === out.observation_count) delete next.readings_count;
    out.time_in_range = next;
  }
  if (out.trajectory_points !== undefined && out.trajectory_points === out.observation_count) delete out.trajectory_points;
  if (out.unknown_count === 0) delete out.unknown_count;
  if (out.missing_count === 0) delete out.missing_count;
  if (out.coverage_status === 'HAS_USABLE_GLUCOSE_DATA') delete out.coverage_status;
  const status = out.evidence_status as Record<string, unknown> | undefined;
  if (status && typeof status === 'object' && !Array.isArray(status)) {
    const next = { ...status };
    if (next.glucose_data === 'KNOWN') delete next.glucose_data;
    if (next.excluded_evidence === 'NONE') delete next.excluded_evidence;
    if (Object.keys(next).length === 0) delete out.evidence_status; else out.evidence_status = next;
  }
  const associations = out.associations as Record<string, unknown> | undefined;
  if (associations && typeof associations === 'object' && Object.values(associations).every((value) => value === 'UNKNOWN')) delete out.associations;
  if (Array.isArray(out.limitations)) {
    const kept = (out.limitations as unknown[]).filter((line) => !(typeof line === 'string' && BOILERPLATE_LIMITATIONS.some((pattern) => pattern.test(line))));
    if (kept.length === 0) delete out.limitations; else out.limitations = kept;
  }
  // Compiler names and therapy profile ids are labels, not data; an unknown meal type says nothing.
  if (typeof out.model === 'string' && out.model.endsWith('-compiler')) delete out.model;
  for (const key of ['profile_id', 'therapy_id']) if (key in out) delete out[key];
  if (out.meal_type === null) delete out.meal_type;
  // A result's coverage that only restates the window (or, for event tools, the first and last event) is dropped.
  const coverage = out.coverage as Record<string, unknown> | undefined;
  if (coverage && typeof coverage === 'object' && coverage.status === 'KNOWN') {
    const gaps = Array.isArray(coverage.gaps) ? coverage.gaps : [];
    if ((gaps.length === 0 && (coverage.covered_range === undefined || sameJson(coverage.covered_range, coverage.range)))
      || (typeof out.tool === 'string' && EVENT_SPAN_TOOLS.has(out.tool))) delete out.coverage;
  }
  // The inner status repeats the result's status.
  const evidence = out.evidence as Record<string, unknown> | undefined;
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence) && evidence.status !== undefined && evidence.status === out.status) {
    const { status: _same, ...rest } = evidence;
    out.evidence = rest;
  }
}

/** "2026-10-18T15:30+02:00" (the local formatter's output). */
const LOCAL_MINUTE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})([+-]\d{2}:\d{2}|Z)$/;

/**
 * A columnar block whose times all fall on one date with one offset: the date and offset once, "07:15" in the cells
 * (same_for_all.date / utc_offset). Blocks spanning two dates or offsets are left whole.
 */
function withDateOnce(block: unknown): unknown {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
  const { columns, rows } = block as { columns?: unknown; rows?: unknown };
  if (!Array.isArray(columns) || !Array.isArray(rows) || rows.length === 0) return block;
  let date: string | null = null;
  let offset: string | null = null;
  let any = false;
  for (const row of rows as unknown[][]) {
    for (const cell of row) {
      const match = typeof cell === 'string' ? LOCAL_MINUTE.exec(cell) : null;
      if (!match) continue;
      any = true;
      if (date === null) { date = match[1]; offset = match[3]; }
      if (match[1] !== date || match[3] !== offset) return block;
    }
  }
  if (!any) return block;
  const record = block as Record<string, unknown>;
  return {
    ...record,
    same_for_all: { ...((record.same_for_all as Record<string, unknown> | undefined) ?? {}), date, utc_offset: offset },
    rows: (rows as unknown[][]).map((row) => row.map((cell) => {
      const match = typeof cell === 'string' ? LOCAL_MINUTE.exec(cell) : null;
      return match ? match[2] : cell;
    })),
  };
}

/**
 * Reading rows of one day and offset: the date and offset once, "15:30" per row (−35% of a reading list). Rows that
 * span two dates or offsets are left as they are.
 */
function compactReadingTimes(out: Record<string, unknown>): void {
  const rows = out.readings;
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every((row) => Array.isArray(row) && typeof row[0] === 'string')) return;
  const parts = (rows as unknown[][]).map((row) => LOCAL_MINUTE.exec(row[0] as string));
  if (parts.some((match) => !match)) return;
  const [date, offset] = [parts[0]![1], parts[0]![3]];
  if (!parts.every((match) => match![1] === date && match![3] === offset)) return;
  out.readings_date = date;
  out.readings_utc_offset = offset;
  out.readings = (rows as unknown[][]).map((row, index) => [parts[index]![2], ...row.slice(1)]);
  if (Array.isArray(out.reading_columns)) out.reading_columns = ['local_time', ...(out.reading_columns as unknown[]).slice(1)];
}

type Primitive = string | number | boolean | null;
const isPrimitive = (value: unknown): value is Primitive => value === null || ['string', 'number', 'boolean'].includes(typeof value);

/**
 * [{type:'TEMP_BASAL', start, end, rate, status:'VALID'}, ...] -> { same_for_all: {type, status}, columns: [start, end,
 * rate], rows: [[...], ...] }: the same values without repeating every key on every record. Lossless; lists of other
 * shapes are returned unchanged.
 */
function toColumns(records: unknown[]): unknown {
  if (records.length < COLUMNAR_MIN_ROWS) return records;
  const first = records[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return records;
  const keys = Object.keys(first);
  const sameShape = records.every((record) => record && typeof record === 'object' && !Array.isArray(record)
    && Object.keys(record).length === keys.length && keys.every((key) => key in (record as object) && isPrimitive((record as Record<string, unknown>)[key])));
  if (!sameShape || keys.length < 2) return records;
  const rows = records as Array<Record<string, Primitive>>;
  const constant = keys.filter((key) => rows.every((row) => row[key] === rows[0][key]));
  const columns = keys.filter((key) => !constant.includes(key));
  if (columns.length === 0) return records;
  return {
    ...(constant.length > 0 ? { same_for_all: Object.fromEntries(constant.map((key) => [key, rows[0][key]])) } : {}),
    columns,
    rows: rows.map((row) => columns.map((key) => row[key])),
  };
}

export interface ModelFacingFormat {
  /** See createLocalTimeFormatter. */
  localTime?: ((iso: string) => string) | null;
  /** Long same-shaped record lists as columns and rows. */
  columnar?: boolean;
}

export function stripEvidenceForModel(value: unknown, format?: ModelFacingFormat | null): unknown {
  const localTime = format?.localTime ?? null;
  if (Array.isArray(value)) {
    const stripped = value.map((entry) => stripEvidenceForModel(entry, format));
    const columns = format?.columnar ? toColumns(stripped) : stripped;
    return localTime ? withDateOnce(columns) : columns;
  }
  if (typeof value === 'number') return roundFloat(value);
  if (typeof value === 'string') return localTime && UTC_ISO.test(value) ? localTime(value) : value;
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (DROPPED_KEYS.has(key)) continue;
    // Provenance blocks hold only ref counts, hashes and policy labels.
    if (key === 'provenance' && entry && typeof entry === 'object' && !Array.isArray(entry)) continue;
    if (key.endsWith('_refs') && isRefDigest(entry)) continue;
    if (VERSION_LABEL_KEYS.has(key) && typeof entry === 'string' && VERSION_LABEL.test(entry)) continue;
    if (key in DEFAULT_VALUES && entry === DEFAULT_VALUES[key]) continue;
    if (key === 'episode_ids' && Array.isArray(entry)) {
      // Opaque episode ids: how many episodes the window covers is what counts.
      out.episode_count = entry.length;
      continue;
    }
    if (key === 'hypo_episode_refs' && Array.isArray(entry)) {
      // The ids say nothing; how many hypo episodes the day holds does.
      if (entry.length > 0) out.hypo_episode_count = entry.length;
      continue;
    }
    const stripped = stripEvidenceForModel(entry, format);
    if (key === 'semantic_anchors' && stripped && typeof stripped === 'object' && Object.keys(stripped).length === 0) continue;
    out[key] = stripped;
  }
  // A domain result repeats its coverage inside evidence word for word: send it once.
  const evidence = out.evidence as Record<string, unknown> | undefined;
  if (evidence && typeof evidence === 'object' && evidence.coverage !== undefined && out.coverage !== undefined
    && JSON.stringify(evidence.coverage) === JSON.stringify(out.coverage)) {
    const { coverage: _duplicate, ...rest } = evidence;
    out.evidence = rest;
  }
  pruneRepeats(out);
  if (localTime) compactReadingTimes(out);
  return out;
}

/** An unresolved meal anchor carries only MISSING macros and candidate ids: its status and notes say the same. */
function compactMealReference(reference: unknown): unknown {
  if (!reference || typeof reference !== 'object') return reference;
  const record = reference as Record<string, unknown>;
  if (record.status !== 'UNRESOLVED') return reference;
  return { status: 'UNRESOLVED', ...(record.notes !== undefined ? { notes: record.notes } : {}) };
}

/** Sections of the time-range envelope that carry evidence; the rest (task, question, contracts) is sent as built. */
const EVIDENCE_SECTIONS = ['tool_loop_state', 'temporal_evidence', 'daily_insulin_totals'] as const;

/**
 * Envelope parts the model never reads (audit 2026-10-26): the task's labels, provenance counts and the contracts that
 * repeat the system instructions. They are validated on the full envelope before this copy is made.
 */
const MODEL_UNUSED_ENVELOPE_KEYS = ['task', 'provenance_summary', 'evidence_contract', 'historical_therapy_semantics_contract', 'allowed_response_contract'];

function withoutModelUnusedKeys(next: Record<string, unknown>): void {
  for (const key of MODEL_UNUSED_ENVELOPE_KEYS) delete next[key];
}

/** selected_evidence.summary repeats the glucose block's min/max/avg and the per-domain counts. */
function compactSelectedEvidence(selected: unknown): unknown {
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) return selected;
  const { summary, ...rest } = selected as Record<string, unknown>;
  if (!summary || typeof summary !== 'object') return selected;
  const { glucose_min: _min, glucose_max: _max, glucose_avg: _avg, glucose_count: _glucose, insulin_treatment_count: _insulin, meal_count: _meals, activity_count: _activity, hypo_episode_count: _hypos, ...kept } = summary as Record<string, unknown>;
  return { ...rest, summary: kept };
}

/** `format`: compact format (AI_MODEL_FACING_COMPACT_FORMAT); null keeps UTC timestamps and plain record lists. */
export function buildModelFacingTimeRangeEnvelope<T extends Record<string, unknown>>(envelope: T, format: ModelFacingFormat | null = null): T {
  const next: Record<string, unknown> = { ...envelope };
  for (const section of EVIDENCE_SECTIONS) {
    if (next[section] !== undefined && next[section] !== null) next[section] = stripEvidenceForModel(next[section], format);
  }
  if ('current_meal_reference' in next) next.current_meal_reference = compactMealReference(next.current_meal_reference);
  if ('selected_evidence' in next) next.selected_evidence = compactSelectedEvidence(next.selected_evidence);
  // The daily totals' explanation is in the system instructions (time-range prompt).
  const totals = next.daily_insulin_totals as Record<string, unknown> | null | undefined;
  if (totals && typeof totals === 'object' && !Array.isArray(totals) && 'note' in totals) {
    const { note: _note, ...rest } = totals;
    next.daily_insulin_totals = rest;
  }
  const request = next.analysis_request_input as Record<string, unknown> | undefined;
  if (request && typeof request === 'object') {
    const { user_message_id: _id, normalization_policy_version: _version, ...rest } = request;
    next.analysis_request_input = rest;
  }
  withoutModelUnusedKeys(next);
  return next as T;
}

/** The direct reply's model copy: the same unused envelope parts left out (validated before). */
export function buildModelFacingDirectEnvelope<T extends Record<string, unknown>>(envelope: T): T {
  const next: Record<string, unknown> = { ...envelope };
  withoutModelUnusedKeys(next);
  const input = next.direct_response_input as Record<string, unknown> | undefined;
  if (input && typeof input === 'object') {
    const { user_message_id: _id, ...rest } = input;
    next.direct_response_input = rest;
  }
  return next as T;
}

/** Every evidence tool (a record, so a new tool name must be added here). */
const EVIDENCE_TOOL_NAMES: Record<EvidenceToolName, true> = {
  get_glucose_evidence: true,
  get_insulin_evidence: true,
  get_basal_evidence: true,
  get_meal_evidence: true,
  get_activity_evidence: true,
  get_loop_evidence: true,
  get_therapy_profile: true,
};

/** Evidence tools only; search_food, search_knowledge and the meal tools (get_meals) are left as built. */
export function isEvidenceToolName(toolName: string | undefined): toolName is EvidenceToolName {
  return typeof toolName === 'string' && Object.prototype.hasOwnProperty.call(EVIDENCE_TOOL_NAMES, toolName);
}
