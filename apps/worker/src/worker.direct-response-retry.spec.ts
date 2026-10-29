import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';
import {
  createTrioFixture, trioRepositoryHandlers, TRIO_CONVERSATION_ID, TRIO_PATIENT_ID, TRIO_USER_MESSAGE_ID,
} from '@infra/testing/trio-volume.fixture';

// A retried direct answer (e.g. saving it failed after the model answered) must hash the same context, so the
// succeeded AI execution is reused instead of paying for the model again. Offline: synthetic Trio repository.
const REQUESTED_AT = '2026-10-19T07:15:00.000Z';
const FIXTURE = createTrioFixture({ requestedAtIso: REQUESTED_AT, todayStartIso: '2026-10-18T22:00:00.000Z', days: 1 });

function setup() {
  const handlers = trioRepositoryHandlers(FIXTURE, { question: 'Jaki jest teraz cukier?' });
  const repository = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, vi.fn(handler)])) as any;
  const aiGateway = { execute: vi.fn().mockResolvedValue({ result: { assistant_message: 'Cukier jest w zakresie.' }, metadata: { provider: 'fake', model: 'trio' }, input_hash: 'sha256:trio' }) };
  const worker = new WorkerService(repository, {} as any, { get: vi.fn(), getOrThrow: vi.fn() } as any, aiGateway as any, {} as any);
  const reply = () => (worker as any).handleConversationDirectResponse('job-1', 'lease-1', {
    patient_id: TRIO_PATIENT_ID, conversation_id: TRIO_CONVERSATION_ID, user_message_id: TRIO_USER_MESSAGE_ID,
  });
  return { repository, aiGateway, reply };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('direct answer context hash across retries', () => {
  it('is the same minutes later, with a newer message in the chat', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:15:20.000Z'));
    const { repository, aiGateway, reply } = setup();
    await reply();

    // The retry runs 9 minutes later; meanwhile the caregiver wrote again in the same chat.
    vi.setSystemTime(new Date('2026-10-19T07:24:00.000Z'));
    const conversation = await repository.getConversation();
    repository.getConversation.mockResolvedValue({
      ...conversation,
      messages: [...conversation.messages, { id: 'later-1', role: 'USER', message_type: 'USER_MESSAGE', content: 'A teraz?', created_at: '2026-10-19T07:20:00.000Z' }],
    });
    await reply();

    const identities = repository.getAiExecutionByTaskIdentity.mock.calls.map((call: [string]) => call[0]);
    expect(identities).toHaveLength(4);
    expect(identities[2]).toBe(identities[0]);

    const [first, retry] = aiGateway.execute.mock.calls.map((call: any[]) => call[0].context_package);
    expect(retry.content_hash).toBe(first.content_hash);
    // The reading was 3 minutes old when the question was asked.
    expect(retry.current_state_snapshot.age_minutes).toBe(3);
    expect(retry.conversation_context.messages.map((message: { message_id: string }) => message.message_id)).toEqual([TRIO_USER_MESSAGE_ID]);
  });
});
