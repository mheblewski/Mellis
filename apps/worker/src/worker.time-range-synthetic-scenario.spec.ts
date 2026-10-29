import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { createConversationTimeRangeAnalysisTask } from '@modules/ai-gateway/application/ai-task';
import { buildTimeRangeAnalysisPrompt } from '@modules/ai-gateway/application/time-range-analysis-prompt';
import { validateAiEvidenceDeliveryEnvelope } from '@modules/ai-gateway/infrastructure/openai-provider';
import type { AiProvider, AiProviderInput, AiProviderResponse, TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import { routeUserMessage } from '@modules/context/application/message-routing';
import {
  buildTimeRangeSyntheticScenario,
  SYNTHETIC_SCENARIO_MOMENTS,
  SYNTHETIC_SCENARIO_REFERENCE_REQUESTED_AT,
  type TimeRangeSyntheticScenario,
} from '@modules/context/application/time-range-synthetic-scenario.fixture';
import { KnowledgeSearchService } from '@modules/knowledge/application/knowledge-search';
import {
  FakeEmbeddingsClient,
  FakeKnowledgeChunkStore,
  FakeLightModelClient,
  fakeKnowledgeChunk,
} from '@modules/knowledge/infrastructure/fake-knowledge-search';

// Offline contract test: a fake repository serves the synthetic scenario with the same filtering, ordering and limits
// as the real SQL, and the AI gateway is replaced, so the real worker code builds the context_package that we capture.
// No database, no AI provider, no network.

const CONVERSATION_ID = 'synthetic-conversation-1';
const USER_MESSAGE_ID = 'synthetic-user-message-1';
const JOB_ID = 'synthetic-job-1';
const DAY_MS = 24 * 60 * 60 * 1000;

function inRange(iso: string, startIso: string, endIso: string): boolean {
  const value = Date.parse(iso);
  return value >= Date.parse(startIso) && value <= Date.parse(endIso);
}

/** Mirrors the SQL of listPatientEventsByRange / listHypoEpisodesIntersectingRange (bounds, order, limit clamp). */
function makeScenarioRepository(scenario: TimeRangeSyntheticScenario) {
  const userMessage = {
    id: USER_MESSAGE_ID,
    role: 'USER',
    message_type: 'USER_MESSAGE',
    content: scenario.user_message,
    created_at: scenario.requested_at,
    provenance_ref: `conv/${CONVERSATION_ID}/messages/synthetic`,
  };
  return {
    getConversation: vi.fn().mockResolvedValue({
      id: CONVERSATION_ID,
      patient_id: scenario.patient_id,
      thread_state_version: 'conv-v1',
      awaiting_user_answer: false,
      messages: [userMessage],
    }),
    getMessageByIdempotencyKey: vi.fn().mockResolvedValue(null),
    getMessageById: vi.fn().mockResolvedValue(userMessage),
    // The scenario has no current state at all.
    getCurrentStateAtOrBefore: vi.fn().mockResolvedValue(null),
    getCurrentState: vi.fn().mockResolvedValue(null),
    listPatientEventsByRange: vi.fn(async (args: { patientId: string; startAtIso: string; endAtIso: string; limit: number; excludeTypes?: readonly string[]; keep?: 'OLDEST' | 'NEWEST' }) => {
      const limit = Math.max(1, Math.min(5000, Math.floor(args.limit)));
      const selected = scenario.events
        .filter((event) => event.patient_id === args.patientId && inRange(event.occurred_at, args.startAtIso, args.endAtIso))
        .filter((event) => !(args.excludeTypes ?? []).includes(event.type));
      return args.keep === 'NEWEST' ? selected.slice(Math.max(0, selected.length - limit)) : selected.slice(0, limit);
    }),
    listHypoEpisodesIntersectingRange: vi.fn(async (args: { patientId: string; startAtIso: string; endAtIso: string; limit: number }) => {
      const limit = Math.max(1, Math.min(200, Math.floor(args.limit)));
      return scenario.hypo_episodes
        .filter((episode) => episode.patient_id === args.patientId
          && Date.parse(episode.started_at) <= Date.parse(args.endAtIso)
          && Date.parse(episode.ended_at) >= Date.parse(args.startAtIso))
        .slice(0, limit);
    }),
    listPatientContextFactsByRecordedRange: vi.fn().mockResolvedValue([]),
    insertContextPackage: vi.fn().mockResolvedValue({ id: 'synthetic-package-1' }),
    getAiExecutionByTaskIdentity: vi.fn().mockResolvedValue(null),
    markAiExecutionRunning: vi.fn(),
    markAiExecutionSucceeded: vi.fn(),
    markAiExecutionFailed: vi.fn(),
    insertAnalysis: vi.fn().mockResolvedValue({ id: 'synthetic-analysis-1', status: 'INSUFFICIENT_DATA', facts: [], unknowns: [], calculations: [], hypotheses: [], uncertainty: {}, question: null, proposal: null, rationale: '' }),
    linkAiExecutionToAnalysis: vi.fn(),
    getAnalysis: vi.fn().mockResolvedValue({ id: 'synthetic-analysis-1', status: 'INSUFFICIENT_DATA', facts: [], unknowns: [], calculations: [], hypotheses: [], uncertainty: {}, question: null, proposal: null, rationale: '' }),
    insertRecommendation: vi.fn(async (args: Record<string, unknown>) => ({ id: 'synthetic-recommendation-1', analysis_id: String(args.analysisId ?? ''), status: 'INSUFFICIENT_DATA', proposal: {}, evidence: [], provenance: {} })),
    linkConversation: vi.fn(),
    insertMessage: vi.fn().mockResolvedValue({ id: 'synthetic-assistant-message-1' }),
    finalizeJobSuccess: vi.fn(),
  } as any;
}

async function captureContextPackage(scenario: TimeRangeSyntheticScenario) {
  const repository = makeScenarioRepository(scenario);
  const aiGateway = {
    execute: vi.fn().mockResolvedValue({
      result: { assistant_message: 'Synthetic placeholder answer.' },
      metadata: { provider: 'fake', model: 'synthetic', model_fingerprint: 'synthetic' },
      input_hash: 'sha256:synthetic',
    }),
  };
  const worker = new WorkerService(repository, {} as any, { get: vi.fn(), getOrThrow: vi.fn() } as any, aiGateway as any, {} as any);
  await (worker as any).handleConversationTimeRangeAnalysis(JOB_ID, 'synthetic-lease', {
    patient_id: scenario.patient_id,
    conversation_id: CONVERSATION_ID,
    user_message_id: USER_MESSAGE_ID,
    range_type: scenario.range_type,
    range_start: scenario.range_start,
    range_end: scenario.range_end,
    timezone: scenario.timezone,
    normalization_policy_version: scenario.normalization_policy_version,
  });
  expect(aiGateway.execute).toHaveBeenCalledTimes(1);
  return {
    repository,
    context: aiGateway.execute.mock.calls[0][0].context_package as TimeRangeAnalysisContextRecord,
  };
}

class StubProvider implements AiProvider {
  constructor(private readonly producer: (input: AiProviderInput) => Promise<AiProviderResponse>) {}

  generate(input: AiProviderInput): Promise<AiProviderResponse> {
    return this.producer(input);
  }
}

/** Tool results reach the model with each source_refs list as its count and hash (full lists stay in the audit). */
function sourceRefDigest(refs: string[]): { source_ref_count: number; source_refs_sha256: string } {
  return { source_ref_count: refs.length, source_refs_sha256: `sha256:${createHash('sha256').update(JSON.stringify(refs)).digest('hex')}` };
}

/** Minute-precision UTC time, as the provider copy sends record times. */
function minuteIso(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16)}Z`;
}

/** Digest that replaces a list of per-record ids in the provider copy. */
function recordRefDigest(refs: string[]): { count: number; sha256: string; first: string | null; last: string | null } {
  return { count: refs.length, sha256: `sha256:${createHash('sha256').update(JSON.stringify(refs)).digest('hex')}`, first: refs[0] ?? null, last: refs[refs.length - 1] ?? null };
}

/** Runs the real gateway in tool-loop mode; the stub "model" requests the given tools in order, then answers. */
async function collectToolResults(context: TimeRangeAnalysisContextRecord, requests: Array<{ tool: string; from: string; to: string }>) {
  const previousFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
  process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';
  try {
    const inputs: AiProviderInput[] = [];
    const gateway = new AiGatewayService(new StubProvider(async (input) => {
      inputs.push(input);
      const next = requests[inputs.length - 1];
      if (next) {
        return {
          provider: 'fake',
          model: 'deterministic-hypo-v1',
          response_id: `resp-${inputs.length}`,
          received_at: new Date().toISOString(),
          raw_output: {},
          tool_call: { call_id: `call-${inputs.length}`, tool_name: next.tool, arguments: { time_range: { from: next.from, to: next.to }, detail_level: 'DETAIL' } },
        };
      }
      return { provider: 'fake', model: 'deterministic-hypo-v1', received_at: new Date().toISOString(), raw_output: { assistant_message: 'Analiza zakresu gotowa.' } };
    }));
    await gateway.execute({
      task: createConversationTimeRangeAnalysisTask({
        task_id: 'synthetic-task-1',
        context_package_id: context.context_package_id,
        context_package_version: context.context_package_version,
        context_package_hash: context.content_hash,
        correlation_id: CONVERSATION_ID,
        created_at: SYNTHETIC_SCENARIO_REFERENCE_REQUESTED_AT,
      }),
      context_package: context,
      timeout_ms: 5_000,
    });
    // Each result once, in delivery order: an intact chain sends only the new results on each turn.
    const delivered = new Map<string, Record<string, any>>();
    for (const input of inputs) {
      for (const entry of input.tool_runtime?.tool_results ?? []) {
        if (!delivered.has(entry.call_id)) delivered.set(entry.call_id, entry.result as Record<string, any>);
      }
    }
    return new Map([...delivered.values()].map((result, index) => [requests[index].tool, result]));
  } finally {
    if (previousFlag === undefined) {
      delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    } else {
      process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousFlag;
    }
  }
}

describe('conversation.time_range_analysis with the synthetic 3-day scenario (offline)', () => {
  const scenario = buildTimeRangeSyntheticScenario();
  let captured: Awaited<ReturnType<typeof captureContextPackage>>;
  const yesterdayFrom = new Date(Date.parse(scenario.scenario_start) + DAY_MS).toISOString();
  const yesterdayTo = new Date(Date.parse(scenario.scenario_start) + 2 * DAY_MS).toISOString();

  beforeAll(async () => {
    captured = await captureContextPackage(scenario);
  });

  it('is deterministic for the explicit reference instant', () => {
    expect(buildTimeRangeSyntheticScenario()).toEqual(scenario);
    expect(scenario.requested_at).toBe('2026-10-14T16:00:00.000Z');
  });

  it('recognises the message as SHORT_RANGE and starts three complete local days back in Europe/Warsaw', () => {
    const routed = routeUserMessage({
      content: scenario.user_message,
      messages: [],
      conversationId: 'synthetic-scenario',
      requestedAtIso: scenario.requested_at,
      timezone: scenario.timezone,
      hasPhotos: false,
    });
    expect(routed.route).toBe('ANALYSIS');
    if (routed.route !== 'ANALYSIS') return;
    expect(routed.window.rangeType).toBe('SHORT_RANGE');
    // 2026-10-11 00:00 in Europe/Warsaw (CEST, UTC+2): 11, 12 and 13 October in full, then 14 October up to 18:00 local.
    expect(routed.window.rangeStart).toBe('2026-10-10T22:00:00.000Z');
    expect(routed.window.rangeEnd).toBe('2026-10-14T16:00:00.000Z');
    expect(scenario.range_start).toBe(routed.window.rangeStart);
    expect(scenario.range_end).toBe(routed.window.rangeEnd);
  });

  it('keeps today in a 3-day range even when the loop stores IOB/COB snapshots every few minutes', async () => {
    // 2026-10-19: Trio's ~660 snapshots a day filled the 2,600-event limit before today ("z dzisiejszej nocy nie ma
    // odczytów CGM"). Snapshots every 4 minutes over the whole range, as many as in production.
    const withSnapshots = structuredClone(scenario);
    const startMs = Date.parse(scenario.range_start);
    const endMs = Date.parse(scenario.range_end);
    for (let ms = startMs, index = 0; ms < endMs; ms += 4 * 60_000, index += 1) {
      for (const type of ['IOB_SNAPSHOT', 'COB_SNAPSHOT'] as const) {
        withSnapshots.events.push({ ...scenario.events[0], id: `snap-${type}-${index}`, source_record_id: `snap-${type}-${index}`, type: type as any, occurred_at: new Date(ms).toISOString(), payload: { value: 1 } });
      }
    }
    withSnapshots.events.sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));
    expect(withSnapshots.events.length).toBeGreaterThan(2600);
    const { context: snapshotContext } = await captureContextPackage(withSnapshots);
    const glucose = snapshotContext.analytical_evidence.glucose_events as Array<{ occurred_at: string }>;
    const lastReading = scenario.events.filter((event) => event.type === 'GLUCOSE_READING_AVAILABLE').at(-1)!;
    expect(glucose.at(-1)?.occurred_at).toBe(lastReading.occurred_at);
    expect((snapshotContext.analytical_evidence.insulin_treatment_events as Array<{ type: string }>).some((event) => event.type.endsWith('_SNAPSHOT'))).toBe(false);
  });

  it('queries events and hypo episodes with exactly the payload bounds and the documented limits', () => {
    const { repository, context } = captured;
    expect(repository.listPatientEventsByRange).toHaveBeenCalledWith({
      patientId: scenario.patient_id, startAtIso: scenario.range_start, endAtIso: scenario.range_end, limit: 2600, // 650 events per started day: three complete days plus today
      // The loop's IOB/COB snapshots are not read by the analysis; a cut range keeps its latest events.
      excludeTypes: ['IOB_SNAPSHOT', 'COB_SNAPSHOT'],
      keep: 'NEWEST',
    });
    expect(repository.listHypoEpisodesIntersectingRange).toHaveBeenCalledWith({
      // A month with more than 50 episodes keeps the most recent ones.
      patientId: scenario.patient_id, startAtIso: scenario.range_start, endAtIso: scenario.range_end, limit: 50, keep: 'NEWEST',
    });
    expect(context.analysis_request_input).toMatchObject({
      range_type: 'SHORT_RANGE',
      timezone: 'Europe/Warsaw',
      range_start: scenario.range_start,
      range_end: scenario.range_end,
      requested_at: scenario.requested_at,
      user_message_text: scenario.user_message,
    });
  });

  it('classifies every synthetic event into the expected section', () => {
    const evidence = captured.context.analytical_evidence;
    // 792 five-minute slots of the scenario days minus 17 inside the CGM gap, plus 288 of the extra complete day before.
    expect(scenario.glucose_readings).toHaveLength(1063);
    expect(evidence.glucose_events).toHaveLength(1063);
    // The worker files TEMP_BASAL under insulin_treatment_events (existing classification, unchanged here).
    expect(evidence.insulin_treatment_events.map((event: any) => [event.type, event.payload.insulin_units ?? event.payload.rate])).toEqual([
      ['TEMP_BASAL', 0.8], ['BOLUS', 4], ['BOLUS', 2], ['TEMP_BASAL', 0],
    ]);
    expect(evidence.meal_events.map((event: any) => [event.type, event.payload.carbs])).toEqual([['CARB_ENTRY', 45]]);
    expect(evidence.activity_events).toEqual([]);
    expect(evidence.hypo_episodes).toEqual([{
      episode_id: scenario.hypo_episodes[0].id,
      state: 'CLOSED',
      severity: 'L1',
      started_at: scenario.hypo_episodes[0].started_at,
      ended_at: scenario.hypo_episodes[0].ended_at,
      trigger_id: scenario.hypo_episodes[0].trigger_id,
      // No report for this hypo in the scenario.
    }]);
    expect(evidence.summaries).toMatchObject({
      total_events: 1068,
      glucose_count: 1063,
      insulin_treatment_count: 4,
      meal_count: 1,
      activity_count: 0,
      hypo_episode_count: 1,
    });
  });

  it('gives daily insulin totals for each local day, with basal unknown (not zero) without a profile', () => {
    const totals = captured.context.daily_insulin_totals!;
    expect(totals.days.map((day) => [day.date, day.complete])).toEqual([
      ['2026-10-11', true], ['2026-10-12', true], ['2026-10-13', true], ['2026-10-14', false],
    ]);
    expect(totals.days[2]).toMatchObject({ bolus_units: 6, bolus_count: 2, smb_units: 0, status: 'BASAL_UNKNOWN', basal_units: null, total_units: null });
    expect(totals.days[2].basal_minutes.temp_basal).toBe(75);
    expect(totals.complete_day_average).toBeNull();
  });

  it('computes the glucose aggregates from the readings', () => {
    const values = scenario.glucose_readings.map((reading) => reading.glucose_value);
    const expectedAvg = Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
    expect(captured.context.analytical_evidence.summaries).toMatchObject({
      glucose_min: 55,
      glucose_max: 210,
      glucose_avg: expectedAvg,
    });
  });

  it('computes time in range from the readings, so a TIR question gets a number and not just the average', () => {
    const values = scenario.glucose_readings.map((reading) => reading.glucose_value);
    const inTarget = values.filter((value) => value >= 70 && value <= 180).length;
    const tir = captured.context.analytical_evidence.summaries.glucose_time_in_range;
    expect(tir).toMatchObject({ target_mg_dl: { low: 70, high: 180 }, readings_count: values.length });
    expect(tir.in_range_percent).toBeCloseTo((inTarget * 100) / values.length, 1);
    expect(tir.below_range_percent).toBeGreaterThan(0);
  });

  it('reports only activity as a missing section', () => {
    expect(captured.context.analytical_evidence.summaries.missing_sections).toEqual(['activity_events']);
  });

  it('keeps the CGM gap observable in the raw glucose evidence of the context_package', () => {
    const times = captured.context.analytical_evidence.glucose_events.map((event: any) => event.occurred_at);
    const before = times.indexOf(scenario.cgm_gap.last_reading_before);
    expect(before).toBeGreaterThan(-1);
    expect(times[before + 1]).toBe(scenario.cgm_gap.first_reading_after);
    expect(Date.parse(times[before + 1]) - Date.parse(times[before])).toBe(90 * 60 * 1000);
  });

  it('carries no therapy profile or basal schedule in the context_package or the default AI prompt', () => {
    const { context } = captured;
    expect(context.current_state_snapshot).toBeNull();
    const contextText = JSON.stringify(context);
    expect(contextText).not.toContain('basal_schedule');
    expect(contextText).not.toContain('active_therapy');

    const prompt = buildTimeRangeAnalysisPrompt(
      createConversationTimeRangeAnalysisTask({
        task_id: 'synthetic-task-1',
        context_package_id: context.context_package_id,
        context_package_version: context.context_package_version,
        context_package_hash: context.content_hash,
        correlation_id: CONVERSATION_ID,
        created_at: SYNTHETIC_SCENARIO_REFERENCE_REQUESTED_AT,
      }),
      context,
    );
    // The prompt now carries the recorded temp basal rates (0.8 and 0 U/h); what must never appear is a schedule or
    // the former placeholder rates, and the profile must be stated as absent rather than defaulted.
    expect(prompt.user_payload).not.toContain('basal_schedule');
    expect(prompt.user_payload).not.toMatch(/"rate":0\.(4|6)\b/);
    const payload = JSON.parse(prompt.user_payload);
    expect(payload.temporal_evidence.therapy_profile.status).toBe('NOT_IN_CONTEXT');
    expect(JSON.stringify(payload.temporal_evidence)).not.toMatch(/"(icr|isf|target|dia|planned_basal)"/);
  });

  describe('default AI prompt temporal_evidence (tool calling disabled)', () => {
    const defaultPrompt = (context: TimeRangeAnalysisContextRecord) => buildTimeRangeAnalysisPrompt(
      createConversationTimeRangeAnalysisTask({
        task_id: 'synthetic-task-1',
        context_package_id: context.context_package_id,
        context_package_version: context.context_package_version,
        context_package_hash: context.content_hash,
        correlation_id: CONVERSATION_ID,
        created_at: SYNTHETIC_SCENARIO_REFERENCE_REQUESTED_AT,
      }),
      context,
    );
    const at = (minute: number) => new Date(Date.parse(scenario.scenario_start) + minute * 60_000).toISOString();
    const ref = (eventType: string, index: number) => scenario.events.filter((event) => event.type === eventType)[index].source_record_id;

    it('gives the model the time in range of the whole range', () => {
      const payload = JSON.parse(defaultPrompt(captured.context).user_payload);
      expect(payload.selected_evidence.glucose.time_in_range).toEqual(captured.context.analytical_evidence.summaries.glucose_time_in_range);
    });

    // Fixed (was KNOWN DEFECT, audit 2026-10-14): the default prompt carried only aggregates.
    it('lets the model locate the CGM gap and the hypo episode', () => {
      const prompt = defaultPrompt(captured.context);
      expect(prompt.user_payload).toContain(scenario.cgm_gap.last_reading_before);
      expect(prompt.user_payload).toContain(scenario.cgm_gap.first_reading_after);
      expect(prompt.user_payload).toContain(scenario.hypo_episodes[0].started_at);
    });

    it('lists treatments, meals, hypo, glucose anchors and CGM gaps in time order with local times and sources', () => {
      const temporal = JSON.parse(defaultPrompt(captured.context).user_payload).temporal_evidence;
      expect(temporal.timezone).toBe('Europe/Warsaw');

      expect(temporal.insulin_treatment_events).toEqual({
        total_count: 4,
        refs_status: 'COMPLETE',
        events: [
          { type: 'TEMP_BASAL', occurred_at: at(SYNTHETIC_SCENARIO_MOMENTS.tempBasalMorning), local_time: '2026-10-13 06:30', rate: 0.8, absolute: 0.8, duration_minutes: 45, provenance_ref: ref('TEMP_BASAL', 0) },
          { type: 'BOLUS', occurred_at: at(SYNTHETIC_SCENARIO_MOMENTS.bolusMeal), local_time: '2026-10-13 07:45', insulin_units: 4, provenance_ref: ref('BOLUS', 0) },
          { type: 'BOLUS', occurred_at: at(SYNTHETIC_SCENARIO_MOMENTS.correctionBolus), local_time: '2026-10-13 11:00', insulin_units: 2, provenance_ref: ref('BOLUS', 1) },
          { type: 'TEMP_BASAL', occurred_at: at(SYNTHETIC_SCENARIO_MOMENTS.tempBasalSuspend), local_time: '2026-10-13 11:45', rate: 0, absolute: 0, duration_minutes: 30, provenance_ref: ref('TEMP_BASAL', 1) },
        ],
      });
      expect(temporal.meal_events).toEqual({
        total_count: 1,
        refs_status: 'COMPLETE',
        events: [{ type: 'CARB_ENTRY', occurred_at: at(SYNTHETIC_SCENARIO_MOMENTS.carbs), local_time: '2026-10-13 08:00', carbs: 45, provenance_ref: ref('CARB_ENTRY', 0) }],
      });
      expect(temporal.activity_events).toEqual({ total_count: 0, refs_status: 'EMPTY', events: [] });

      expect(temporal.hypo_episodes).toEqual([{
        episode_id: scenario.hypo_episodes[0].id,
        severity: 'L1',
        state: 'CLOSED',
        started: { occurred_at: scenario.hypo_episodes[0].started_at, local_time: '2026-10-13 11:40' },
        ended: { occurred_at: scenario.hypo_episodes[0].ended_at, local_time: '2026-10-13 12:20' },
        lowest_observed_reading: expect.objectContaining({ glucose_value: 55, local_time: '2026-10-13 11:50', unit: 'mg/dL' }),
        }]);

      expect(temporal.glucose_anchors).toMatchObject({
        first_reading: { occurred_at: scenario.range_start, local_time: '2026-10-11 00:00' },
        last_reading: { occurred_at: scenario.glucose_readings.at(-1)!.occurred_at },
        lowest_reading_first_observed: { glucose_value: 55, local_time: '2026-10-13 11:50' },
        highest_reading_first_observed: { glucose_value: 210, local_time: '2026-10-13 09:30' },
      });

      expect(temporal.cgm_coverage).toEqual({
        status: 'PARTIAL',
        range: { from: scenario.range_start, to: scenario.range_end },
        covered_range: { from: scenario.range_start, to: scenario.glucose_readings.at(-1)!.occurred_at },
        gaps: [{ from: scenario.cgm_gap.last_reading_before, to: scenario.cgm_gap.first_reading_after }],
        gap_threshold_minutes: 15,
      });
      expect(temporal.semantics.chronological_order_only).toMatch(/no causal/);
    });

    it('does not send the raw CGM series, stays small and is deterministic', () => {
      const first = defaultPrompt(captured.context);
      const second = defaultPrompt(captured.context);
      expect(second.user_payload).toBe(first.user_payload);
      expect(second.system_instructions).toBe(first.system_instructions);
      // 775 readings in context; only the 4 glucose anchors and the hypo's lowest reading reach the prompt.
      expect(first.user_payload.match(/"glucose_value"/g)).toHaveLength(5);
      expect(Buffer.byteLength(first.user_payload, 'utf8')).toBeLessThan(12_000);
    });

    it('lists a group only up to the compact-view limit and otherwise reports just its count', () => {
      const manySmb = Array.from({ length: 40 }, (_, index) => ({
        event_id: `smb-${index}`,
        type: 'SMB',
        occurred_at: at(SYNTHETIC_SCENARIO_MOMENTS.recovered + index * 5),
        payload: { insulin_units: 0.1 },
        source_record_id: `smb-source-${index}`,
      }));
      const context = {
        ...captured.context,
        analytical_evidence: { ...captured.context.analytical_evidence, insulin_treatment_events: manySmb },
      } as TimeRangeAnalysisContextRecord;
      const prompt = defaultPrompt(context);
      const temporal = JSON.parse(prompt.user_payload).temporal_evidence;
      expect(temporal.insulin_treatment_events).toEqual({ total_count: 40, refs_status: 'OMITTED_DUE_TO_BUDGET', events: [] });
      expect(Buffer.byteLength(prompt.user_payload, 'utf8')).toBeLessThan(12_000);
    });

    it('passes the OpenAI provider evidence-delivery validation', () => {
      expect(() => validateAiEvidenceDeliveryEnvelope(defaultPrompt(captured.context).user_payload, 'CONVERSATION_TIME_RANGE_ANALYSIS')).not.toThrow();
    });

    it('states a missing therapy profile instead of defaulting one', () => {
      const temporal = JSON.parse(defaultPrompt(captured.context).user_payload).temporal_evidence;
      expect(temporal.therapy_profile).toEqual({
        status: 'NOT_IN_CONTEXT',
        note: 'This context carries no therapy profile: planned basal, carb ratio, sensitivity and targets are unknown.',
      });
    });
  });

  // Fixed (was KNOWN DEFECT, audit 2026-10-14): coverage used to report gaps only at the window edges, so the 90-minute
  // CGM gap inside the day came back as fully KNOWN coverage.
  it('get_glucose_evidence reports the interior CGM gap, bounded by the observed readings, as partial coverage', async () => {
    // DETAIL covers at most 6 h per request: a window of 2 h on each side of the outage.
    const from = new Date(Date.parse(scenario.cgm_gap.last_reading_before) - 2 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.parse(scenario.cgm_gap.first_reading_after) + 2 * 60 * 60 * 1000).toISOString();
    const results = await collectToolResults(captured.context, [{ tool: 'get_glucose_evidence', from, to }]);
    const glucose = results.get('get_glucose_evidence')!;
    expect(glucose.status).toBe('KNOWN');
    // The window is covered from its first to its last reading; only the outage is a gap.
    expect(glucose.coverage).toEqual({
      status: 'PARTIAL',
      range: { from, to },
      covered_range: { from, to },
      gaps: [{ from: scenario.cgm_gap.last_reading_before, to: scenario.cgm_gap.first_reading_after }],
    });
  });

  // Fixed (was KNOWN DEFECT, audit 2026-10-14): the gateway's tool context used to inject a hard-coded therapy snapshot
  // (basal 0.4/0.6 U/h). The scenario has no therapy profile: therapy evidence is MISSING and basal evidence carries
  // only the recorded temp basal (PARTIAL_DATA), never a planned basal.
  it('tool-loop basal and therapy evidence report the unreadable profile instead of an invented basal schedule', async () => {
    const results = await collectToolResults(captured.context, [
      { tool: 'get_basal_evidence', from: yesterdayFrom, to: yesterdayTo },
      { tool: 'get_therapy_profile', from: yesterdayFrom, to: yesterdayTo },
    ]);
    expect(results.size).toBe(2);

    // The synthetic repository has no therapy lookup: the profile could not be read, so it is unknown (not "none set").
    const therapy = results.get('get_therapy_profile')!;
    expect(therapy.status).toBe('UNKNOWN');
    expect(therapy.evidence).toEqual({ profile_id: null, planned_basal: null, icr: null, isf: null, target: null, dia: null });
    expect(therapy.coverage).toEqual({ status: 'UNKNOWN', range: { from: yesterdayFrom, to: yesterdayTo }, covered_range: null, gaps: [{ from: yesterdayFrom, to: yesterdayTo }] });
    expect(therapy.limitations.join(' ')).toContain('could not be read');

    const basal = results.get('get_basal_evidence')!;
    expect(basal.status).toBe('PARTIAL_DATA');
    expect(basal.evidence.planned_basal).toBeNull();
    expect(basal.evidence.summary).toEqual({ planned_intervals: 0, temp_intervals: 2 });

    const text = JSON.stringify([...results.values()]);
    expect(text).not.toMatch(/"rate":0\.(4|6)\b/);
    expect(text).not.toContain('time-range-context-therapy');
    expect(text).not.toContain('time-range-context-profile');
  });

  it('reads each bolus once, with its dose from the event payload, and totals 6 U for the day', async () => {
    const results = await collectToolResults(captured.context, [{ tool: 'get_insulin_evidence', from: yesterdayFrom, to: yesterdayTo }]);
    const insulin = results.get('get_insulin_evidence')!;
    const boluses = scenario.events.filter((event) => event.type === 'BOLUS');

    expect(insulin.status).toBe('KNOWN');
    // Provider copy: type, dose and time per bolus; the unit once; the per-event refs as a verifiable digest.
    expect(insulin.evidence.events.map((event: any) => [event.event_type, event.amount, event.occurred_at])).toEqual([
      ['BOLUS', 4, minuteIso(boluses[0].occurred_at)],
      ['BOLUS', 2, minuteIso(boluses[1].occurred_at)],
    ]);
    expect(insulin.evidence.events_unit).toBe('U');
    expect(insulin.evidence.events_refs).toEqual(recordRefDigest(boluses.map((event) => event.source_record_id)));
    expect(insulin.evidence.summary).toEqual({
      total_bolus_insulin: 6,
      total_smb_insulin: 0,
      total_insulin: 6,
      bolus_count: 2,
      smb_count: 0,
      event_count: 2,
      first_event: boluses[0].occurred_at,
      last_event: boluses[1].occurred_at,
    });
    expect(insulin.coverage).toMatchObject({ status: 'KNOWN', covered_range: { from: boluses[0].occurred_at, to: boluses[1].occurred_at } });
    expect(insulin.provenance).toMatchObject(sourceRefDigest(boluses.map((event) => event.source_record_id)));
    expect(insulin.limitations.join(' ')).not.toContain('dose is unknown');
  });

  it('reads each recorded TEMP_BASAL once, with its rate, start and duration from the event payload', async () => {
    const results = await collectToolResults(captured.context, [{ tool: 'get_basal_evidence', from: yesterdayFrom, to: yesterdayTo }]);
    const basal = results.get('get_basal_evidence')!;
    const at = (minute: number) => new Date(Date.parse(scenario.scenario_start) + minute * 60_000).toISOString();
    const tempEvents = scenario.events.filter((event) => event.type === 'TEMP_BASAL');

    expect(basal.evidence.actual_temp_basal).toEqual([
      { type: 'TEMP_BASAL', start: minuteIso(at(SYNTHETIC_SCENARIO_MOMENTS.tempBasalMorning)), end: minuteIso(at(SYNTHETIC_SCENARIO_MOMENTS.tempBasalMorning + 45)), rate: 0.8, status: 'VALID' },
      { type: 'TEMP_BASAL', start: minuteIso(at(SYNTHETIC_SCENARIO_MOMENTS.tempBasalSuspend)), end: minuteIso(at(SYNTHETIC_SCENARIO_MOMENTS.tempBasalSuspend + 30)), rate: 0, status: 'VALID' },
    ]);
    expect(basal.evidence.actual_temp_basal_unit).toBe('U/h');
    expect(basal.evidence.actual_temp_basal_refs).toEqual(recordRefDigest(tempEvents.map((event) => event.source_record_id)));
    expect(basal.provenance).toMatchObject(sourceRefDigest(tempEvents.map((event) => event.source_record_id)));
    expect(basal.coverage).toMatchObject({ status: 'KNOWN', covered_range: { from: tempEvents[0].occurred_at, to: tempEvents[1].occurred_at } });
    expect(basal.limitations.join(' ')).not.toContain('rate is unknown');
  });

  it('places the scenario moments at the intended local wall-clock times (Europe/Warsaw, CEST)', () => {
    const local = (iso: string) => new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
    const at = (minute: number) => new Date(Date.parse(scenario.scenario_start) + minute * 60_000).toISOString();
    expect(local(at(SYNTHETIC_SCENARIO_MOMENTS.carbs))).toBe('13.10.2026, 08:00');
    expect(local(scenario.hypo_episodes[0].started_at)).toBe('13.10.2026, 11:40');
    expect(local(scenario.cgm_gap.last_reading_before)).toBe('13.10.2026, 15:00');
    expect(local(scenario.cgm_gap.first_reading_after)).toBe('13.10.2026, 16:30');
  });
});

describe('cost path of "Co było wczoraj największym problemem?" (synthetic scenario, offline)', () => {
  const base = buildTimeRangeSyntheticScenario();
  const scenario = { ...base, user_message: 'Co było wczoraj największym problemem?' };
  const yesterdayFrom = new Date(Date.parse(scenario.scenario_start) + DAY_MS).toISOString();
  const yesterdayTo = new Date(Date.parse(scenario.scenario_start) + 2 * DAY_MS).toISOString();
  let context: TimeRangeAnalysisContextRecord;

  beforeAll(async () => {
    context = (await captureContextPackage(scenario)).context;
  });

  /** Real gateway in tool-loop mode with a scripted "model": each step is a tool request or the final answer. */
  async function runLoop(steps: Array<{ tool: string; from: string; to: string; detail: string } | 'ANSWER' | Error>) {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    try {
      const inputs: AiProviderInput[] = [];
      const gateway = new AiGatewayService(new StubProvider(async (input) => {
        inputs.push(input);
        const step = steps[inputs.length - 1];
        if (step instanceof Error) throw step;
        if (step && step !== 'ANSWER') {
          return {
            provider: 'fake', model: 'deterministic-hypo-v1', response_id: `resp-${inputs.length}`, received_at: new Date().toISOString(), raw_output: {},
            tool_call: { call_id: `call-${inputs.length}`, tool_name: step.tool, arguments: { time_range: { from: step.from, to: step.to }, detail_level: step.detail } },
          };
        }
        return { provider: 'fake', model: 'deterministic-hypo-v1', response_id: `resp-${inputs.length}`, received_at: new Date().toISOString(), raw_output: { assistant_message: 'Odpowiedź.' } };
      }));
      const execution = await gateway.execute({
        task: createConversationTimeRangeAnalysisTask({
          task_id: 'synthetic-cost-task', context_package_id: context.context_package_id, context_package_version: context.context_package_version,
          context_package_hash: context.content_hash, correlation_id: CONVERSATION_ID, created_at: SYNTHETIC_SCENARIO_REFERENCE_REQUESTED_AT,
        }),
        context_package: context,
        timeout_ms: 5_000,
      }).then((result) => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error }));
      return { inputs, execution };
    } finally {
      vi.unstubAllEnvs();
    }
  }
  const payloadOf = (input: AiProviderInput) => JSON.parse(input.prompt.user_payload) as Record<string, any>;
  const hasSourceRefList = (value: unknown, path: string[] = []): boolean => {
    if (Array.isArray(value)) return value.some((entry) => hasSourceRefList(entry, path));
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value as Record<string, unknown>).some(([key, entry]) => (key === 'source_refs' && Array.isArray(entry)) || hasSourceRefList(entry, [...path, key]));
  };

  it('is answered in one provider call from deterministic daily summaries of glucose, insulin and meals', async () => {
    const { inputs, execution } = await runLoop(['ANSWER']);
    expect(execution.ok).toBe(true);
    expect(inputs).toHaveLength(1);

    expect(payloadOf(inputs[0]).daily_insulin_totals.days).toHaveLength(4);
    expect(inputs[0].prompt.system_instructions).toContain('answered from daily_insulin_totals');
    const precomputed = payloadOf(inputs[0]).tool_loop_state.precomputed_daily_evidence;
    expect(precomputed).toMatchObject({ policy_version: 'precomputed-daily-evidence.v1', detail_level: 'SUMMARY' });
    // Local days: three complete ones, then today up to the request.
    expect(precomputed.days.map((day: any) => day.window)).toEqual([
      { from: scenario.range_start, to: scenario.scenario_start },
      { from: scenario.scenario_start, to: yesterdayFrom },
      { from: yesterdayFrom, to: yesterdayTo },
      { from: yesterdayTo, to: new Date(Date.parse(scenario.range_end)).toISOString() },
    ]);
    // The question is about yesterday: full summaries for that day, glucose only for the other days.
    expect(precomputed.days.map((day: any) => day.in_focus)).toEqual([false, false, true, false]);
    expect(precomputed.days.map((day: any) => day.domains.map((domain: any) => domain.tool))).toEqual([
      ['get_glucose_evidence'],
      ['get_glucose_evidence'],
      ['get_glucose_evidence', 'get_insulin_evidence', 'get_meal_evidence'],
      ['get_glucose_evidence'],
    ]);
    // Each insulin/meal event once (no significant_events copy of the same events).
    for (const domain of precomputed.days[2].domains.slice(1)) expect(domain.evidence).not.toHaveProperty('significant_events');
    // Clinical evidence of yesterday is kept: glucose summary, significant periods, coverage (with the CGM gap), boluses.
    const [glucose, insulin] = precomputed.days[2].domains;
    expect(glucose.evidence.summary.observation_count).toBeGreaterThan(0);
    expect(Array.isArray(glucose.evidence.significant_periods)).toBe(true);
    expect(glucose.coverage).toHaveProperty('gaps');
    expect(insulin.evidence.summary).toMatchObject({ total_bolus_insulin: 6, bolus_count: 2 });
    // Provenance stays as counts and hashes, never as the full per-reading lists.
    expect(hasSourceRefList(precomputed)).toBe(false);
    expect(glucose.evidence.summary.provenance.source_ref_count).toBe(glucose.evidence.summary.observation_count);

    // No second copy of the tool definitions and no list of opaque source ids in the first request.
    const firstPayload = payloadOf(inputs[0]);
    expect(firstPayload.tool_loop_state.initial_evidence_view).not.toHaveProperty('tools_available');
    expect(firstPayload.provenance_summary).toEqual({ source_ref_count: expect.any(Number), selection_policy_version: expect.any(String) });

    // The instruction no longer demands every evidence domain before answering.
    expect(inputs[0].prompt.system_instructions).not.toContain('Before asserting likely causes, retrieve required evidence domains');
    expect(inputs[0].prompt.system_instructions).toContain('never treat it as the absence of an event');
  });

  it('still delivers exact glucose readings when a detailed question needs them, without resending the prompt', async () => {
    // A 6-hour window around the hypo (DETAIL covers at most 6 h per request).
    const detailFrom = new Date(Date.parse(scenario.hypo_episodes[0].started_at) - 4 * 60 * 60 * 1000).toISOString();
    const detailTo = new Date(Date.parse(scenario.hypo_episodes[0].started_at) + 2 * 60 * 60 * 1000).toISOString();
    const { inputs, execution } = await runLoop([{ tool: 'get_glucose_evidence', from: detailFrom, to: detailTo, detail: 'DETAIL' }, 'ANSWER']);
    expect(execution.ok).toBe(true);
    expect(inputs).toHaveLength(2);
    // Second turn: intact chain, so only the new tool output is sent (no repeated system/user prompt).
    expect(inputs[1].previous_response_id).toBe('resp-1');
    expect(inputs[1].chained_prompt).toEqual({ additional_system_instructions: null });
    expect(inputs[1].tool_runtime?.tool_results).toHaveLength(1);
    const detail = inputs[1].tool_runtime!.tool_results[0].result as Record<string, any>;
    const readings = scenario.events.filter((event) => event.type === 'GLUCOSE_READING_AVAILABLE' && inRange(event.occurred_at, detailFrom, detailTo));
    // Every reading of the window as [time, mg/dL]; the per-reading refs as a digest.
    expect(detail.evidence.detail_window.readings).toHaveLength(readings.length);
    expect(detail.evidence.detail_window.readings[0]).toEqual([minuteIso(readings[0].occurred_at), readings[0].payload.glucose_value]);
    expect(detail.evidence.detail_window.reading_refs.count).toBe(readings.length);
    expect(hasSourceRefList(detail)).toBe(false);
  });

  it('summarizes a week for a pattern question: glucose for every day, full detail only for the day in focus', async () => {
    const { buildPrecomputedDailyEvidence } = await import('@modules/ai-gateway/application/ai-gateway.service');
    const { createEvidenceToolRegistry } = await import('@modules/evidence-tools');
    const week = structuredClone(context);
    week.analysis_request_input.range_type = 'MEDIUM_RANGE';
    week.analysis_request_input.range_start = new Date(Date.parse(scenario.range_start) - 4 * DAY_MS).toISOString();
    week.analysis_request_input.user_message_text = 'Czy to jest powtarzający się wzorzec?';
    week.conversation_context.messages = [{ message_id: 'm1', role: 'USER', created_at: scenario.requested_at, content: 'Przeanalizuj mi wczorajszy dzień pod kątem hipoglikemii', provenance_ref: 'p' }];
    const evidence = buildPrecomputedDailyEvidence({ task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' } as any, context: week, toolContext: { patient_ref: week.patient_ref, glucose_evidence: [] }, registry: createEvidenceToolRegistry() })!;
    // Seven complete days plus today.
    expect(evidence.days).toHaveLength(8);
    expect(evidence.days.map((day) => day.in_focus)).toEqual([false, false, false, false, false, false, true, false]);
    expect(evidence.days.map((day) => day.domains.length)).toEqual([1, 1, 1, 1, 1, 1, 3, 1]);

    // Without a named day, a week gets glucose summaries only (full detail for every day would be too large).
    week.conversation_context.messages = [];
    const unfocused = buildPrecomputedDailyEvidence({ task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' } as any, context: week, toolContext: { patient_ref: week.patient_ref, glucose_evidence: [] }, registry: createEvidenceToolRegistry() })!;
    expect(unfocused.days.every((day) => !day.in_focus && day.domains.length === 1)).toBe(true);
  });

  it('puts a named weekday or calendar date in focus, counted from the question time', async () => {
    const { buildPrecomputedDailyEvidence } = await import('@modules/ai-gateway/application/ai-gateway.service');
    const { createEvidenceToolRegistry } = await import('@modules/evidence-tools');
    const week = structuredClone(context);
    week.analysis_request_input.range_type = 'MEDIUM_RANGE';
    week.analysis_request_input.range_start = new Date(Date.parse(scenario.range_start) - 4 * DAY_MS).toISOString();
    week.conversation_context.messages = [];
    const focusOf = (question: string) => {
      week.analysis_request_input.user_message_text = question;
      return buildPrecomputedDailyEvidence({ task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' } as any, context: week, toolContext: { patient_ref: week.patient_ref, glucose_evidence: [] }, registry: createEvidenceToolRegistry() })!
        .days.map((day) => day.in_focus);
    };
    // Asked on Wednesday 14 October; the days are 7–14 October.
    expect(focusOf('W piątek była hipo?')).toEqual([false, false, true, false, false, false, false, false]);
    expect(focusOf('Porównaj 12 i 13 października')).toEqual([false, false, false, false, false, true, true, false]);
  });

  it('prefetch: a hypo question puts the days with an episode in focus, with glucose significant events', async () => {
    const { buildPrecomputedDailyEvidence } = await import('@modules/ai-gateway/application/ai-gateway.service');
    const { createEvidenceToolRegistry } = await import('@modules/evidence-tools');
    const week = structuredClone(context);
    week.analysis_request_input.range_type = 'MEDIUM_RANGE';
    week.analysis_request_input.range_start = new Date(Date.parse(scenario.range_start) - 4 * DAY_MS).toISOString();
    week.analysis_request_input.user_message_text = 'Przeanalizuj mi ostatnie 7 dni pod kątem hipoglikemii';
    week.conversation_context.messages = [];
    const build = (prefetch: boolean) => buildPrecomputedDailyEvidence({ task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' } as any, context: week, toolContext: { patient_ref: week.patient_ref, glucose_evidence: [] }, registry: createEvidenceToolRegistry(), prefetch })!;
    // Off: no day named, a week gets glucose summaries only.
    expect(build(false).days.every((day) => !day.in_focus)).toBe(true);
    const evidence = build(true);
    expect(evidence.detail_level).toBe('SUMMARY_WITH_SIGNIFICANT_EVENTS');
    // The scenario's only hypo is yesterday: that day gets glucose, insulin and meals, the others glucose only.
    expect(evidence.days.map((day) => day.in_focus)).toEqual([false, false, false, false, false, false, true, false]);
    expect(evidence.days[6].domains.map((domain) => domain.tool)).toEqual(['get_glucose_evidence', 'get_insulin_evidence', 'get_meal_evidence']);

    // Another question: prefetch changes only the glucose detail of the days in focus.
    week.analysis_request_input.user_message_text = 'Jak wyglądał cukier w ostatnich 7 dniach?';
    expect(build(true).days.every((day) => !day.in_focus)).toBe(true);
  });

  it('prefetch: a question about lows gets the insulin before each hypo without becoming a causal question', async () => {
    const original = context;
    context = structuredClone(original);
    context.analysis_request_input.user_message_text = 'Kiedy były spadki cukru?';
    try {
      const off = await runLoop(['ANSWER']);
      expect(payloadOf(off.inputs[0]).tool_loop_state).not.toHaveProperty('pre_hypo_evidence');

      vi.stubEnv('AI_TIME_RANGE_PREFETCH', '1');
      const on = await runLoop(['ANSWER']);
      expect(on.execution.ok).toBe(true);
      expect(payloadOf(on.inputs[0]).tool_loop_state.pre_hypo_evidence).toMatchObject({ policy_version: 'pre-hypo-evidence.v1' });
      expect(on.inputs[0].prompt.system_instructions).toContain('holds boluses/SMBs and basal');
      expect(on.inputs[0].prompt.system_instructions).not.toContain('This is a question about causes');
      expect(on.inputs[0].prompt.system_instructions).toContain('Never present a single cause as established.');
      // Same model tier as without the prefetch.
      expect(on.inputs[0].model_tier).toBe(off.inputs[0].model_tier);
    } finally {
      context = original;
    }
  });

  it('reads tool time ranges given as local times with an offset', async () => {
    const local = (iso: string) => new Date(Date.parse(iso) + 2 * 60 * 60 * 1000).toISOString().slice(0, 16) + '+02:00';
    const { inputs, execution } = await runLoop([{ tool: 'get_glucose_evidence', from: local(yesterdayFrom), to: local(yesterdayTo), detail: 'TRAJECTORY' }, 'ANSWER']);
    expect(execution.ok).toBe(true);
    const result = inputs[1].tool_runtime!.tool_results[0].result as Record<string, any>;
    expect(result.requested_range).toEqual({ from: new Date(Date.parse(local(yesterdayFrom))).toISOString(), to: new Date(Date.parse(local(yesterdayTo))).toISOString() });
    expect(Date.parse(result.requested_range.from)).toBe(Date.parse(yesterdayFrom));
  });

  it('asks the model to narrow a whole-day glucose DETAIL request instead of sending every reading of the day', async () => {
    const { inputs, execution } = await runLoop([{ tool: 'get_glucose_evidence', from: yesterdayFrom, to: yesterdayTo, detail: 'TRAJECTORY' }, 'ANSWER']);
    expect(execution.ok).toBe(true);
    const result = inputs[1].tool_runtime!.tool_results[0].result as Record<string, any>;
    expect(result).toMatchObject({ status: 'REQUEST_TOO_WIDE', requested_range: { from: yesterdayFrom, to: yesterdayTo } });
    expect(result.limitations.join(' ')).toContain('at most 6 hours');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1_000);
  });

  it('asks the model to narrow a summary over the whole range instead of failing the answer', async () => {
    // "Podaj staty z ostatnich 14 dni": a summary of the whole range is wider than one tool request (24 h).
    const { inputs, execution } = await runLoop([{ tool: 'get_glucose_evidence', from: scenario.range_start, to: scenario.range_end, detail: 'SUMMARY' }, 'ANSWER']);
    expect(execution.ok).toBe(true);
    const result = inputs[1].tool_runtime!.tool_results[0].result as Record<string, any>;
    expect(result).toMatchObject({ status: 'REQUEST_TOO_WIDE', requested_range: { from: scenario.range_start, to: scenario.range_end } });
    expect(result.limitations.join(' ')).toContain('at most 24 hours');
  });

  it('answers a request for a summary already in the daily summaries without running the tool again', async () => {
    const { inputs, execution } = await runLoop([{ tool: 'get_glucose_evidence', from: yesterdayFrom, to: yesterdayTo, detail: 'SIGNIFICANT_EVENTS' }, 'ANSWER']);
    expect(execution.ok).toBe(true);
    const result = inputs[1].tool_runtime!.tool_results[0].result as Record<string, any>;
    expect(result.status).toBe('ALREADY_PROVIDED');
    expect(result.limitations.join(' ')).toContain('precomputed_daily_evidence');
  });

  it('gives every tool request its own audit sequence, also after a request answered from the daily summaries', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    try {
      const steps = [
        { tool: 'get_glucose_evidence', from: yesterdayFrom, to: yesterdayTo, detail: 'SIGNIFICANT_EVENTS' },
        { tool: 'get_glucose_evidence', from: yesterdayFrom, to: new Date(Date.parse(yesterdayFrom) + 6 * 60 * 60 * 1000).toISOString(), detail: 'TRAJECTORY' },
      ];
      let call = 0;
      const gateway = new AiGatewayService(new StubProvider(async () => {
        const step = steps[call++];
        return step
          ? { provider: 'fake', model: 'deterministic-hypo-v1', response_id: `resp-${call}`, received_at: new Date().toISOString(), raw_output: {}, tool_call: { call_id: `call-${call}`, tool_name: step.tool, arguments: { time_range: { from: step.from, to: step.to }, detail_level: step.detail } } }
          : { provider: 'fake', model: 'deterministic-hypo-v1', response_id: `resp-${call}`, received_at: new Date().toISOString(), raw_output: { assistant_message: 'Odpowiedź.' } };
      }));
      const requested: number[] = [];
      const completed: Array<[number, string]> = [];
      await gateway.execute({
        task: createConversationTimeRangeAnalysisTask({
          task_id: 'synthetic-sequence-task', context_package_id: context.context_package_id, context_package_version: context.context_package_version,
          context_package_hash: context.content_hash, correlation_id: CONVERSATION_ID, created_at: SYNTHETIC_SCENARIO_REFERENCE_REQUESTED_AT,
        }),
        context_package: context,
        timeout_ms: 5_000,
        evidence_session_observer: {
          onSessionStarted: async () => {},
          onToolCallRequested: async (args: any) => { requested.push(args.sequence); },
          onToolCallSucceeded: async (args: any) => { completed.push([args.sequence, 'SUCCEEDED']); },
          onToolCallFailed: async (args: any) => { completed.push([args.sequence, String(args.failure.reason)]); },
        } as any,
      });
      expect(requested).toEqual([1, 2]);
      expect(completed).toEqual([[1, 'ALREADY_PROVIDED'], [2, 'SUCCEEDED']]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('runs every turn of an analysis on the main model', async () => {
    const step = { tool: 'get_glucose_evidence', from: yesterdayFrom, to: new Date(Date.parse(yesterdayFrom) + 6 * 60 * 60 * 1000).toISOString(), detail: 'DETAIL' };
    const { inputs, execution } = await runLoop([step, 'ANSWER']);
    expect(execution.ok).toBe(true);
    expect(inputs.map((input) => input.model_tier)).toEqual(['DEEP', 'DEEP']);
  });

  it('keeps the tool definitions on the forced final turn and forbids calls with tool_choice none', async () => {
    const step = (tool: string) => ({ tool, from: yesterdayFrom, to: yesterdayTo, detail: 'SUMMARY' });
    const { inputs, execution } = await runLoop([step('get_glucose_evidence'), step('get_insulin_evidence'), step('get_meal_evidence'), 'ANSWER']);
    expect(execution.ok).toBe(true);
    expect(inputs).toHaveLength(4);
    expect(inputs[3].tool_runtime?.tool_choice).toBe('none');
    expect(inputs[3].tool_runtime?.available_tools).toEqual(inputs[0].tool_runtime?.available_tools);
    // Each tool output is sent once across the whole loop.
    expect(inputs.map((input) => (input.tool_runtime?.tool_results ?? []).map((entry) => entry.call_id))).toEqual([[], ['call-1'], ['call-2'], ['call-3']]);
  });

  it('fails a retryable provider error mid-loop as retryable and never as a partial success', async () => {
    const { AiExecutionError } = await import('@modules/ai-gateway/domain/ai-gateway');
    const { inputs, execution } = await runLoop([
      { tool: 'get_glucose_evidence', from: yesterdayFrom, to: yesterdayTo, detail: 'SUMMARY' },
      new AiExecutionError('Provider unavailable', 'AI_PROVIDER_RETRYABLE', true),
    ]);
    expect(execution.ok).toBe(false);
    expect(execution.ok ? null : execution.error).toMatchObject({ retryable: true });
    expect(inputs).toHaveLength(2);
  });
});

describe('causal hypo question: pre-hypo insulin and basal evidence (synthetic scenario, offline)', () => {
  const scenario = buildTimeRangeSyntheticScenario();
  const CAUSAL_QUESTION = 'Co spowodowało tę hipoglikemię?';
  let baseContext: TimeRangeAnalysisContextRecord;
  // Minutes from the range start (window clipping is relative to it).
  const at = (minute: number) => new Date(Date.parse(scenario.range_start) + minute * 60_000).toISOString();

  beforeAll(async () => {
    baseContext = (await captureContextPackage(scenario)).context;
  });

  const contextWith = (overrides: { text?: string; therapy?: TimeRangeAnalysisContextRecord['therapy_context'] | null; hypoStarts?: string[]; truncated?: boolean; selectedFrom?: string }) => {
    const context = structuredClone(baseContext);
    context.analysis_request_input.user_message_text = overrides.text ?? CAUSAL_QUESTION;
    if (overrides.therapy === null) delete context.therapy_context;
    else context.therapy_context = overrides.therapy ?? { status: 'KNOWN', dia_hours: 5, therapy_id: 'therapy-synthetic', valid_from: scenario.range_start };
    if (overrides.hypoStarts) {
      context.analytical_evidence.hypo_episodes = overrides.hypoStarts.map((startedAt, index) => ({ episode_id: `hypo-synthetic-${index + 1}`, state: 'CLOSED', severity: 'L1', started_at: startedAt, ended_at: null, trigger_id: null }));
    }
    if (overrides.truncated !== undefined) {
      context.analytical_evidence.selection = { event_limit: 10, events_selected: 10, truncated: overrides.truncated, ...(overrides.selectedFrom ? { selected_from: overrides.selectedFrom } : {}) };
    }
    return context;
  };

  async function firstCall(context: TimeRangeAnalysisContextRecord) {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    try {
      const inputs: AiProviderInput[] = [];
      const gateway = new AiGatewayService(new StubProvider(async (input) => {
        inputs.push(input);
        return { provider: 'fake', model: 'deterministic-hypo-v1', received_at: new Date().toISOString(), raw_output: { assistant_message: 'Odpowiedź.' } };
      }));
      await gateway.execute({
        task: createConversationTimeRangeAnalysisTask({
          task_id: 'synthetic-causal-task', context_package_id: context.context_package_id, context_package_version: context.context_package_version,
          context_package_hash: context.content_hash, correlation_id: CONVERSATION_ID, created_at: SYNTHETIC_SCENARIO_REFERENCE_REQUESTED_AT,
        }),
        context_package: context,
        timeout_ms: 5_000,
      });
      return { payload: JSON.parse(inputs[0].prompt.user_payload) as Record<string, any>, system: inputs[0].prompt.system_instructions };
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it('builds the context with the therapy lookup outcome and the event-selection completeness', () => {
    // The synthetic repository has no therapy lookup: reported as UNAVAILABLE (no access), never as a missing DIA.
    expect(baseContext.therapy_context).toEqual({ status: 'UNAVAILABLE', dia_hours: null, therapy_id: null, valid_from: null });
    expect(baseContext.analytical_evidence.selection).toMatchObject({ event_limit: 2600, truncated: false });
    expect(baseContext.therapy_profile).toMatchObject({ status: 'UNAVAILABLE', carb_ratio_g_per_u: null });
  });

  it('delivers the boluses recorded in the insulin-action window before the hypo, with their provenance', async () => {
    const { payload, system } = await firstCall(contextWith({}));
    const preHypo = payload.tool_loop_state.pre_hypo_evidence;
    const hypoStart = scenario.hypo_episodes[0].started_at;
    expect(preHypo).toMatchObject({ policy_version: 'pre-hypo-evidence.v1', status: 'KNOWN', dia_hours: 5 });
    expect(preHypo.windows).toHaveLength(1);
    expect(preHypo.windows[0]).toMatchObject({
      window: { from: new Date(Date.parse(hypoStart) - 5 * 60 * 60 * 1000).toISOString(), to: new Date(Date.parse(hypoStart)).toISOString() },
      episode_ids: [scenario.hypo_episodes[0].id],
      clipped_to_range_start: false,
    });
    const insulin = preHypo.windows[0].domains.find((domain: any) => domain.tool === 'get_insulin_evidence');
    const boluses = scenario.events.filter((event) => event.type === 'BOLUS');
    expect(insulin.availability).toBe('RECORDS_FOUND');
    expect(insulin.evidence.events.map((event: any) => [event.amount, event.occurred_at])).toEqual(boluses.map((event) => [event.payload.insulin_units, minuteIso(event.occurred_at)]));
    expect(insulin.evidence.events_refs).toEqual(recordRefDigest(boluses.map((event) => event.source_record_id)));
    expect(preHypo.windows[0].domains.map((domain: any) => domain.tool)).toEqual(['get_insulin_evidence', 'get_basal_evidence']);
    // The causal guard: summaries never suffice to name a cause, and absence is described precisely.
    expect(system).toContain('Before naming or implying any cause of a hypoglycaemia, use tool_loop_state.pre_hypo_evidence');
    expect(system).toContain('never that no insulin was given');
    // Insulin before the drop is a hedged reading with an alternative, never the established cause.
    expect(system).toContain('give at least one alternative these records cannot rule out');
    expect(system).toContain('Never present a single cause as established.');
  });

  it('says that no insulin was recorded in the window (source has none), separately from data that was not selected', async () => {
    // A hypo 5 h after the range start: nothing recorded in that window; and one 2 h after it, whose window is clipped.
    const { payload } = await firstCall(contextWith({ hypoStarts: [at(2 * 60), at(10 * 60)] }));
    const windows = payload.tool_loop_state.pre_hypo_evidence.windows;
    const clipped = windows.find((window: any) => window.clipped_to_range_start);
    const complete = windows.find((window: any) => !window.clipped_to_range_start);
    expect(clipped.clipped_to_range_start).toBe(true);
    expect(complete.clipped_to_range_start).toBe(false);
    expect(complete.domains.find((domain: any) => domain.tool === 'get_insulin_evidence').availability).toBe('NO_RECORDS_IN_SOURCE_FOR_WINDOW');
  });

  it('includes the episode named in the conversation first and lists windows over the size budget as not included', async () => {
    const { buildPreHypoEvidence, PRE_HYPO_EVIDENCE_MAX_BYTES } = await import('@modules/ai-gateway/application/ai-gateway.service');
    // Many synthetic episodes (one every 5 h, so no two share a clock time); a registry returning a large DETAIL
    // result so only a few windows fit.
    const starts = Array.from({ length: 10 }, (_, index) => at(6 * 60 + index * 5 * 60));
    const context = contextWith({ hypoStarts: starts });
    const mentionedStart = starts[3];
    const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: context.analysis_request_input.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(mentionedStart));
    context.analysis_request_input.user_message_text = `Co spowodowało tę hipoglikemię o ${localTime}?`;
    const bulky = { execute: (request: any) => ({ tool: request.tool, status: 'KNOWN', evidence: { summary: { event_count: 1 }, events: [{ event_id: 'e', note: 'x'.repeat(6_000) }] }, coverage: {}, limitations: [], provenance: { source_refs: [] } }) } as any;

    const evidence = buildPreHypoEvidence({ task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' } as any, context, toolContext: {}, registry: bulky });
    // Adjacent windows merge (up to the tools' 24 h range); the merged window holding the named episode comes first.
    expect(evidence.windows[0]).toMatchObject({ mentioned_in_conversation: true, included: true });
    expect(evidence.windows[0].episode_ids).toContain('hypo-synthetic-4');
    const included = evidence.windows.filter((window) => window.included);
    const omitted = evidence.windows.filter((window) => !window.included);
    expect(included.length).toBeGreaterThan(0);
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted.every((window) => window.domains.length === 0 && window.episode_ids.length > 0)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(included), 'utf8')).toBeLessThanOrEqual(PRE_HYPO_EVIDENCE_MAX_BYTES);
    expect(evidence.note).toContain('not loaded here (not absent)');
  });

  it('marks a window as not selected when a cut selection starts inside it (the most recent events are kept)', async () => {
    // The selection holds the range from one hour before the hypo: the first 4 h of its 5 h window were not selected.
    const { payload } = await firstCall(contextWith({ hypoStarts: [at(10 * 60)], truncated: true, selectedFrom: at(9 * 60) }));
    const insulin = payload.tool_loop_state.pre_hypo_evidence.windows[0].domains.find((domain: any) => domain.tool === 'get_insulin_evidence');
    expect(insulin.availability).toBe('NOT_SELECTED');
    expect(insulin.evidence.not_selected_ranges).toHaveLength(1);
  });

  it('keeps no records as no records inside the selected part of a cut selection', async () => {
    const { payload } = await firstCall(contextWith({ hypoStarts: [at(10 * 60)], truncated: true, selectedFrom: at(60) }));
    expect(payload.tool_loop_state.pre_hypo_evidence.windows[0].domains.find((domain: any) => domain.tool === 'get_insulin_evidence').availability).toBe('NO_RECORDS_IN_SOURCE_FOR_WINDOW');
  });

  it('marks a failing evidence tool as not accessible, never as an absence of insulin', async () => {
    const { buildPreHypoEvidence } = await import('@modules/ai-gateway/application/ai-gateway.service');
    const context = contextWith({});
    const failing = { execute: () => { throw new Error('synthetic tool failure'); } } as any;
    const refusing = { execute: (request: any) => ({ tool: request.tool, status: 'UNAUTHORIZED', evidence: {}, coverage: {}, limitations: ['refused'], provenance: { source_refs: [] } }) } as any;
    for (const registry of [failing, refusing]) {
      const evidence = buildPreHypoEvidence({ task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' } as any, context, toolContext: {}, registry });
      expect(evidence.windows[0].domains.map((domain) => domain.availability)).toEqual(['NOT_ACCESSIBLE', 'NOT_ACCESSIBLE']);
    }
  });

  it('states that the window could not be determined when DIA is missing or the profile could not be read', async () => {
    const missing = await firstCall(contextWith({ therapy: { status: 'MISSING', dia_hours: null, therapy_id: null, valid_from: null } }));
    expect(missing.payload.tool_loop_state.pre_hypo_evidence).toMatchObject({ status: 'DIA_MISSING', windows: [] });
    const unavailable = await firstCall(contextWith({ therapy: null }));
    expect(unavailable.payload.tool_loop_state.pre_hypo_evidence).toMatchObject({ status: 'DIA_UNAVAILABLE', windows: [] });
    expect(unavailable.payload.tool_loop_state.pre_hypo_evidence.note).toContain('no access');
  });

  it('gives the model the therapy profile and the suggestion rules (doses and settings as caregiver suggestions)', async () => {
    const context = contextWith({ text: 'Ile insuliny podać na obiad 45 g?' });
    context.therapy_profile = { status: 'KNOWN', therapy_id: 't', valid_from: scenario.range_start, units: 'mg/dl', timezone: 'Europe/Warsaw', dia_hours: 5, carb_ratio_g_per_u: [['00:00', 10]], sensitivity_per_u: [['00:00', 100]], basal_u_per_h: [['00:00', 0.4]], target_low: [['00:00', 100]], target_high: [['00:00', 120]] };
    const { payload, system } = await firstCall(context);
    expect(payload.therapy_profile).toMatchObject({ carb_ratio_g_per_u: [['00:00', 10]], sensitivity_per_u: [['00:00', 100]] });
    expect(payload.evidence_contract.therapy_suggestions).toBe('CAREGIVER_SUGGESTIONS_WITH_SUFFICIENT_EVIDENCE');
    expect(system).toContain('suggestions for the caregiver to consider');
    expect(system).toContain('do not recommend insulin on your own when glucose is below target, falling fast or a hypo is in progress');
    expect(system).toContain('Err on the conservative side for the patient\'s age');
    // No year of birth in this scenario: the prompt says the age is not known instead of assuming a child.
    expect(system).toContain('Patient age: not known');
    // A meal description is carb data (no refusal for an inexact description) and the proposal has a fixed format.
    expect(system).toContain('a meal description is carb data');
    expect(system).toContain('Do not refuse because the description is not exact');
    expect(system).toContain('**Propozycja:** X,XX j (do rozważenia; every dose rounded DOWN to 0,05 j');
    expect(system).toContain('**Uzasadnienie:**');
    // No earlier meals are analysed: the proposal has no "similar meals" line.
    expect(system).not.toContain('Przeanalizowane podobne posiłki');
  });

  it('adds nothing for a question that is not about causes', async () => {
    const { payload, system } = await firstCall(contextWith({ text: 'Co było wczoraj największym problemem?' }));
    expect(payload.tool_loop_state.pre_hypo_evidence).toBeUndefined();
    expect(system).not.toContain('pre_hypo_evidence');
  });

  it('treats "dlaczego" about a drop as causal, but not a causal question about a rise only', async () => {
    const why = await firstCall(contextWith({ text: 'Dlaczego dzisiaj przed południem cukier spadł poniżej 70?' }));
    expect(why.payload.tool_loop_state.pre_hypo_evidence).toMatchObject({ policy_version: 'pre-hypo-evidence.v1', status: 'KNOWN' });
    expect(why.system).toContain('This is a question about causes');
    // A bare follow-up may be about the hypo just discussed.
    expect((await firstCall(contextWith({ text: 'A czemu?' }))).payload.tool_loop_state.pre_hypo_evidence).toBeDefined();

    const rise = await firstCall(contextWith({ text: 'Dlaczego cukier tak rośnie po obiedzie?' }));
    expect(rise.payload.tool_loop_state.pre_hypo_evidence).toBeUndefined();
    expect(rise.system).not.toContain('pre_hypo_evidence');
    // Both a high and a low named: the insulin before the hypo is included.
    expect((await firstCall(contextWith({ text: 'Skąd ten skok po hipo?' }))).payload.tool_loop_state.pre_hypo_evidence).toBeDefined();
  });
});

describe('suggested follow-ups on the time-range answer (synthetic scenario, offline)', () => {
  it('stores the best of the answer\'s candidates on the assistant message, dose questions included', async () => {
    const scenario = buildTimeRangeSyntheticScenario();
    const repository = makeScenarioRepository(scenario);
    const aiGateway = {
      execute: vi.fn().mockResolvedValue({
        result: {
          assistant_message: 'Wczoraj o 11:40 był spadek — wiem, że takie chwile potrafią przestraszyć.',
          follow_up_candidates: [
            { question: 'Co mogło spowodować spadek o 11:40?', kind: 'WHY', repeats_answer: false, answerable: true, usefulness: 4 },
            { question: 'Ile insuliny podać na obiad?', kind: 'NOW', repeats_answer: false, answerable: true, usefulness: 5 },
            { question: 'Czy wczoraj o 11:40 był spadek?', kind: 'WHY', repeats_answer: true, answerable: true, usefulness: 5 },
            { question: 'Czy w ostatnich 7 dniach też spadał przed obiadem?', kind: 'PATTERN', repeats_answer: false, answerable: true, usefulness: 3 },
          ],
        },
        metadata: { provider: 'fake', model: 'synthetic', model_fingerprint: 'synthetic' },
        input_hash: 'sha256:synthetic',
      }),
    };
    const worker = new WorkerService(repository, {} as any, { get: vi.fn(), getOrThrow: vi.fn() } as any, aiGateway as any, {} as any);
    await (worker as any).handleConversationTimeRangeAnalysis(JOB_ID, 'synthetic-lease', {
      patient_id: scenario.patient_id,
      conversation_id: CONVERSATION_ID,
      user_message_id: USER_MESSAGE_ID,
      range_type: scenario.range_type,
      range_start: scenario.range_start,
      range_end: scenario.range_end,
      timezone: scenario.timezone,
      normalization_policy_version: scenario.normalization_policy_version,
    });
    const assistant = (repository.insertMessage as any).mock.calls.map((call: any[]) => call[0]).find((message: any) => message.role === 'ASSISTANT');
    // The best three of the answer's own candidates (the repeat dropped), the hot one on top.
    expect(assistant.metadata.suggested_follow_ups).toEqual(['Ile insuliny podać na obiad?', 'Co mogło spowodować spadek o 11:40?', 'Czy w ostatnich 7 dniach też spadał przed obiadem?']);
    expect(assistant.metadata.hot_suggested_follow_up).toBe('Ile insuliny podać na obiad?');
  });

  it('names an unnamed caregiver conversation from the first answer, and never one that already has a name', async () => {
    const run = async (conversationExtras: Record<string, unknown>) => {
      const scenario = buildTimeRangeSyntheticScenario();
      const repository = makeScenarioRepository(scenario) as any;
      const conversation = await repository.getConversation();
      repository.getConversation = vi.fn().mockResolvedValue({ ...conversation, origin: 'USER', title: null, ...conversationExtras });
      repository.setAiConversationTitleIfMissing = vi.fn();
      const aiGateway = {
        execute: vi.fn().mockResolvedValue({
          result: { assistant_message: 'Wczoraj o 11:40 był spadek.', follow_up_candidates: [], conversation_title: '„Spadek przed obiadem”.' },
          metadata: { provider: 'fake', model: 'synthetic', model_fingerprint: 'synthetic' },
          input_hash: 'sha256:synthetic',
        }),
      };
      const worker = new WorkerService(repository, {} as any, { get: vi.fn(), getOrThrow: vi.fn() } as any, aiGateway as any, {} as any);
      await (worker as any).handleConversationTimeRangeAnalysis(JOB_ID, 'synthetic-lease', {
        patient_id: scenario.patient_id,
        conversation_id: CONVERSATION_ID,
        user_message_id: USER_MESSAGE_ID,
        range_type: scenario.range_type,
        range_start: scenario.range_start,
        range_end: scenario.range_end,
        timezone: scenario.timezone,
        normalization_policy_version: scenario.normalization_policy_version,
      });
      const context = aiGateway.execute.mock.calls[0][0].context_package ?? aiGateway.execute.mock.calls[0][0].context;
      return { repository, context };
    };

    const unnamed = await run({});
    expect(unnamed.context.conversation_context.needs_title).toBe(true);
    expect(unnamed.repository.setAiConversationTitleIfMissing).toHaveBeenCalledWith(CONVERSATION_ID, 'Spadek przed obiadem');

    const named = await run({ title: 'Moja nazwa' });
    expect(named.context.conversation_context.needs_title).toBe(false);
    expect(named.repository.setAiConversationTitleIfMissing).not.toHaveBeenCalled();

    const system = await run({ origin: 'SYSTEM' });
    expect(system.repository.setAiConversationTitleIfMissing).not.toHaveBeenCalled();
  });
});

describe('anomaly question answered from the data and the knowledge base (synthetic scenario, end to end, offline)', () => {
  // Real worker job, real gateway tool loop and real knowledge search pipeline; the model, the light model, the
  // embeddings and the chunk store are offline fakes. Nothing leaves the process.
  const scenario = { ...buildTimeRangeSyntheticScenario(), user_message: 'Nie rozumiem tego spadku wczoraj przed południem: dlaczego tak szybko spadło i wróciło?' };
  const at = (minute: number) => new Date(Date.parse(scenario.scenario_start) + minute * 60_000).toISOString();

  it('calls a data tool and search_knowledge, then stores the answer with the sources it cites', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    try {
      const chunks = [
        fakeKnowledgeChunk('ispad-hypo#4', { title: 'ISPAD 2022: Hypoglycemia', section: 'Hypoglycemia treatment', page: 1330, text: 'With AID consider 5-10 g of glucose.' }),
        fakeKnowledgeChunk('dexcom-g7#12', { title: 'Dexcom G7 User Guide', section: 'Compression lows', page: 212, text: 'Pressure on the sensor can cause falsely low readings.' }),
        ...Array.from({ length: 8 }, (_unused, index) => fakeKnowledgeChunk(`other#${index + 1}`)),
      ];
      const light = new FakeLightModelClient({ rewrite: 'rapid glucose drop and recovery closed loop correction bolus', rerank: '2, 1' });
      const knowledgeSearch = new KnowledgeSearchService({ store: new FakeKnowledgeChunkStore(chunks), lightClient: light, embeddingsClient: new FakeEmbeddingsClient(), lightModel: 'light-x' });
      const inputs: AiProviderInput[] = [];
      const script: Array<Omit<AiProviderResponse, 'provider' | 'model' | 'received_at'>> = [
        { response_id: 'resp-1', raw_output: {}, tool_call: { call_id: 'call-g', tool_name: 'get_glucose_evidence', arguments: { time_range: { from: at(SYNTHETIC_SCENARIO_MOMENTS.correctionBolus), to: at(SYNTHETIC_SCENARIO_MOMENTS.recovered) }, detail_level: 'DETAIL' } } },
        { response_id: 'resp-2', raw_output: {}, tool_call: { call_id: 'call-k', tool_name: 'search_knowledge', arguments: { query: 'szybki spadek glukozy po korekcie przy pętli i szybki powrót: hipo czy ucisk sensora' } } },
        { response_id: 'resp-3', raw_output: { assistant_message: 'Spadek zaczął się ok. 40 min po korekcie, więc to raczej prawdziwa hipo niż ucisk sensora [S1]; przy pętli wystarczy zwykle 5–10 g glukozy [S2].', follow_up_candidates: [] } },
      ];
      const gateway = new AiGatewayService(new StubProvider(async (input) => {
        inputs.push(input);
        return { provider: 'fake', model: 'deep-x', received_at: new Date().toISOString(), ...script[inputs.length - 1] } as AiProviderResponse;
      }), { search: knowledgeSearch, protocol_card: null });
      const repository = makeScenarioRepository(scenario);
      const worker = new WorkerService(repository, {} as any, { get: vi.fn(), getOrThrow: vi.fn() } as any, gateway as any, {} as any);

      await (worker as any).handleConversationTimeRangeAnalysis(JOB_ID, 'synthetic-lease', {
        patient_id: scenario.patient_id,
        conversation_id: CONVERSATION_ID,
        user_message_id: USER_MESSAGE_ID,
        range_type: scenario.range_type,
        range_start: scenario.range_start,
        range_end: scenario.range_end,
        timezone: scenario.timezone,
        normalization_policy_version: scenario.normalization_policy_version,
      });

      // One answer, three model turns: data tool, knowledge tool, final answer.
      expect(inputs).toHaveLength(3);
      const delivered = inputs.flatMap((input) => input.tool_runtime?.tool_results ?? []);
      const glucose = delivered.find((entry) => entry.tool_name === 'get_glucose_evidence')!.result as Record<string, any>;
      expect(glucose.status).toBe('KNOWN');
      expect(glucose.evidence.detail_window.readings.length).toBeGreaterThan(0);
      const knowledgeResult = delivered.find((entry) => entry.tool_name === 'search_knowledge')!.result as Record<string, any>;
      expect(knowledgeResult.fragments.slice(0, 2).map((fragment: any) => fragment.source)).toEqual([
        'Dexcom G7 User Guide, sekcja Compression lows, s. 212',
        'ISPAD 2022: Hypoglycemia, sekcja Hypoglycemia treatment, s. 1330',
      ]);
      expect(light.rewriteCount).toBe(1);
      expect(light.rerankCount).toBe(1);

      // The stored assistant message carries the cited sources (no fragment text, no chunk ids).
      expect(repository.insertMessage).toHaveBeenCalledTimes(1);
      const stored = repository.insertMessage.mock.calls[0][0];
      expect(stored.content).toContain('[S1]');
      expect(stored.metadata.knowledge_sources).toEqual([
        { ref: 'S1', title: 'Dexcom G7 User Guide', section: 'Compression lows', page: 212, page_end: null },
        { ref: 'S2', title: 'ISPAD 2022: Hypoglycemia', section: 'Hypoglycemia treatment', page: 1330, page_end: null },
      ]);
      // The AI execution audit keeps the knowledge search (query, status, chunks) next to the evidence tool calls.
      const succeeded = repository.markAiExecutionSucceeded.mock.calls[0][0].result;
      expect(succeeded.metadata.evidence_tool_calls.map((call: any) => call.tool_name)).toEqual(['get_glucose_evidence', 'search_knowledge']);
      expect(succeeded.metadata.knowledge_search.calls[0]).toMatchObject({ status: 'FOUND', chunk_ids: ['dexcom-g7#12', 'ispad-hypo#4', 'other#1', 'other#2', 'other#3', 'other#4'] });
      expect(repository.finalizeJobSuccess).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('a correctable tool request and flagged wording do not discard the answer (synthetic scenario, offline)', () => {
  // Live 2026-10-16: "Evidence tool request rejected: OUT_OF_RANGE" and "Time-range analysis exposes internal context
  // machinery" each failed a whole answer ("Nie udało się przygotować odpowiedzi").
  const scenario = buildTimeRangeSyntheticScenario();
  const at = (minute: number) => new Date(Date.parse(scenario.scenario_start) + minute * 60_000).toISOString();

  it('returns the rejection to the model, then stores the answer even when its wording is flagged', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    try {
      const inputs: AiProviderInput[] = [];
      const answer = 'Wcześniej odpowiedziałeś, że był sok, a o 11:40 spadek był najgłębszy.';
      const script: Array<Omit<AiProviderResponse, 'provider' | 'model' | 'received_at'>> = [
        // to before from: the tool rejects it as INVALID_REQUEST.
        { response_id: 'resp-1', raw_output: {}, tool_call: { call_id: 'call-g', tool_name: 'get_glucose_evidence', arguments: { time_range: { from: at(SYNTHETIC_SCENARIO_MOMENTS.recovered), to: at(SYNTHETIC_SCENARIO_MOMENTS.correctionBolus) }, detail_level: 'SUMMARY' } } },
        { response_id: 'resp-2', raw_output: { assistant_message: answer, follow_up_candidates: [] } },
      ];
      const gateway = new AiGatewayService(new StubProvider(async (input) => {
        inputs.push(input);
        return { provider: 'fake', model: 'deep-x', received_at: new Date().toISOString(), ...script[inputs.length - 1] } as AiProviderResponse;
      }));
      const repository = makeScenarioRepository(scenario);
      const worker = new WorkerService(repository, {} as any, { get: vi.fn(), getOrThrow: vi.fn() } as any, gateway as any, {} as any);

      await (worker as any).handleConversationTimeRangeAnalysis(JOB_ID, 'synthetic-lease', {
        patient_id: scenario.patient_id,
        conversation_id: CONVERSATION_ID,
        user_message_id: USER_MESSAGE_ID,
        range_type: scenario.range_type,
        range_start: scenario.range_start,
        range_end: scenario.range_end,
        timezone: scenario.timezone,
        normalization_policy_version: scenario.normalization_policy_version,
      });

      expect(inputs).toHaveLength(2);
      const rejected = inputs[1].tool_runtime!.tool_results!.find((entry) => entry.tool_name === 'get_glucose_evidence')!.result as Record<string, any>;
      expect(rejected.status).toBe('INVALID_REQUEST');
      expect(rejected.limitations.join(' ')).toContain('This request was not executed');
      expect(repository.insertMessage).toHaveBeenCalledTimes(1);
      expect(repository.insertMessage.mock.calls[0][0].content).toBe(answer);
      expect(repository.finalizeJobSuccess).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
