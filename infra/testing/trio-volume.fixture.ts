/**
 * Synthetic Trio loop at its real volumes (~1,150 events a day), for offline specs of what an analysis loads and what
 * the model is told. Per local day: 288 CGM readings, ~330 IOB and ~330 COB snapshots, 150 temp basals, 30 SMBs,
 * 12 boluses and 12 carb entries; a short low around 03:00 every night (nadir 55 mg/dL) and, by default, one CGM gap.
 * No database, no network: `trioRepositoryHandlers` mirrors the SQL of the repository methods an analysis reads
 * (bounds, order, limits, keep NEWEST, total_in_range). Specs wrap the handlers in mocks themselves (this file is
 * compiled with the app, so it does not import vitest).
 */

export const TRIO_PATIENT_ID = '22222222-2222-4222-8222-222222222222';
export const TRIO_TIMEZONE = 'Europe/Warsaw';
export const TRIO_CONVERSATION_ID = 'trio-conversation-1';
export const TRIO_USER_MESSAGE_ID = 'trio-user-message-1';
export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
/** Local minutes of the 12 boluses and carb entries of a day (06:30 ... 22:00). */
export const TRIO_MEAL_MINUTES = [390, 450, 540, 630, 720, 780, 870, 960, 1050, 1140, 1230, 1320];
/** The nightly low: CGM readings 34-38 of a day (02:50-03:10 local), nadir 55 at 03:00. */
const NIGHT_LOW: Record<number, number> = { 34: 66, 35: 60, 36: 55, 37: 61, 38: 68 };

export type TrioEvent = { id: string; patient_id: string; source_record_id: string; type: string; occurred_at: string; payload: Record<string, unknown> };

export interface TrioFixture {
  events: TrioEvent[];
  /** Local midnight of the first generated day. */
  firstDayStartIso: string;
  requestedAtIso: string;
  /** The CGM gap (no readings in [from, to)), or null. */
  cgmGap: { from: string; to: string } | null;
}

/** One local day of a Trio loop, events before `untilMs` only (today so far). */
export function trioDay(dayStartMs: number, untilMs: number, dayIndex: number, cgmGap?: { fromMs: number; toMs: number } | null): TrioEvent[] {
  const events: TrioEvent[] = [];
  const push = (type: string, ms: number, payload: Record<string, unknown>) => {
    if (ms >= untilMs) return;
    const id = `${type.toLowerCase()}-${dayIndex}-${events.length}`;
    events.push({ id, patient_id: TRIO_PATIENT_ID, source_record_id: `ns-${id}`, type, occurred_at: new Date(ms).toISOString(), payload });
  };
  for (let index = 0; index < 288; index += 1) {
    const ms = dayStartMs + index * 5 * MINUTE_MS;
    if (cgmGap && ms >= cgmGap.fromMs && ms < cgmGap.toMs) continue;
    // 60-240 mg/dL over the day; the short night low below 70.
    const value = NIGHT_LOW[index] ?? Math.round(150 + 90 * Math.sin((index / 288) * 2 * Math.PI));
    push('GLUCOSE_READING_AVAILABLE', ms, { glucose_value: value });
  }
  for (let index = 0; index < 330; index += 1) {
    const ms = dayStartMs + Math.floor((index * DAY_MS) / 330) + 30_000;
    push('IOB_SNAPSHOT', ms, { iob: 1.2 });
    push('COB_SNAPSHOT', ms + 1_000, { cob: 10 });
  }
  for (let index = 0; index < 150; index += 1) {
    push('TEMP_BASAL', dayStartMs + Math.floor((index * DAY_MS) / 150) + 60_000, { rate: 0.45, absolute: 0.45, duration_minutes: 30 });
  }
  for (let index = 0; index < 30; index += 1) {
    push('SMB', dayStartMs + index * 48 * MINUTE_MS + 2 * MINUTE_MS, { insulin_units: 0.1 });
  }
  for (const [index, minute] of TRIO_MEAL_MINUTES.entries()) {
    push('BOLUS', dayStartMs + minute * MINUTE_MS, { insulin_units: 1 + index / 10 });
    push('CARB_ENTRY', dayStartMs + minute * MINUTE_MS + MINUTE_MS, { carbs: 20 + index });
  }
  return events.sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));
}

/**
 * `days` complete local days before the request's day plus that day up to the request. `firstDayStartIso` must be a
 * local midnight and the generated days must not cross a DST change (days are 24 h apart). The default CGM gap is one
 * hour, 14:00-15:00 local two days before the request's day; pass `cgmGap: null` for none.
 */
export function createTrioFixture(args: {
  requestedAtIso: string;
  /** Local midnight of the request's day. */
  todayStartIso: string;
  days: number;
  cgmGap?: { from: string; to: string } | null;
}): TrioFixture {
  const todayStartMs = Date.parse(args.todayStartIso);
  const firstDayStartMs = todayStartMs - args.days * DAY_MS;
  const untilMs = Date.parse(args.requestedAtIso);
  const cgmGap = args.cgmGap === undefined
    ? { from: new Date(todayStartMs - 2 * DAY_MS + 14 * 60 * MINUTE_MS).toISOString(), to: new Date(todayStartMs - 2 * DAY_MS + 15 * 60 * MINUTE_MS).toISOString() }
    : args.cgmGap;
  const gapMs = cgmGap ? { fromMs: Date.parse(cgmGap.from), toMs: Date.parse(cgmGap.to) } : null;
  const events: TrioEvent[] = [];
  for (let day = 0, startMs = firstDayStartMs; startMs < untilMs; day += 1, startMs += DAY_MS) {
    events.push(...trioDay(startMs, untilMs, day, gapMs));
  }
  return { events, firstDayStartIso: new Date(firstDayStartMs).toISOString(), requestedAtIso: args.requestedAtIso, cgmGap };
}

const inRange = (iso: string, startIso: string, endIso: string) => Date.parse(iso) >= Date.parse(startIso) && Date.parse(iso) <= Date.parse(endIso);

const GLUCOSE_TYPES = ['GLUCOSE_READING_AVAILABLE', 'GLUCOSE_READING', 'GLUCOSE'];

export interface TrioRepositoryOptions {
  question?: string;
  insulinQueryFails?: boolean;
  /** Assistant messages and other rows the worker writes: their ids. */
  assistantMessageId?: string;
}

/**
 * The repository methods a conversation analysis or direct reply reads and writes, as plain async functions over the
 * fixture's events. Hypo episodes: one every 6 h from the first day (more than the 50 an analysis lists in two weeks);
 * 20 caregiver facts, one every 16 h.
 */
export function trioRepositoryHandlers(fixture: TrioFixture, options: TrioRepositoryOptions = {}): Record<string, (...args: any[]) => Promise<any>> {
  const { events, requestedAtIso, firstDayStartIso } = fixture;
  const firstDayMs = Date.parse(firstDayStartIso);
  const userMessage = { id: TRIO_USER_MESSAGE_ID, role: 'USER', message_type: 'USER_MESSAGE', content: options.question ?? 'Jak wyglądały ostatnie 2 tygodnie?', created_at: requestedAtIso, provenance_ref: 'conv/trio' };
  const hypoEpisodes = Array.from({ length: Math.floor((Date.parse(requestedAtIso) - firstDayMs) / (6 * 60 * MINUTE_MS)) + 1 }, (_, index) => {
    const startedMs = firstDayMs + 3 * 60 * MINUTE_MS + index * 6 * 60 * MINUTE_MS;
    return { id: `hypo-${index + 1}`, patient_id: TRIO_PATIENT_ID, state: 'CLOSED', severity: 'L1', started_at: new Date(startedMs).toISOString(), ended_at: new Date(startedMs + 20 * MINUTE_MS).toISOString(), trigger_id: null };
  });
  const facts = Array.from({ length: 20 }, (_, index) => ({ id: `fact-${index + 1}`, fact_key: `note-${index + 1}`, fact_name: 'NOTE', value: { text: `note ${index + 1}` }, value_type: 'JSON', knowledge_status: 'KNOWN', source_ref: `fact/${index + 1}`, recorded_at: new Date(firstDayMs + (index + 1) * 16 * 60 * MINUTE_MS).toISOString(), created_at: requestedAtIso }));
  const keepNewest = <T>(rows: T[], limit: number, keep?: string) => (keep === 'NEWEST' ? rows.slice(Math.max(0, rows.length - limit)) : rows.slice(0, limit))
    .map((row) => ({ ...row, total_in_range: rows.length }));
  const analysis = { id: 'trio-analysis-1', status: 'INSUFFICIENT_DATA', facts: [], unknowns: [], calculations: [], hypotheses: [], uncertainty: {}, question: null, proposal: null, rationale: '' };
  return {
    getConversation: async () => ({ id: TRIO_CONVERSATION_ID, patient_id: TRIO_PATIENT_ID, thread_state_version: 'conv-v1', awaiting_user_answer: false, messages: [userMessage] }),
    getMessageByIdempotencyKey: async () => null,
    getMessageById: async () => userMessage,
    // The loop's state 3 minutes before the question.
    getCurrentStateAtOrBefore: async () => ({ as_of: new Date(Date.parse(requestedAtIso) - 3 * MINUTE_MS).toISOString(), glucose: { value: 132, trend: 'FLAT' }, iob: { value: 1.4 }, cob: { value: 12 } }),
    getCurrentState: async () => null,
    listRecentConversationEventFacts: async () => [],
    listPatientEventsByRange: async (args: { startAtIso: string; endAtIso: string; limit: number; excludeTypes?: readonly string[]; keep?: string }) => {
      const selected = events.filter((event) => inRange(event.occurred_at, args.startAtIso, args.endAtIso) && !(args.excludeTypes ?? []).includes(event.type));
      const limit = Math.max(1, Math.min(5000, Math.floor(args.limit)));
      return args.keep === 'NEWEST' ? selected.slice(Math.max(0, selected.length - limit)) : selected.slice(0, limit);
    },
    listInsulinDeliveryEventsByRange: async (args: { startAtIso: string; endAtIso: string }) => {
      if (options.insulinQueryFails) throw new Error('synthetic insulin query failure');
      return events.filter((event) => ['BOLUS', 'SMB', 'TEMP_BASAL'].includes(event.type) && inRange(event.occurred_at, args.startAtIso, args.endAtIso))
        .map((event) => ({ event_id: event.id, type: event.type, occurred_at: event.occurred_at, payload: event.payload }));
    },
    getGlucoseAggregatesByRange: async (args: { startAtIso: string; endAtIso: string }) => {
      const values = events.filter((event) => GLUCOSE_TYPES.includes(event.type) && inRange(event.occurred_at, args.startAtIso, args.endAtIso)).map((event) => Number(event.payload.glucose_value));
      const count = (predicate: (value: number) => boolean) => values.filter(predicate).length;
      const bands = { very_low: count((value) => value < 54), low: count((value) => value >= 54 && value < 70), high: count((value) => value > 180 && value <= 250), very_high: count((value) => value > 250) };
      return {
        count: values.length,
        min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null,
        avg: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        bands: { ...bands, in_range: values.length - bands.very_low - bands.low - bands.high - bands.very_high },
      };
    },
    countPatientDataInRange: async (args: { startAtIso: string; endAtIso: string }) => {
      const count = (types: string[]) => events.filter((event) => types.includes(event.type) && inRange(event.occurred_at, args.startAtIso, args.endAtIso)).length;
      return { glucose_readings: count(GLUCOSE_TYPES), boluses: count(['BOLUS']), smbs: count(['SMB']), temp_basals: count(['TEMP_BASAL']), loop_snapshots: count(['IOB_SNAPSHOT', 'COB_SNAPSHOT']) };
    },
    getTherapyDiaAt: async () => ({ status: 'KNOWN', dia_hours: 5, therapy_id: 'therapy-trio', valid_from: '2026-09-01T00:00:00.000Z' }),
    getTherapyProfileAt: async () => ({
      status: 'KNOWN', therapy_id: 'therapy-trio', valid_from: '2026-09-01T00:00:00.000Z', units: 'mg/dl', timezone: TRIO_TIMEZONE, dia_hours: 5,
      carb_ratio_g_per_u: [['00:00', 12]], sensitivity_per_u: [['00:00', 110]],
      basal_u_per_h: [['00:00', 0.3], ['06:00', 0.5], ['21:00', 0.35]], target_low: [['00:00', 100]], target_high: [['00:00', 120]],
    }),
    listHypoEpisodesIntersectingRange: async (args: { startAtIso: string; endAtIso: string; limit: number; keep?: string }) => keepNewest(
      hypoEpisodes.filter((episode) => Date.parse(episode.started_at) <= Math.min(Date.parse(args.endAtIso), Date.parse(requestedAtIso)) && Date.parse(episode.ended_at) >= Date.parse(args.startAtIso)),
      Math.max(1, Math.min(200, Math.floor(args.limit))),
      args.keep,
    ),
    listPatientContextFactsByRecordedRange: async (args: { startAtIso: string; endAtIso: string; limit: number; keep?: string }) => keepNewest(
      facts.filter((fact) => inRange(fact.recorded_at, args.startAtIso, args.endAtIso)),
      Math.max(1, Math.min(500, Math.floor(args.limit))),
      args.keep,
    ),
    insertContextPackage: async () => ({ id: 'trio-package-1' }),
    getAiExecutionByTaskIdentity: async () => null,
    markAiExecutionRunning: async () => undefined,
    markAiExecutionSucceeded: async () => undefined,
    markAiExecutionFailed: async () => undefined,
    insertAnalysis: async () => analysis,
    linkAiExecutionToAnalysis: async () => undefined,
    getAnalysis: async () => analysis,
    insertRecommendation: async () => ({ id: 'trio-recommendation-1', analysis_id: 'trio-analysis-1', status: 'INSUFFICIENT_DATA', proposal: {}, evidence: [], provenance: {} }),
    linkConversation: async () => undefined,
    insertMessage: async () => ({ id: options.assistantMessageId ?? 'trio-assistant-message-1' }),
    finalizeJobSuccess: async () => undefined,
  };
}
