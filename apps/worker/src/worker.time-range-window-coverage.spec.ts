import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { createConversationTimeRangeAnalysisTask } from '@modules/ai-gateway/application/ai-task';
import type { AiProviderInput, AiProviderResponse, TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import { routeUserMessage } from '@modules/context/application/message-routing';
import { localDayWindows } from '@modules/context/application/time-range-normalization';
import {
  createTrioFixture, trioRepositoryHandlers, TRIO_CONVERSATION_ID, TRIO_PATIENT_ID, TRIO_TIMEZONE, TRIO_USER_MESSAGE_ID,
} from '@infra/testing/trio-volume.fixture';

// Offline, on Trio's real volumes (~1,150 events a day, 31 days, one CGM gap): a question is routed as in the API, the
// real worker builds its context and the real gateway (tool-calling mode, as in production) builds what the model
// reads, with the evidence tools answering every local day of the window. Each window must either reach the model
// whole (newest reading present, every day with its readings) or say explicitly what was not loaded
// (NOT_SELECTED / truncated). Audit 2026-10-19: missing days used to look like "no readings".

/** Monday 19.10.2026 09:15 in Warsaw (CEST). */
const REQUESTED_AT = '2026-10-19T07:15:00.000Z';
const FIXTURE = createTrioFixture({ requestedAtIso: REQUESTED_AT, todayStartIso: '2026-10-18T22:00:00.000Z', days: 31 });
const NEWEST_READING_AT = FIXTURE.events.filter((event) => event.type === 'GLUCOSE_READING_AVAILABLE').at(-1)!.occurred_at;
/** October 2026 before the 25th is CEST (UTC+2). */
const localToIso = (local: string) => new Date(`${local.replace(' ', 'T')}:00+02:00`).toISOString();

type Domain = { tool: string; status: string; evidence?: Record<string, any>; coverage?: Record<string, any>; limitations?: string[] };

async function buildContext(question: string) {
  const route = routeUserMessage({ content: question, messages: [], conversationId: TRIO_CONVERSATION_ID, requestedAtIso: REQUESTED_AT, timezone: TRIO_TIMEZONE, hasPhotos: false });
  if (route.route !== 'ANALYSIS') throw new Error(`"${question}" was not routed to an analysis`);
  const handlers = trioRepositoryHandlers(FIXTURE, { question });
  const repository = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, vi.fn(handler)])) as any;
  const aiGateway = { execute: vi.fn().mockResolvedValue({ result: { assistant_message: 'ok' }, metadata: { provider: 'fake', model: 'trio' }, input_hash: 'sha256:trio' }) };
  const worker = new WorkerService(repository, {} as any, { get: vi.fn(), getOrThrow: vi.fn() } as any, aiGateway as any, {} as any);
  await (worker as any).handleConversationTimeRangeAnalysis('coverage-job', 'coverage-lease', {
    patient_id: TRIO_PATIENT_ID, conversation_id: TRIO_CONVERSATION_ID, user_message_id: TRIO_USER_MESSAGE_ID,
    range_type: route.window.rangeType, range_start: route.window.rangeStart, range_end: route.window.rangeEnd,
    timezone: route.window.timezone, normalization_policy_version: route.window.normalizationPolicyVersion,
  });
  return { window: route.window, context: aiGateway.execute.mock.calls[0][0].context_package as TimeRangeAnalysisContextRecord };
}

/** One gateway run in tool-calling mode; the stub model asks for the given glucose windows in order, then answers. */
async function runGateway(context: TimeRangeAnalysisContextRecord, windows: Array<{ from: string; to: string }>) {
  vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
  try {
    const inputs: AiProviderInput[] = [];
    const gateway = new AiGatewayService({
      generate: async (input: AiProviderInput): Promise<AiProviderResponse> => {
        inputs.push(input);
        const next = windows[inputs.length - 1];
        if (next) {
          return {
            provider: 'fake', model: 'trio', response_id: `resp-${inputs.length}`, received_at: REQUESTED_AT, raw_output: {},
            tool_call: { call_id: `call-${inputs.length}`, tool_name: 'get_glucose_evidence', arguments: { time_range: next, detail_level: 'SUMMARY' } },
          };
        }
        return { provider: 'fake', model: 'trio', received_at: REQUESTED_AT, raw_output: { assistant_message: 'Gotowe.' } };
      },
    });
    await gateway.execute({
      task: createConversationTimeRangeAnalysisTask({
        task_id: 'coverage-task', context_package_id: context.context_package_id, context_package_version: context.context_package_version,
        context_package_hash: context.content_hash, correlation_id: TRIO_CONVERSATION_ID, created_at: REQUESTED_AT,
      }),
      context_package: context,
      timeout_ms: 5_000,
    });
    const results = new Map<string, Domain>();
    for (const input of inputs) {
      for (const entry of input.tool_runtime?.tool_results ?? []) {
        if (!results.has(entry.call_id)) results.set(entry.call_id, entry.result as Domain);
      }
    }
    return { payload: JSON.parse(inputs[0].prompt.user_payload) as Record<string, any>, results: [...results.values()] };
  } finally {
    vi.unstubAllEnvs();
  }
}

/** What the model has for the glucose of each local day: the precomputed day, or the tool's answer (3 calls per answer). */
async function glucoseByDay(context: TimeRangeAnalysisContextRecord, days: Array<{ from: string; to: string }>) {
  const { payload } = await runGateway(context, []);
  const precomputed: Array<{ window: { from: string; to: string }; domains: Domain[] }> = payload.tool_loop_state?.precomputed_daily_evidence?.days ?? [];
  const byDay = new Map<string, Domain>();
  for (const day of precomputed) {
    const glucose = day.domains.find((domain) => domain.tool === 'get_glucose_evidence');
    if (glucose) byDay.set(day.window.from, glucose);
  }
  const requested = days.filter((day) => !byDay.has(day.from));
  for (let index = 0; index < requested.length; index += 3) {
    const batch = requested.slice(index, index + 3);
    const { results } = await runGateway(context, batch);
    expect(results).toHaveLength(batch.length);
    batch.forEach((day, position) => byDay.set(day.from, results[position]));
  }
  return { payload, byDay, precomputedDays: precomputed.length };
}

const CASES: Array<{ label: string; question: string; rangeType: string; needsFrom: string; truncated: boolean }> = [
  { label: 'today', question: 'Jak mija dzień?', rangeType: 'TODAY', needsFrom: '2026-10-19 00:00', truncated: false },
  { label: 'the night', question: 'Jak minęła noc?', rangeType: 'SHORT_RANGE', needsFrom: '2026-10-18 21:00', truncated: false },
  { label: '3 days', question: 'Jak było przez ostatnie 3 dni?', rangeType: 'SHORT_RANGE', needsFrom: '2026-10-16 00:00', truncated: false },
  { label: '7 days', question: 'Jak wyglądał ostatni tydzień?', rangeType: 'MEDIUM_RANGE', needsFrom: '2026-10-12 00:00', truncated: false },
  { label: '14 days', question: 'Jak wyglądały ostatnie 2 tygodnie?', rangeType: 'LONG_RANGE', needsFrom: '2026-10-05 00:00', truncated: true },
  { label: '30 days', question: 'Jak minął ostatni miesiąc?', rangeType: 'EXTENDED_RANGE', needsFrom: '2026-09-19 00:00', truncated: true },
];

describe('every analysed window reaches the model whole or says what was not loaded (Trio volumes, offline)', () => {
  for (const testCase of CASES) {
    it(`${testCase.label}: "${testCase.question}"`, async () => {
      const { window, context } = await buildContext(testCase.question);
      expect(window.rangeType).toBe(testCase.rangeType);
      expect(Date.parse(window.rangeStart)).toBeLessThanOrEqual(Date.parse(localToIso(testCase.needsFrom)));
      expect(window.rangeEnd).toBe(REQUESTED_AT);

      // The newest reading is always loaded (a cut selection keeps the most recent events).
      const glucoseEvents = context.analytical_evidence.glucose_events;
      expect(glucoseEvents.at(-1)!.occurred_at).toBe(NEWEST_READING_AT);

      const days = localDayWindows(window.rangeStart, window.rangeEnd, TRIO_TIMEZONE).map((day) => ({ from: day.from, to: day.to }));
      const { payload, byDay } = await glucoseByDay(context, days);
      const selection = payload.selected_evidence.selection as { truncated?: boolean; selected_from?: string; note?: string } | undefined;
      expect(Boolean(selection?.truncated)).toBe(testCase.truncated);
      if (testCase.truncated) {
        // Said, with the time it starts from, and what the earlier time is.
        expect(selection!.selected_from).toBe(context.analytical_evidence.selection!.selected_from);
        expect(selection!.note).toContain('NOT_SELECTED, not empty');
        // Whole-range glucose is computed over every reading, not only the selected days.
        expect(payload.selected_evidence.glucose).toMatchObject({ covers: 'WHOLE_RANGE' });
        expect(payload.selected_evidence.glucose.time_in_range.cgm_coverage_percent).toBeGreaterThan(99);
      }

      const statuses: string[] = [];
      for (const day of days) {
        const glucose = byDay.get(day.from)!;
        expect(glucose, `glucose of ${day.from}`).toBeDefined();
        statuses.push(glucose.status);
        if (glucose.status === 'NOT_SELECTED') {
          // Only before the selection of a cut range, and said as such.
          expect(testCase.truncated).toBe(true);
          expect(Date.parse(day.to)).toBeLessThanOrEqual(Date.parse(selection!.selected_from!));
          continue;
        }
        // Never MISSING / UNKNOWN for a day that has readings.
        expect(['KNOWN', 'PARTIAL_DATA'], `status of ${day.from}`).toContain(glucose.status);
        expect(glucose.evidence!.summary.observation_count, `readings of ${day.from}`).toBeGreaterThan(0);
        // The only gap reported is the real one; a part that was not selected is not a gap.
        for (const gap of glucose.coverage!.gaps as Array<{ from: string; to: string }>) {
          expect(Date.parse(gap.from)).toBeGreaterThanOrEqual(Date.parse(FIXTURE.cgmGap!.from) - 5 * 60_000);
          expect(Date.parse(gap.to)).toBeLessThanOrEqual(Date.parse(FIXTURE.cgmGap!.to) + 5 * 60_000);
        }
      }
      // The newest day reaches the newest reading.
      const today = byDay.get(days.at(-1)!.from)!;
      expect(Date.parse(today.coverage!.covered_range.to)).toBeGreaterThanOrEqual(Date.parse(NEWEST_READING_AT));
      // The real CGM gap (two days ago) is reported wherever that day was loaded.
      const gapDay = days.find((day) => Date.parse(day.from) <= Date.parse(FIXTURE.cgmGap!.from) && Date.parse(FIXTURE.cgmGap!.from) < Date.parse(day.to));
      if (gapDay) expect(byDay.get(gapDay.from)!.coverage!.gaps.length).toBeGreaterThan(0);
      if (testCase.truncated) expect(statuses).toContain('NOT_SELECTED');

      // Daily insulin totals: one entry per local day, each known (or explicitly NOT_SELECTED), never silently absent.
      const totals = payload.daily_insulin_totals as { days: Array<{ from: string; status: string; complete: boolean; bolus_count?: number }> };
      expect(totals.days.map((day) => day.from)).toEqual(days.map((day) => day.from));
      for (const day of totals.days) {
        expect(['KNOWN', 'NOT_SELECTED']).toContain(day.status);
        if (day.status === 'KNOWN' && day.complete) expect(day.bolus_count).toBe(12);
      }
    });
  }
});
