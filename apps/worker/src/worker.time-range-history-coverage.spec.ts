import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';
import type { TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import { routeUserMessage } from '@modules/context/application/message-routing';
import { newHistoryBackfillPlan } from '@modules/integrations/nightscout/application/nightscout-history-backfill';
import {
  createTrioFixture, trioRepositoryHandlers, TRIO_CONVERSATION_ID, TRIO_PATIENT_ID, TRIO_TIMEZONE, TRIO_USER_MESSAGE_ID,
} from '@infra/testing/trio-volume.fixture';

// A fresh install whose history is still importing: only the latest day is in, the rest still in Nightscout. The context says from when the
// history is complete and the daily totals call the older days NOT_IMPORTED, never "basal only".

const REQUESTED_AT = '2026-10-19T07:15:00.000Z';
const FIXTURE = createTrioFixture({ requestedAtIso: REQUESTED_AT, todayStartIso: '2026-10-18T22:00:00.000Z', days: 8 });

async function buildContext(historyState: { metadata: Record<string, unknown>; oldest_reading_at: string | null } | null) {
  const question = 'Jak wyglądał ostatni tydzień?';
  const route = routeUserMessage({ content: question, messages: [], conversationId: TRIO_CONVERSATION_ID, requestedAtIso: REQUESTED_AT, timezone: TRIO_TIMEZONE, hasPhotos: false });
  if (route.route !== 'ANALYSIS') throw new Error('not routed to an analysis');
  const handlers = { ...trioRepositoryHandlers(FIXTURE, { question }), getNightscoutHistoryState: async () => historyState };
  const repository = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, vi.fn(handler as never)])) as any;
  const aiGateway = { execute: vi.fn().mockResolvedValue({ result: { assistant_message: 'ok' }, metadata: { provider: 'fake', model: 'trio' }, input_hash: 'sha256:trio' }) };
  const worker = new WorkerService(repository, {} as any, { get: vi.fn(), getOrThrow: vi.fn() } as any, aiGateway as any, {} as any);
  await (worker as any).handleConversationTimeRangeAnalysis('history-job', 'history-lease', {
    patient_id: TRIO_PATIENT_ID, conversation_id: TRIO_CONVERSATION_ID, user_message_id: TRIO_USER_MESSAGE_ID,
    range_type: route.window.rangeType, range_start: route.window.rangeStart, range_end: route.window.rangeEnd,
    timezone: route.window.timezone, normalization_policy_version: route.window.normalizationPolicyVersion,
  });
  return aiGateway.execute.mock.calls[0][0].context_package as TimeRangeAnalysisContextRecord;
}

describe('Nightscout history coverage in the time-range context (nightscout-history.v1)', () => {
  it('while the history imports: says so, and the days before the live day are NOT_IMPORTED', async () => {
    const liveFrom = '2026-10-18T07:15:00.000Z';
    const plan = { ...newHistoryBackfillPlan({ nowIso: REQUESTED_AT, liveFrom, config: { historyDays: 30, deviceStatusDays: 7 } }), progress: { treatments: 'DONE', entries: '2026-10-01T00:00:00.000Z', devicestatus: '2026-10-12T07:15:00.000Z' } };

    const context = await buildContext({ metadata: { history_backfill: plan }, oldest_reading_at: '2026-10-11T00:00:00.000Z' });

    expect(context.nightscout_history).toMatchObject({ status: 'LOADING', available_from: liveFrom });
    expect(context.nightscout_history!.progress_percent).toBeGreaterThan(0);
    const days = context.daily_insulin_totals!.days;
    expect(days.filter((day) => Date.parse(day.from) < Date.parse(liveFrom)).every((day) => day.status === 'NOT_IMPORTED' && day.basal_units === null)).toBe(true);
    expect(days.at(-1)!.status).not.toBe('NOT_IMPORTED');
    // CGM coverage is counted from the imported history, not from the week's start.
    expect(context.analytical_evidence.summaries.glucose_time_in_range!.cgm_coverage_percent).toBeGreaterThan(90);
  });

  it('once the history covers the range: nothing is added', async () => {
    const plan = { ...newHistoryBackfillPlan({ nowIso: '2026-10-18T00:00:00.000Z', liveFrom: '2026-10-17T00:00:00.000Z', config: { historyDays: 30, deviceStatusDays: 7 } }), completed_at: '2026-10-18T00:10:00.000Z' };

    const context = await buildContext({ metadata: { history_backfill: plan }, oldest_reading_at: '2026-09-18T00:00:00.000Z' });

    expect(context.nightscout_history).toBeUndefined();
    expect(context.daily_insulin_totals!.days.some((day) => day.status === 'NOT_IMPORTED')).toBe(false);
  });
});
