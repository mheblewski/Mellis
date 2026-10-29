import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBeyondReachAnswer } from '@modules/context/application/message-routing';
import { WorkerService } from './worker.service';

// "Older than 30 days" is said on the patient's clock: with TZ unset or UTC the worker falls back to Europe/Warsaw,
// like the rest of it. Fake repository only.
const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
// 00:30 on 20.10 in Warsaw, still 19.10 in UTC.
const ASKED_AT = '2026-10-19T22:30:00.000Z';
const QUESTION = 'Jak było 1 sierpnia?';

const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('period beyond reach answer', () => {
  it('uses Europe/Warsaw dates when the process runs on UTC', async () => {
    process.env.TZ = 'UTC';
    const userMessage = { id: 'msg-1', role: 'USER', message_type: 'USER_MESSAGE', content: QUESTION, created_at: ASKED_AT };
    const repository = {
      getConversation: vi.fn().mockResolvedValue({ id: CONVERSATION, messages: [userMessage] }),
      getMessageByIdempotencyKey: vi.fn().mockResolvedValue(null),
      getMessageById: vi.fn().mockResolvedValue(userMessage),
      insertMessage: vi.fn().mockResolvedValue({ id: 'assistant-1' }),
      finalizeJobSuccess: vi.fn(),
    } as any;
    const worker = new WorkerService(repository, {} as any, { get: vi.fn(), getOrThrow: vi.fn() } as any, {} as any, {} as any);

    await (worker as any).handleConversationDirectResponse('job-1', 'lease-1', { patient_id: PATIENT, conversation_id: CONVERSATION, user_message_id: 'msg-1' });

    const warsaw = buildBeyondReachAnswer(QUESTION, ASKED_AT, 'Europe/Warsaw');
    expect(warsaw).not.toBeNull();
    expect(warsaw).not.toBe(buildBeyondReachAnswer(QUESTION, ASKED_AT, 'UTC'));
    expect(repository.insertMessage).toHaveBeenCalledWith(expect.objectContaining({ content: warsaw }));
  });
});
