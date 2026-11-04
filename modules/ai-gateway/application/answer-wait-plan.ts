/**
 * What the app shows while an answer is prepared (answer-wait-plan.v1, role review 2026-11-04,
 * docs/product/chat-wait-screen-review.md). The model reports nothing while it thinks, so between real events these
 * say what it is working on, in the first person and only when it has that data (owner's decision). Never a number, a
 * dose direction or advice: a low has its own alert with the grams.
 */

import { isCausalQuestion } from '@modules/context/application/conversation-context-resolver';

export const ANSWER_WAIT_PLAN_VERSION = 'answer-wait-plan.v1';
const FRESH_READING_MAX_AGE_MINUTES = 10;
const MIN_ACTIVE_INSULIN_U = 0.1;

export const WAIT_LINES = {
  insulin: 'Sprawdzam insulinę, która jeszcze działa',
  readings: 'Sprawdzam ostatnie odczyty',
  plan: 'Układam plan',
  causes: 'Szukam możliwych przyczyn',
  today: 'Analizuję dzisiejszy dzień',
  period: 'Analizuję dane z tego okresu',
} as const;

export interface AnswerWaitPlan {
  started_at: string;
  stale_reading: boolean;
  catalog: string[];
}

interface WaitContext {
  current_state_snapshot?: { current_glucose?: unknown; trend?: unknown; age_minutes?: unknown; as_of?: unknown; iob?: unknown } | null;
  therapy_now?: {
    loop?: { iob_u?: unknown; stale?: unknown } | null;
  } | null;
  analysis_request_input?: { range_type?: unknown; focus_hypo_episode_id?: unknown; user_message_text?: unknown; requested_at?: unknown } | null;
  direct_response_input?: { user_message_text?: unknown } | null;
  conversation_context?: { messages?: unknown; recent_messages?: unknown } | null;
}

/** When the caregiver asked: every attempt of one answer has the same start, so a retry does not look like a new wait. */
function askedAt(data: WaitContext, now: Date): string {
  const requested = data.analysis_request_input?.requested_at;
  if (typeof requested === 'string' && Number.isFinite(Date.parse(requested))) return requested;
  const messages = [data.conversation_context?.messages, data.conversation_context?.recent_messages].find(Array.isArray) as Array<{ role?: unknown; created_at?: unknown }> | undefined;
  const asked = messages?.filter((message) => String(message.role ?? '').toUpperCase() === 'USER').at(-1)?.created_at;
  return typeof asked === 'string' && Number.isFinite(Date.parse(asked)) ? asked : now.toISOString();
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function readingAgeMinutes(snapshot: NonNullable<WaitContext['current_state_snapshot']>, now: Date): number | null {
  const stated = finite(snapshot.age_minutes);
  if (stated !== null) return Math.max(0, stated);
  const asOf = typeof snapshot.as_of === 'string' ? Date.parse(snapshot.as_of) : Number.NaN;
  return Number.isFinite(asOf) ? Math.max(0, (now.getTime() - asOf) / 60_000) : null;
}

/** A question without patient data (a general one) has no sentences about them, and real events only. */
export function buildAnswerWaitPlan(context: unknown, options: { doseRequested: boolean; now: Date }): AnswerWaitPlan {
  const data = (context ?? {}) as WaitContext;
  const snapshot = data.current_state_snapshot ?? null;
  const glucose = finite(snapshot?.current_glucose);
  if (!snapshot || glucose === null) return { started_at: askedAt(data, options.now), stale_reading: false, catalog: [] };

  const age = readingAgeMinutes(snapshot, options.now);
  const fresh = age !== null && age <= FRESH_READING_MAX_AGE_MINUTES;
  const catalog: string[] = [];
  // The chat of a hypo shows real events only.
  if (!data.analysis_request_input?.focus_hypo_episode_id) {
    const message = String(data.direct_response_input?.user_message_text ?? data.analysis_request_input?.user_message_text ?? '');
    if (options.doseRequested) {
      const loop = data.therapy_now?.loop ?? null;
      const iob = finite(loop?.iob_u) ?? finite(snapshot.iob);
      if (iob !== null && iob >= MIN_ACTIVE_INSULIN_U && loop?.stale !== true) catalog.push(WAIT_LINES.insulin);
      if (fresh && snapshot.trend) catalog.push(WAIT_LINES.readings);
      catalog.push(WAIT_LINES.plan);
    } else {
      const range = data.analysis_request_input?.range_type;
      if (range) catalog.push(range === 'TODAY' ? WAIT_LINES.today : WAIT_LINES.period);
      if (isCausalQuestion(message)) catalog.push(WAIT_LINES.causes);
    }
  }
  return {
    started_at: askedAt(data, options.now),
    stale_reading: age === null || !fresh,
    catalog,
  };
}
