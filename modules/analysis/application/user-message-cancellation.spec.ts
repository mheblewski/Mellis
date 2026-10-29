import { describe, expect, it } from 'vitest';
import {
  decideUserMessageCancellation,
  deriveConversationActivityStatus,
  parseUserMessageResponseState,
} from './user-message-cancellation';

const pending = { response_state: null, has_assistant_reply: false } as const;

describe('decideUserMessageCancellation', () => {
  it('cancels a queued job so it is never claimed, and signals a running one', () => {
    expect(decideUserMessageCancellation({ ...pending, job_status: 'queued' })).toEqual({ outcome: 'CANCELLED', job_action: 'CANCEL_QUEUED_JOB' });
    expect(decideUserMessageCancellation({ ...pending, job_status: 'running' })).toEqual({ outcome: 'CANCELLED', job_action: 'SIGNAL_RUNNING_JOB' });
  });

  it('is idempotent once cancelled', () => {
    expect(decideUserMessageCancellation({ response_state: 'CANCELLED', has_assistant_reply: false, job_status: 'running' }).outcome).toBe('ALREADY_CANCELLED');
    expect(decideUserMessageCancellation({ ...pending, job_status: 'cancelled' }).outcome).toBe('ALREADY_CANCELLED');
  });

  it('loses the race once the worker claimed completion or a reply exists', () => {
    expect(decideUserMessageCancellation({ response_state: 'COMPLETING', has_assistant_reply: false, job_status: 'running' }))
      .toEqual({ outcome: 'ALREADY_COMPLETED', job_action: null });
    expect(decideUserMessageCancellation({ ...pending, has_assistant_reply: true, job_status: 'running' }).outcome).toBe('ALREADY_COMPLETED');
    expect(decideUserMessageCancellation({ ...pending, job_status: 'succeeded' }).outcome).toBe('ALREADY_COMPLETED');
  });

  it('refuses when there is nothing to cancel', () => {
    expect(decideUserMessageCancellation({ ...pending, job_status: null }).outcome).toBe('NOT_CANCELLABLE');
    expect(decideUserMessageCancellation({ ...pending, job_status: 'failed' }).outcome).toBe('NOT_CANCELLABLE');
  });

  it('a cancelled message stays cancelled even if a reply-less job later finished (cancel recorded first)', () => {
    expect(decideUserMessageCancellation({ response_state: 'CANCELLED', has_assistant_reply: false, job_status: 'succeeded' }).outcome).toBe('ALREADY_CANCELLED');
  });
});

describe('parseUserMessageResponseState', () => {
  it('accepts only the known states', () => {
    expect(parseUserMessageResponseState({ response_state: 'CANCELLED' })).toBe('CANCELLED');
    expect(parseUserMessageResponseState({ response_state: 'COMPLETING' })).toBe('COMPLETING');
    expect(parseUserMessageResponseState({ response_state: 'whatever' })).toBeNull();
    expect(parseUserMessageResponseState(null)).toBeNull();
  });
});

describe('deriveConversationActivityStatus', () => {
  const message = (overrides: Partial<{ response_state: 'CANCELLED' | 'COMPLETING' | null; has_assistant_reply: boolean; job_status: string | null }>) => ({
    exists: true as const,
    response_state: null,
    has_assistant_reply: false,
    job_status: null,
    ...overrides,
  });

  it('maps the snapshot to one status', () => {
    expect(deriveConversationActivityStatus({ awaiting_user_answer: true, latest_user_message: message({ job_status: 'running' }) })).toBe('AWAITING_ANSWER');
    expect(deriveConversationActivityStatus({ awaiting_user_answer: false, latest_user_message: null })).toBe('EMPTY');
    expect(deriveConversationActivityStatus({ awaiting_user_answer: false, latest_user_message: message({ job_status: 'queued' }) })).toBe('PROCESSING');
    expect(deriveConversationActivityStatus({ awaiting_user_answer: false, latest_user_message: message({ job_status: 'running' }) })).toBe('PROCESSING');
    expect(deriveConversationActivityStatus({ awaiting_user_answer: false, latest_user_message: message({ response_state: 'COMPLETING', job_status: 'running' }) })).toBe('PROCESSING');
    expect(deriveConversationActivityStatus({ awaiting_user_answer: false, latest_user_message: message({ has_assistant_reply: true, job_status: 'succeeded' }) })).toBe('COMPLETED');
    expect(deriveConversationActivityStatus({ awaiting_user_answer: false, latest_user_message: message({ job_status: 'failed' }) })).toBe('FAILED');
    expect(deriveConversationActivityStatus({ awaiting_user_answer: false, latest_user_message: message({ response_state: 'CANCELLED', job_status: 'running' }) })).toBe('CANCELLED');
    expect(deriveConversationActivityStatus({ awaiting_user_answer: false, latest_user_message: message({ job_status: null }) })).toBe('NONE');
  });

  it('a retry in progress after a failed attempt is still processing, not failed', () => {
    // Jobs return to queued between attempts; only a terminal failure reports FAILED.
    expect(deriveConversationActivityStatus({ awaiting_user_answer: false, latest_user_message: message({ job_status: 'queued' }) })).toBe('PROCESSING');
  });
});
