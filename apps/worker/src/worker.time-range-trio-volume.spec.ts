import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { createConversationTimeRangeAnalysisTask } from '@modules/ai-gateway/application/ai-task';
import type { AiProvider, AiProviderInput, AiProviderResponse, TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import {
  createTrioFixture, DAY_MS, trioRepositoryHandlers, TRIO_CONVERSATION_ID, TRIO_PATIENT_ID, TRIO_TIMEZONE, TRIO_USER_MESSAGE_ID, type TrioRepositoryOptions,
} from '@infra/testing/trio-volume.fixture';

// Offline: the real worker builds the context of a 14-day question from a fake repository holding Trio's real volumes
// (~1,150 events a day), and the real gateway runs the evidence tools on it. No database, no AI provider, no network.
// Audit 2026-10-19: what was not loaded reached the model as "no readings" / "0 U" / "nothing reported".

const PATIENT_ID = TRIO_PATIENT_ID;
const CONVERSATION_ID = TRIO_CONVERSATION_ID;
const USER_MESSAGE_ID = TRIO_USER_MESSAGE_ID;
const TIMEZONE = TRIO_TIMEZONE;
// Monday 19.10.2026 09:15 in Warsaw (CEST); the range is the 14 complete local days before today plus today so far.
const REQUESTED_AT = '2026-10-19T07:15:00.000Z';
const RANGE_START = '2026-10-04T22:00:00.000Z';
const LOCAL_MIDNIGHT = (daysAgo: number) => new Date(Date.parse('2026-10-18T22:00:00.000Z') - daysAgo * DAY_MS).toISOString();
const FIXTURE = createTrioFixture({ requestedAtIso: REQUESTED_AT, todayStartIso: LOCAL_MIDNIGHT(0), days: 14 });
const trioEvents = () => FIXTURE.events;

function makeTrioRepository(options: TrioRepositoryOptions = {}) {
  return Object.fromEntries(Object.entries(trioRepositoryHandlers(FIXTURE, options)).map(([name, handler]) => [name, vi.fn(handler)])) as any;
}

async function captureContext(
  options: TrioRepositoryOptions = {},
  prepare?: (worker: WorkerService) => void,
  onInput?: (input: Record<string, any>) => void,
): Promise<TimeRangeAnalysisContextRecord> {
  const repository = makeTrioRepository(options);
  const aiGateway = { execute: vi.fn().mockResolvedValue({ result: { assistant_message: 'ok' }, metadata: { provider: 'fake', model: 'trio', model_fingerprint: 'trio' }, input_hash: 'sha256:trio' }) };
  const worker = new WorkerService(repository, {} as any, { get: vi.fn(), getOrThrow: vi.fn() } as any, aiGateway as any, {} as any);
  prepare?.(worker);
  await (worker as any).handleConversationTimeRangeAnalysis('trio-job-1', 'trio-lease', {
    patient_id: PATIENT_ID, conversation_id: CONVERSATION_ID, user_message_id: USER_MESSAGE_ID,
    range_type: 'LONG_RANGE', range_start: RANGE_START, range_end: REQUESTED_AT, timezone: TIMEZONE, normalization_policy_version: 'trio-test',
  });
  expect(aiGateway.execute).toHaveBeenCalledTimes(1);
  onInput?.(aiGateway.execute.mock.calls[0][0]);
  return aiGateway.execute.mock.calls[0][0].context_package as TimeRangeAnalysisContextRecord;
}

class StubProvider implements AiProvider {
  constructor(private readonly producer: (input: AiProviderInput) => Promise<AiProviderResponse>) {}

  generate(input: AiProviderInput): Promise<AiProviderResponse> {
    return this.producer(input);
  }
}

/** The real gateway in tool-loop mode; the stub model requests the given tools in order, then answers. */
async function runTools(context: TimeRangeAnalysisContextRecord, requests: Array<{ tool: string; from: string; to: string; detail?: string }>) {
  vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
  try {
    const inputs: AiProviderInput[] = [];
    const gateway = new AiGatewayService(new StubProvider(async (input) => {
      inputs.push(input);
      const next = requests[inputs.length - 1];
      if (next) {
        return {
          provider: 'fake', model: 'trio', response_id: `resp-${inputs.length}`, received_at: new Date().toISOString(), raw_output: {},
          tool_call: { call_id: `call-${inputs.length}`, tool_name: next.tool, arguments: { time_range: { from: next.from, to: next.to }, detail_level: next.detail ?? 'SUMMARY' } },
        };
      }
      return { provider: 'fake', model: 'trio', received_at: new Date().toISOString(), raw_output: { assistant_message: 'Gotowe.' } };
    }));
    await gateway.execute({
      task: createConversationTimeRangeAnalysisTask({
        task_id: 'trio-task-1', context_package_id: context.context_package_id, context_package_version: context.context_package_version,
        context_package_hash: context.content_hash, correlation_id: CONVERSATION_ID, created_at: REQUESTED_AT,
      }),
      context_package: context,
      timeout_ms: 5_000,
    });
    const delivered = new Map<string, Record<string, any>>();
    for (const input of inputs) {
      for (const entry of input.tool_runtime?.tool_results ?? []) {
        if (!delivered.has(entry.call_id)) delivered.set(entry.call_id, entry.result as Record<string, any>);
      }
    }
    return {
      results: [...delivered.values()],
      payload: JSON.parse(inputs[0].prompt.user_payload) as Record<string, any>,
      system: inputs[0].prompt.system_instructions,
    };
  } finally {
    vi.unstubAllEnvs();
  }
}

describe('a 14-day analysis on Trio volumes (~1,150 events a day, offline)', () => {
  it('keeps the newest 5,000 events and says from when, with glucose aggregates over every reading of the range', async () => {
    const context = await captureContext();
    const selection = context.analytical_evidence.selection!;
    expect(selection).toMatchObject({ event_limit: 5000, events_selected: 5000, truncated: true });
    // Without the snapshots ~520 events a day: the selection starts about 9.6 days back, not at the range start.
    const selectedFromMs = Date.parse(String(selection.selected_from));
    expect(selectedFromMs).toBeGreaterThan(Date.parse(LOCAL_MIDNIGHT(10)));
    expect(selectedFromMs).toBeLessThan(Date.parse(LOCAL_MIDNIGHT(9)));
    expect(context.analytical_evidence.glucose_events[0].occurred_at >= String(selection.selected_from)).toBe(true);

    // Whole-range glucose: every reading of the 14 days and today so far, covering it (not ~65% "sensor outage").
    const whole = context.analytical_evidence.summaries.glucose_whole_range!;
    const readings = trioEvents().filter((event) => event.type === 'GLUCOSE_READING_AVAILABLE').length;
    expect(whole.readings_count).toBe(readings);
    expect(whole.min).toBe(55);
    expect(whole.time_in_range!.cgm_coverage_percent).toBeGreaterThan(99);
    // The selected part's own TIR is measured from selected_from, so it is not a gap either.
    expect(context.analytical_evidence.summaries.glucose_time_in_range!.cgm_coverage_percent).toBeGreaterThan(99);
  });

  it('gives the model the cut, the whole-range aggregates, the newest hypo episodes and facts with their true counts', async () => {
    const context = await captureContext();
    expect(context.analytical_evidence.hypo_episodes).toHaveLength(50);
    expect(context.analytical_evidence.hypo_episodes.at(-1)!.episode_id).toBe('hypo-58');
    expect(context.analytical_evidence.hypo_episodes[0].episode_id).toBe('hypo-9');
    expect(context.analytical_evidence.summaries.hypo_episodes_total).toBe(58);

    const { payload, system } = await runTools(context, []);
    const selected = payload.selected_evidence;
    expect(selected.selection).toMatchObject({ truncated: true, selected_from: context.analytical_evidence.selection!.selected_from });
    expect(selected.glucose).toMatchObject({ covers: 'WHOLE_RANGE', min: 55 });
    expect(selected.summary.glucose_min).toBe(55);
    expect(selected.hypo_episodes).toMatchObject({ count: 58, listed_most_recent: 50 });
    // 20 facts in the range: the 10 most recent are listed, with the count.
    expect(selected.range_facts_count).toBe(20);
    expect(selected.range_facts.map((fact: any) => fact.fact_key)).toEqual(Array.from({ length: 10 }, (_, index) => `note-${index + 11}`));
    expect(system).toContain('NOT_SELECTED');
    expect(system).toContain('never that there were no readings, no insulin or no meals');
  });

  it('answers NOT_SELECTED for a day before the selection and keeps unselected hours out of the CGM gaps', async () => {
    const context = await captureContext();
    const selectedFrom = String(context.analytical_evidence.selection!.selected_from);
    const oldDay = { from: LOCAL_MIDNIGHT(12), to: LOCAL_MIDNIGHT(11) };
    const straddling = { from: LOCAL_MIDNIGHT(10), to: LOCAL_MIDNIGHT(9) };
    const { results } = await runTools(context, [
      { tool: 'get_glucose_evidence', ...oldDay },
      { tool: 'get_insulin_evidence', ...oldDay },
      { tool: 'get_glucose_evidence', ...straddling },
    ]);
    const [oldGlucose, oldInsulin, partGlucose] = results;
    // Never MISSING ("no CGM readings") and never KNOWN with 0 U ("no bolus").
    expect(oldGlucose.status).toBe('NOT_SELECTED');
    expect(oldInsulin.status).toBe('NOT_SELECTED');
    expect(oldInsulin.evidence.summary).toBeUndefined();
    expect(oldInsulin.limitations.join(' ')).toContain('not an absence of insulin');

    expect(partGlucose.status).toBe('PARTIAL_DATA');
    expect(partGlucose.evidence.not_selected_ranges).toEqual([{ from: straddling.from, to: selectedFrom }]);
    // The coverage is of the selected part only: its readings are continuous, so no gap.
    expect(partGlucose.coverage.range.from).toBe(selectedFrom);
    expect(partGlucose.coverage.gaps).toEqual([]);
  });

  it('lists every bolus and carb entry of a day at SUMMARY, including the evening ones', async () => {
    const context = await captureContext();
    const yesterday = { from: LOCAL_MIDNIGHT(1), to: LOCAL_MIDNIGHT(0) };
    const { results } = await runTools(context, [
      { tool: 'get_insulin_evidence', ...yesterday },
      { tool: 'get_meal_evidence', ...yesterday },
    ]);
    const [insulin, meals] = results;
    expect(insulin.status).toBe('KNOWN');
    expect(insulin.evidence.summary).toMatchObject({ bolus_count: 12, smb_count: 30 });
    // 12 boluses listed (the last at 22:00 local); the 30 SMBs only counted.
    expect(insulin.evidence.events).toHaveLength(12);
    expect(insulin.evidence.events.every((event: any) => event.event_type === 'BOLUS')).toBe(true);
    expect(insulin.evidence.events.at(-1).occurred_at).toBe('2026-10-18T20:00Z');
    expect(insulin.evidence.events_listed).toBe('BOLUSES_ONLY');
    expect(meals.evidence.events).toHaveLength(12);
    expect(meals.evidence.summary.event_count).toBe(12);
  });

  it('reads the therapy profile, plans its basal on the local clock and keeps the loop state to its own time', async () => {
    const context = await captureContext();
    const morning = { from: '2026-10-18T01:00:00.000Z', to: '2026-10-18T07:00:00.000Z' }; // 03:00-09:00 local
    // Three tool calls per answer.
    const [therapy, basal] = (await runTools(context, [
      { tool: 'get_therapy_profile', ...morning },
      { tool: 'get_basal_evidence', ...morning },
    ])).results;
    const [loopYesterday, loopNow] = (await runTools(context, [
      { tool: 'get_loop_evidence', from: '2026-10-18T19:00:00.000Z', to: '2026-10-18T23:00:00.000Z' },
      { tool: 'get_loop_evidence', from: '2026-10-19T05:15:00.000Z', to: '2026-10-19T07:15:00.000Z' },
    ])).results;
    expect(therapy.status).toBe('KNOWN');
    expect(therapy.evidence).toMatchObject({ icr: { '00:00': 12 }, isf: { '00:00': 110 }, dia: 5, timezone: TIMEZONE });
    expect(basal.status).toBe('KNOWN');
    // 06:00 local is 04:00 UTC in October (CEST).
    expect(basal.evidence.planned_basal.intervals.map((interval: any) => [interval.start, interval.end, interval.rate])).toEqual([
      ['2026-10-18T01:00:00.000Z', '2026-10-18T04:00:00.000Z', 0.3],
      ['2026-10-18T04:00:00.000Z', '2026-10-18T07:00:00.000Z', 0.5],
    ]);
    expect(loopYesterday.status).toBe('NOT_SELECTED');
    expect(loopYesterday.evidence.decisions).toEqual([]);
    expect(loopNow.status).toBe('KNOWN');
    expect(loopNow.evidence.decisions[0]).toMatchObject({ bg: 132, iob: 1.4 });
  });

  it('marks the days before the selection NOT_SELECTED in the daily insulin totals when their own query fails', async () => {
    const context = await captureContext({ insulinQueryFails: true });
    const selectedFromMs = Date.parse(String(context.analytical_evidence.selection!.selected_from));
    const days = context.daily_insulin_totals!.days;
    for (const day of days) {
      expect(day.status === 'NOT_SELECTED').toBe(Date.parse(day.from) < selectedFromMs);
    }
    // The most recent complete day is fully selected and totalled.
    const yesterday = days.find((day) => day.from === LOCAL_MIDNIGHT(1))!;
    expect(yesterday.status).toBe('KNOWN');
    expect(yesterday.bolus_count).toBe(12);
  });

  it('gives the answer no meals from other days: no similar meals and no meal search', async () => {
    let input: Record<string, any> = {};
    const context = await captureContext({ question: 'Ile insuliny podać na obiad z ryżem?' }, () => {}, (captured) => { input = captured; });
    expect(context.analytical_evidence).not.toHaveProperty('similar_confirmed_meals');
    expect(context).not.toHaveProperty('historical_evidence');
    expect(input.meal_lookup).toBeUndefined();
  });
});
