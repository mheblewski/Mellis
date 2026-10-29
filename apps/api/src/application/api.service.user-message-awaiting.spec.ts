import { describe, expect, it, vi } from 'vitest';
import { ApiService } from './api.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const CAREGIVER = { user_id: '33333333-3333-4333-8333-333333333333' } as any;

/**
 * In-memory stand-in for the conversation row and job queue. Every statement of handleUserMessage's transaction goes
 * through query(), so the assertions read the persisted awaiting_user_answer, not the HTTP response.
 */
function setup(options: { investigationState?: string; messages?: Array<Record<string, unknown>> } = {}) {
  const persisted = { awaiting_user_answer: true as boolean, message_decision: null as string | null };
  const jobs: Array<{ jobType: string }> = [];
  let messageCount = 0;

  const insertedMessageParams: unknown[][] = [];

  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/INSERT INTO messages/.test(sql)) {
        insertedMessageParams.push(params);
        messageCount += 1;
        return { rows: [{ id: `message-${messageCount}`, created_at: '2026-10-14T10:18:28.000Z', role: 'USER', metadata: {} }] };
      }
      if (/UPDATE conversations\s+SET awaiting_user_answer/.test(sql)) {
        persisted.awaiting_user_answer = params[1] as boolean;
        return { rows: [] };
      }
      if (/UPDATE messages/.test(sql)) {
        persisted.message_decision = params[2] as string;
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
    getConversation: vi.fn(async () => ({ id: CONVERSATION, patient_id: PATIENT, awaiting_user_answer: true, messages: options.messages ?? [] })),
    getMessageByIdempotencyKey: vi.fn(async () => null),
    withTransaction: vi.fn(async (handler: (c: typeof client) => Promise<unknown>) => handler(client)),
    insertJob: vi.fn(async (job: { jobType: string }) => {
      jobs.push(job);
      return job;
    }),
    evaluateInvestigationForEvent: vi.fn(async () => ({
      shouldProceedToAnalysis: false,
      state: options.investigationState ?? 'QUESTION_PENDING',
    })),
  };

  const api = new ApiService(repo as any, {} as any);
  const send = (content: string, key = 'key-1', extra: Record<string, unknown> = {}) =>
    api.submitAnswer(CAREGIVER, PATIENT, CONVERSATION, { message_type: 'USER_MESSAGE', content, idempotency_key: key, ...extra });
  return { send, persisted, jobs, repo, insertedMessageParams };
}

describe('ApiService user message replay', () => {
  it('queues the answer of a message a failed request stored without its job, and only once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T10:20:00.000Z'));
    try {
      const { send, jobs, repo } = setup();
      repo.insertJob.mockRejectedValueOnce(new Error('connection reset'));
      await expect(send('Jak minął dzień?')).rejects.toThrow('connection reset');
      expect(jobs).toHaveLength(0);

      // The phone retries with the same key: the stored message was never dispatched.
      const stored = { id: 'message-1', message_type: 'USER_MESSAGE', role: 'USER', content: 'Jak minął dzień?', created_at: '2026-10-14T10:18:28.000Z', metadata: { decision: 'DIRECT_RESPONSE' } };
      repo.getMessageByIdempotencyKey.mockResolvedValueOnce(stored);
      await send('Jak minął dzień?');
      expect(jobs).toHaveLength(1);

      // Dispatched: a later replay returns the message without queuing again.
      repo.getMessageByIdempotencyKey.mockResolvedValueOnce({ ...stored, metadata: { decision: 'DIRECT_RESPONSE', dispatched: true } });
      const replay = await send('Jak minął dzień?');
      expect(replay.created).toBe(false);
      expect(jobs).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never sends an old or answered message again', async () => {
    const { userMessageNeedsDispatch } = await import('./api.service');
    const message = { id: 'm1', message_type: 'USER_MESSAGE', created_at: '2026-10-14T10:00:00.000Z', metadata: {} };
    const now = Date.parse('2026-10-14T10:05:00.000Z');
    expect(userMessageNeedsDispatch(message, { messages: [] }, now)).toBe(true);
    expect(userMessageNeedsDispatch(message, { messages: [] }, now + 20 * 60_000)).toBe(false);
    expect(userMessageNeedsDispatch(message, { messages: [{ role: 'ASSISTANT', metadata: { user_message_id: 'm1' } }] }, now)).toBe(false);
  });
});

describe('ApiService user message awaiting_user_answer', () => {
  it('records the signed-in caregiver as the author of the message (shared conversations)', async () => {
    const { send, insertedMessageParams } = setup();

    await send('Jak wyglądał mój cukier dzisiaj?');

    expect(insertedMessageParams).toHaveLength(1);
    expect(insertedMessageParams[0].at(-1)).toBe(CAREGIVER.user_id);
  });

  it.each([
    'Jak wyglądał mój cukier przez ostatnie 7 dni?',
    'Jak wyglądał mój cukier dzisiaj?',
  ])('persists awaiting_user_answer=false for a time-range analysis worded like an investigation: %s', async (content) => {
    const { send, persisted, jobs, repo } = setup();

    const response = await send(content);

    expect(response.decision).toBe('ANALYSIS_REQUEST');
    expect(persisted.awaiting_user_answer).toBe(false);
    expect(persisted.message_decision).toBe('ANALYSIS_REQUEST');
    expect(jobs.map((job) => job.jobType)).toEqual(['conversation.time_range_analysis']);
    expect(repo.evaluateInvestigationForEvent).not.toHaveBeenCalled();
  });

  it('answers a data question without a time range with the analysis of today, never a canned investigation question', async () => {
    const { send, persisted, jobs, repo } = setup();

    const response = await send('Dlaczego cukier spadł po obiedzie?');

    expect(response.decision).toBe('ANALYSIS_REQUEST');
    expect(persisted.awaiting_user_answer).toBe(false);
    expect(persisted.message_decision).toBe('ANALYSIS_REQUEST');
    expect(repo.evaluateInvestigationForEvent).not.toHaveBeenCalled();
    expect(jobs.map((job) => job.jobType)).toEqual(['conversation.time_range_analysis']);
    expect(jobs[0].payload).toMatchObject({ range_type: 'TODAY' });
    expect((response.conversation as Record<string, unknown>).awaiting_user_answer).toBe(false);
  });

  it('keeps the phone\'s send limits with a message from a phone that can give a bolus, and only valid ones', async () => {
    const { send, insertedMessageParams } = setup();
    await send('Ile podać na obiad?', 'k1', { bolus_cards: true, phone_limits: { max_bolus_u: 5, max_carbs_g: 100 } });
    await send('Ile podać na obiad?', 'k2', { bolus_cards: true, phone_limits: { max_bolus_u: 99, max_carbs_g: 100 } });
    await send('Ile podać na obiad?', 'k3', { phone_limits: { max_bolus_u: 5, max_carbs_g: 100 } });
    const metadata = insertedMessageParams.map((params) => JSON.parse(String(params[4])));
    expect(metadata[0]).toMatchObject({ bolus_cards: true, phone_limits: { max_bolus_u: 5, max_carbs_g: 100 } });
    expect(metadata[1]).not.toHaveProperty('phone_limits');
    expect(metadata[2]).not.toHaveProperty('phone_limits');
  });

  it('refuses a chat message longer than 4000 characters before storing it', async () => {
    const { send, insertedMessageParams } = setup();
    await expect(send('x'.repeat(4001))).rejects.toThrow('at most 4000 characters');
    expect(insertedMessageParams).toHaveLength(0);
  });

  it('reads the period in the time zone of the Trio profile', async () => {
    const { send, jobs, repo } = setup();
    (repo as any).getTherapyProfileAt = vi.fn(async () => ({ timezone: 'America/New_York' }));
    await send('Jak wyglądał mój cukier dzisiaj?');
    expect(jobs[0].payload).toMatchObject({ timezone: 'America/New_York' });
  });

  it('uses the 3-day window containing yesterday when the analysis request names no range but the message says yesterday', async () => {
    const { send, jobs } = setup();
    // "Przeanalizuj" alone is an analysis request; before, without a parsed range it opened the investigation card.
    const response = await send('Przeanalizuj mi wczorajszy dzień pod kątem hipoglikemii');
    expect(response.decision).toBe('ANALYSIS_REQUEST');
    expect(jobs.map((job) => job.jobType)).toEqual(['conversation.time_range_analysis']);
    expect(jobs[0].payload).toMatchObject({ range_type: 'SHORT_RANGE' });
  });

  it('answers a tapped data follow-up with the analysis of the period already analysed in the conversation', async () => {
    // Analysed in the morning; the follow-up is sent at 10:18:28Z.
    const analysedRange = { range_type: 'SHORT_RANGE', range_start: '2026-10-10T22:00:00.000Z', range_end: '2026-10-14T07:22:05.000Z', timezone: 'Europe/Warsaw' };
    const messages = [
      { id: 'm1', role: 'USER', content: 'Przeanalizuj mi wczorajszy dzień pod kątem hipoglikemii', metadata: { decision: 'ANALYSIS_REQUEST' } },
      { id: 'm2', role: 'ASSISTANT', content: 'Wczoraj były dwie hipoglikemie.', metadata: { decision: 'ANALYSIS_REQUEST', ...analysedRange } },
    ];
    for (const followUp of ['Pokaż insulinę i wpisy węgli wokół 16:18', 'Pokaż przebieg glukozy od 15:00 do 17:30', 'Porównaj ten spadek z hipoglikemią o 10:18']) {
      const { send, jobs } = setup({ messages });
      const response = await send(followUp);
      expect(response.decision).toBe('ANALYSIS_REQUEST');
      expect(jobs.map((job) => job.jobType)).toEqual(['conversation.time_range_analysis']);
      // The analysed period, continued up to the follow-up.
      expect(jobs[0].payload).toMatchObject({ range_type: 'SHORT_RANGE', range_start: analysedRange.range_start, range_end: '2026-10-14T10:18:28.000Z' });
    }
  });

  it('treats follow-ups after an analysis as data questions, and pattern questions as a week of data', async () => {
    const analysedRange = { range_type: 'SHORT_RANGE', range_start: '2026-10-10T22:00:00.000Z', range_end: '2026-10-14T08:30:53.000Z', timezone: 'Europe/Warsaw' };
    const messages = [
      { id: 'm1', role: 'USER', content: 'Przeanalizuj mi wczorajszy dzień pod kątem hipoglikemii', metadata: { decision: 'ANALYSIS_REQUEST' } },
      { id: 'm2', role: 'ASSISTANT', content: 'Wczoraj był spadek do 49 mg/dl o 10:28.', metadata: { decision: 'ANALYSIS_REQUEST', ...analysedRange } },
    ];
    const pattern = setup({ messages });
    expect((await pattern.send('Czy to jest powtarzający się wzorzec?')).decision).toBe('ANALYSIS_REQUEST');
    expect(pattern.jobs[0].payload).toMatchObject({ range_type: 'MEDIUM_RANGE' });

    const bare = setup({ messages });
    expect((await bare.send('A rano?')).decision).toBe('ANALYSIS_REQUEST');
    expect(bare.jobs[0].payload).toMatchObject({ range_type: 'SHORT_RANGE', range_start: analysedRange.range_start });

    for (const message of ['Dzięki!', 'Co oznacza SMB?']) {
      const { send, jobs } = setup({ messages });
      expect((await send(message)).decision).toBe('DIRECT_RESPONSE');
      expect(jobs.map((job) => job.jobType)).toEqual(['conversation.direct_response']);
    }
  });

  it('answers dose and settings questions with data: today for a dose, a week for a settings change', async () => {
    const dose = setup();
    expect((await dose.send('Ile insuliny podać na obiad 45 g?')).decision).toBe('ANALYSIS_REQUEST');
    expect(dose.jobs[0].payload).toMatchObject({ range_type: 'TODAY' });
    const settings = setup();
    expect((await settings.send('Czy zmienić ICR na śniadanie?')).decision).toBe('ANALYSIS_REQUEST');
    expect(settings.jobs[0].payload).toMatchObject({ range_type: 'MEDIUM_RANGE' });
  });

  it('keeps general and social messages as direct replies', async () => {
    for (const message of ['Co oznacza IOB?', 'Co oznacza trend glikemii?', 'Dzięki!']) {
      const { send, jobs } = setup();
      expect((await send(message)).decision).toBe('DIRECT_RESPONSE');
      expect(jobs.map((job) => job.jobType)).toEqual(['conversation.direct_response']);
    }
  });

  it('keeps awaiting_user_answer=false for a direct-response question', async () => {
    const { send, persisted, jobs } = setup();

    const response = await send('Co oznacza IOB?');

    expect(response.decision).toBe('DIRECT_RESPONSE');
    expect(persisted.awaiting_user_answer).toBe(false);
    expect(jobs.map((job) => job.jobType)).toEqual(['conversation.direct_response']);
  });
});
