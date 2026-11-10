/**
 * What a log line may leave behind in `diagnostic_events` (diagnostics.v1). The report built from it can be published in
 * a GitHub issue, so this is an allowlist: a field not named here is dropped, whatever it holds. No identifiers, no
 * values of therapy (units, grams, readings), no free text (`error`, `message`). A value of the wrong shape is dropped
 * too, so a sentence or an address under an allowed name never gets through.
 */
export type DiagnosticLevel = 'info' | 'warn' | 'error';

export type DiagnosticFieldValue = string | number | boolean;

export interface DiagnosticEvent {
  level: DiagnosticLevel;
  event: string;
  fields: Record<string, DiagnosticFieldValue>;
  duration_ms: number | null;
}

const CODE_FIELDS = new Set([
  'code', 'error_code', 'error_name', 'reason', 'outcome', 'kind', 'lane', 'stream', 'step', 'state', 'status', 'mode', 'trigger',
  'settled_status', 'stage', 'tier', 'model', 'fallback', 'signal', 'listener', 'task_type', 'context', 'method', 'version',
]);
const NUMBER_FIELDS = new Set(['attempt', 'devices', 'status']);
const BOOLEAN_FIELDS = new Set(['retrying', 'in_flight_job', 'supported', 'renewed', 'reopened']);

const EVENT_NAME = /^[a-z][a-z0-9_.:-]{0,79}$/;
/** A constant from code: letters, digits and a few joiners. No spaces, "@" or "/", so no sentence, e-mail or address. */
const CODE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
/** An Express route template: "/v1/patients/:patientId/dashboard", never a real path with an id. */
const ROUTE_TEMPLATE = /^\/[A-Za-z0-9_/:.-]{0,159}$/;
/** UUIDs and long digit runs are identifiers, whatever the field is called. A model's date ("-20250514") is not. */
const IDENTIFIER_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}|\d{9,}/i;

export function isDiagnosticCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_VALUE.test(value) && !IDENTIFIER_LIKE.test(value);
}

/** Only the allowed fields, in a stable order. Exported for the API error record, which builds its fields itself. */
export function allowedDiagnosticFields(raw: Record<string, unknown>): Record<string, DiagnosticFieldValue> {
  const fields: Record<string, DiagnosticFieldValue> = {};
  for (const key of Object.keys(raw).sort()) {
    const value = raw[key];
    if (key === 'route') {
      if (typeof value === 'string' && ROUTE_TEMPLATE.test(value) && !IDENTIFIER_LIKE.test(value)) fields.route = value;
    } else if (NUMBER_FIELDS.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      fields[key] = value;
    } else if (BOOLEAN_FIELDS.has(key) && typeof value === 'boolean') {
      fields[key] = value;
    } else if (CODE_FIELDS.has(key) && isDiagnosticCode(value)) {
      fields[key] = value;
    }
  }
  return fields;
}

/**
 * One log call turned into an event, or null when nothing should be kept: ordinary framework lines at log level. A
 * warning or an error that is not structured keeps only that it happened and in which part of the server.
 */
export function diagnosticEventFromLog(level: DiagnosticLevel, message: unknown, context: string | null): DiagnosticEvent | null {
  const parsed = parseStructured(message);
  if (parsed && typeof parsed.event === 'string' && EVENT_NAME.test(parsed.event)) {
    const duration = parsed.duration_ms;
    return {
      level,
      event: parsed.event,
      fields: allowedDiagnosticFields(parsed),
      duration_ms: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null,
    };
  }
  if (level === 'info') return null;
  return { level, event: 'unstructured_log', fields: allowedDiagnosticFields({ context }), duration_ms: null };
}

function parseStructured(message: unknown): Record<string, unknown> | null {
  if (message !== null && typeof message === 'object' && !Array.isArray(message)) return message as Record<string, unknown>;
  if (typeof message !== 'string' || !message.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(message);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
