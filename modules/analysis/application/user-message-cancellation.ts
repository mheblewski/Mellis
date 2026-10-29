/**
 * Cancellation of the analysis answering one user message (conversation.direct_response or
 * conversation.time_range_analysis job).
 *
 * The durable state lives on the user message (messages.metadata.response_state) and moves one way only:
 *   (none) -> CANCELLED   written by the API cancel endpoint
 *   (none) -> COMPLETING  written by the worker right before it persists any result
 * Both writes are conditional single-row updates (or run under a row lock), so exactly one side wins a race:
 * a cancelled message is never answered, and a message whose result is being saved can no longer be cancelled.
 */

export const CANCELLABLE_ANALYSIS_JOB_TYPES = ['conversation.direct_response', 'conversation.time_range_analysis'] as const;

export type UserMessageResponseState = 'CANCELLED' | 'COMPLETING' | null;

export type UserMessageCancellationOutcome =
  /** Cancelled now. */
  | 'CANCELLED'
  /** Was already cancelled earlier (idempotent repeat). */
  | 'ALREADY_CANCELLED'
  /** The answer exists or is being saved; nothing was changed. */
  | 'ALREADY_COMPLETED'
  /** No cancellable analysis for this message (no job, or the job already failed). */
  | 'NOT_CANCELLABLE';

export interface UserMessageCancellationInput {
  response_state: UserMessageResponseState;
  has_assistant_reply: boolean;
  /** Status of the newest cancellable job for this message, or null when there is none. */
  job_status: string | null;
}

export interface UserMessageCancellationDecision {
  outcome: UserMessageCancellationOutcome;
  /** QUEUED: mark the job cancelled so it is never claimed. RUNNING: the worker stops at its next check. */
  job_action: 'CANCEL_QUEUED_JOB' | 'SIGNAL_RUNNING_JOB' | null;
}

export function parseUserMessageResponseState(metadata: unknown): UserMessageResponseState {
  const value = (metadata as Record<string, unknown> | null | undefined)?.response_state;
  return value === 'CANCELLED' || value === 'COMPLETING' ? value : null;
}

export function decideUserMessageCancellation(input: UserMessageCancellationInput): UserMessageCancellationDecision {
  if (input.response_state === 'CANCELLED' || input.job_status === 'cancelled') {
    return { outcome: 'ALREADY_CANCELLED', job_action: null };
  }
  if (input.response_state === 'COMPLETING' || input.has_assistant_reply || input.job_status === 'succeeded') {
    return { outcome: 'ALREADY_COMPLETED', job_action: null };
  }
  if (input.job_status === 'queued') {
    return { outcome: 'CANCELLED', job_action: 'CANCEL_QUEUED_JOB' };
  }
  if (input.job_status === 'running') {
    return { outcome: 'CANCELLED', job_action: 'SIGNAL_RUNNING_JOB' };
  }
  return { outcome: 'NOT_CANCELLABLE', job_action: null };
}

/**
 * Status of a conversation for the history list, computed from one snapshot of the conversation's newest user
 * message, its reply and its job. EMPTY: no user message yet (a new conversation). NONE: a user message exists but
 * there is no user-requested analysis to report on (e.g. it was handled without a job).
 */
export type ConversationActivityStatus = 'AWAITING_ANSWER' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EMPTY' | 'NONE';

export function deriveConversationActivityStatus(input: {
  awaiting_user_answer: boolean;
  latest_user_message: (UserMessageCancellationInput & { exists: true }) | null;
}): ConversationActivityStatus {
  if (input.awaiting_user_answer) return 'AWAITING_ANSWER';
  const message = input.latest_user_message;
  if (!message) return 'EMPTY';
  if (message.response_state === 'CANCELLED' || message.job_status === 'cancelled') return 'CANCELLED';
  if (message.has_assistant_reply) return 'COMPLETED';
  if (message.response_state === 'COMPLETING') return 'PROCESSING';
  switch (message.job_status) {
    case 'queued':
    case 'running':
      return 'PROCESSING';
    case 'failed':
      return 'FAILED';
    case 'succeeded':
      // Job finished without a reply message (e.g. an investigation took over): nothing pending.
      return 'COMPLETED';
    default:
      return 'NONE';
  }
}
