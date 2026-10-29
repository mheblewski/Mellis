import { describe, expect, it, vi } from 'vitest';
import { ApiService } from './api.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const CAREGIVER = { user_id: '33333333-3333-4333-8333-333333333333' } as any;

/** The chat of a hypo screen: its conversation has the episode, and its messages are created at 10:18:28. */
function setup(options: { diaHours?: number | null } = {}) {
  const jobs: Array<{ jobType: string; payload: Record<string, unknown> }> = [];
  let messageCount = 0;
  const client = {
    query: vi.fn(async (sql: string) => {
      if (/INSERT INTO messages/.test(sql)) {
        messageCount += 1;
        return { rows: [{ id: `message-${messageCount}`, created_at: '2026-10-14T10:18:28.000Z', role: 'USER', metadata: {} }] };
      }
      if (/UPDATE conversations|UPDATE messages/.test(sql)) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
  const repo = {
    async getAccessRow(userId: string, patientId: string) {
      return userId === CAREGIVER.user_id && patientId === PATIENT ? { can_read_patient: true, can_write_patient: true } : null;
    },
    insertAuditEvent: vi.fn(),
    getConversation: vi.fn(async () => ({ id: CONVERSATION, patient_id: PATIENT, episode_id: 'episode-1', awaiting_user_answer: false, messages: [] })),
    getConversationHypo: vi.fn(async () => ({
      episode_id: 'episode-1',
      started_at: '2026-10-14T08:00:00.000Z',
      ended_at: '2026-10-14T08:25:00.000Z',
    })),
    getTherapyDiaAt: vi.fn(async () => (options.diaHours === null
      ? { status: 'MISSING', dia_hours: null, therapy_id: null, valid_from: null }
      : { status: 'KNOWN', dia_hours: options.diaHours ?? 3, therapy_id: 't', valid_from: null })),
    getMessageByIdempotencyKey: vi.fn(async () => null),
    withTransaction: vi.fn(async (handler: (c: typeof client) => Promise<unknown>) => handler(client)),
    insertJob: vi.fn(async (job: { jobType: string; payload: Record<string, unknown> }) => {
      jobs.push(job);
      return job;
    }),
    evaluateInvestigationForEvent: vi.fn(),
  };
  const api = new ApiService(repo as any, {} as any);
  const send = (content: string) =>
    api.submitAnswer(CAREGIVER, PATIENT, CONVERSATION, { message_type: 'USER_MESSAGE', content, idempotency_key: 'key-1' });
  return { send, jobs, repo };
}

describe('ApiService hypo screen chat', () => {
  it.each([
    'Dlaczego był ten spadek?',
    'co mogło być przyczyną',
  ])('analyses the hypo window for "%s": one DIA before it to the request time', async (content) => {
    const { send, jobs } = setup();

    const response = await send(content);

    expect(response.decision).toBe('ANALYSIS_REQUEST');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({
      range_type: 'TODAY',
      range_start: '2026-10-14T05:00:00.000Z',
      // 3 h after the hypo would be 11:25; the question was asked at 10:18:28.
      range_end: '2026-10-14T10:18:28.000Z',
    });
  });

  it('looks back 4 h when the therapy has no DIA', async () => {
    const { send, jobs } = setup({ diaHours: null });
    await send('Dlaczego był ten spadek?');
    expect(jobs[0].payload.range_start).toBe('2026-10-14T04:00:00.000Z');
  });

  it('keeps an explicit range named in the message', async () => {
    const { send, jobs } = setup();
    await send('Czy w ostatnich 7 dniach też były takie spadki?');
    expect(jobs[0].payload.range_type).toBe('MEDIUM_RANGE');
  });

  it('answers thanks directly, without an analysis', async () => {
    const { send, jobs, repo } = setup();
    const response = await send('dzięki');
    expect(response.decision).toBe('DIRECT_RESPONSE');
    expect(jobs.map((job) => job.jobType)).not.toContain('conversation.time_range_analysis');
    expect(repo.getConversationHypo).not.toHaveBeenCalled();
  });
});
