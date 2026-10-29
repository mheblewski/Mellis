import { hasRescueTreatment, type RescueAlertRecord } from './rescue-alert-policy';
import type { RescueCarbProposalRecord } from './rescue-carbs-store';

/** The rescue block of an alert's conversation (the rescue-carbs plan, "Kontrakt API"). */

export const RESCUE_CHART_BEFORE_MS = 2 * 60 * 60_000;
export const RESCUE_CHART_AFTER_MS = 3 * 60 * 60_000;

export function toRescueCarbsView(alert: RescueAlertRecord, extras: {
  readings: Array<{ observed_at: string; glucose_mgdl: number }>;
  logged_by: string | null;
  declined_by?: string | null;
}): Record<string, unknown> {
  const evaluation = alert.evaluation;
  const latest = extras.readings.at(-1) ?? null;
  const detectedAt = alert.notified_at ?? alert.first_flag_at;
  return {
    alert_id: alert.id,
    status: alert.status,
    level: alert.level,
    trigger_source: alert.trigger_source,
    detected_at: detectedAt,
    glucose_mgdl: evaluation.glucose?.value ?? null,
    glucose_at: evaluation.glucose?.at ?? null,
    delta_per_5min: evaluation.delta_per_5min,
    predicted_min_mgdl: evaluation.predicted_min_mgdl,
    predicted_low_at: evaluation.predicted_low_at,
    minutes_to_low: evaluation.minutes_to_low,
    proposal: alert.proposal
      ? {
          carbs_g: alert.proposal.carbs_g,
          min_g: alert.proposal.min_g,
          max_g: alert.proposal.max_g,
          basis: alert.proposal.basis,
          csf_mgdl_per_g: alert.proposal.csf_mgdl_per_g,
          isf_mgdl_per_u: alert.proposal.isf_mgdl_per_u,
          icr_g_per_u: alert.proposal.icr_g_per_u,
          iob_u: alert.proposal.iob_u,
          cob_g: alert.proposal.cob_g,
          trio_carbs_req_g: alert.proposal.trio_carbs_req_g,
          explanation: alert.proposal.explanation,
          warnings: alert.proposal.warnings ?? [],
        }
      : null,
    glucose_readings: extras.readings.map((reading) => ({ observed_at: reading.observed_at, value: reading.glucose_mgdl })),
    // The forecast the push was based on (from its time on).
    prediction: (evaluation.curve?.points ?? []).map((point) => ({ at: point.at, value: point.value })),
    latest_glucose: latest ? { value: latest.glucose_mgdl, observed_at: latest.observed_at } : null,
    treatment: hasRescueTreatment(alert)
      ? {
          event_id: alert.treatment_event_id,
          /** Sent to Trio (the loop counts them); false: GlucoMind only. */
          in_loop: (alert.treatment_command_id ?? null) !== null,
          command_id: alert.treatment_command_id ?? null,
          carbs_g: alert.treatment_carbs_g,
          given_at: alert.treated_at,
          logged_by: extras.logged_by,
          logged_at: alert.treated_at,
          source: alert.treatment_source ?? 'ALERT',
          proposal_id: alert.treatment_proposal_id,
        }
      : null,
    // "Nie podaję" (no reminder follows); null once carbs were logged after all.
    declined: alert.declined_at && !hasRescueTreatment(alert) ? { declined_at: alert.declined_at, declined_by: extras.declined_by ?? null } : null,
    notified_at: alert.notified_at,
    reminder_sent_at: alert.reminder_sent_at,
  };
}

/** Dose cards under the answer that prepared them (the last answer to that caregiver message). */
export function withRescueCarbProposals(conversation: Record<string, unknown>, proposals: RescueCarbProposalRecord[], acceptedProposalId: string | null): Record<string, unknown> {
  if (proposals.length === 0 || !Array.isArray(conversation.messages)) return conversation;
  // The newest answer's cards stay usable (one per option); older answers' cards are replaced by them.
  const latestMessage = proposals.at(-1)!.user_message_id;
  const byUserMessage = new Map<string, Record<string, unknown>[]>();
  for (const proposal of proposals) {
    const list = byUserMessage.get(proposal.user_message_id) ?? [];
    // An older card is replaced by the newest one; the one confirmed stays ACCEPTED.
    const status = proposal.status === 'ACCEPTED' || proposal.id === acceptedProposalId ? 'ACCEPTED' : proposal.user_message_id === latestMessage ? 'PROPOSED' : 'SUPERSEDED';
    // A card without an alert keeps what confirming it logged (an alert's card shows the alert's treatment).
    const logged = proposal.treatment ? { carbs_g: proposal.treatment.carbs_g, given_at: proposal.treatment.given_at, in_loop: proposal.treatment.in_loop } : null;
    list.push({ id: proposal.id, carbs_g: proposal.carbs_g, reason: proposal.reason, option_key: proposal.option_key, status, created_at: proposal.created_at, ...(logged ? { logged } : {}) });
    byUserMessage.set(proposal.user_message_id, list);
  }
  const answeredBy = (message: Record<string, unknown>): string | null => {
    if (String(message.role ?? '').toUpperCase() !== 'ASSISTANT') return null;
    const answered = (message.metadata as Record<string, unknown> | null)?.user_message_id;
    return typeof answered === 'string' ? answered : null;
  };
  const list = conversation.messages as Array<Record<string, unknown>>;
  const lastAnswer = new Map<string, number>();
  list.forEach((message, index) => {
    const answered = answeredBy(message);
    if (answered) lastAnswer.set(answered, index);
  });
  const messages = list.map((message, index) => {
    const answered = answeredBy(message);
    const cards = answered && lastAnswer.get(answered) === index ? byUserMessage.get(answered) : undefined;
    return cards ? { ...message, rescue_carb_proposals: cards } : message;
  });
  return { ...conversation, messages };
}

/** carbs_g of a POST: 1–50 g in 0.5 g steps. */
export function parseRescueCarbs(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(number) || number < 1 || number > 50 || Math.round(number * 2) !== number * 2) return null;
  return number;
}

/** given_at of a POST: from 2 h ago to 5 min ahead (a phone clock slightly ahead); absent = now. */
export function parseRescueGivenAt(value: unknown, now: Date): string | null {
  if (value === undefined || value === null) return now.toISOString();
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  const ms = Date.parse(value);
  if (ms < now.getTime() - 2 * 60 * 60_000 || ms > now.getTime() + 5 * 60_000) return null;
  return new Date(Math.min(ms, now.getTime())).toISOString();
}
