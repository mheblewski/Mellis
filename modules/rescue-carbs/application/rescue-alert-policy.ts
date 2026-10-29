import type { RescueDoseProposal } from './rescue-dose';
import { RESCUE_DETECTION_POLICY, type RescueEvaluation, type RescueLevel, type RescueReading, type RescueTriggerSource } from './rescue-detection';

/**
 * The life of one rescue carb alert: PENDING after the first flag, NOTIFIED (push sent) after the second one (Harvey
 * 2012: two flags in a row), TREATED once a caregiver logged the carbs, then RESOLVED / EXPIRED. A rescue-carbs.v2
 * evaluation (it carries `confirmed`) pushes a predicted low only once confirmed (the calibrated forecast or the CGM
 * falling) on a reading newer than the first flag; Trio's raw signals only start the PENDING step. Lows now keep v1's rule.
 * One active alert per patient; one reminder push at most. A caregiver who declines the carbs ("Nie podaję") gets no
 * reminder: only a worse level than the one announced starts a new alert.
 */

export const RESCUE_ALERT_POLICY = {
  /** The second flag must come at least this long after the first, with a newer reading. */
  confirm_after_minutes: 4,
  /** A first flag never confirmed is dropped after this. */
  pending_max_minutes: 15,
  reminder_after_minutes: 15,
  /** Glucose and forecast >= 80 this long close the alert. */
  clear_for_minutes: 15,
  /** After the logged carbs: the 15-minute recheck; a low still coming then starts a new alert. */
  retreat_after_minutes: 15,
  max_open_minutes: 120,
  outcome_window_minutes: 45,
  /**
   * A push that reached no phone (every device failed, no device, or the device list failed) is sent again on the
   * next evaluations, at most this often and for this long after it first went out (owner decision 2026-10-26).
   */
  resend_every_seconds: 45,
  resend_for_minutes: 30,
} as const;

export type RescueAlertStatus = 'PENDING' | 'NOTIFIED' | 'TREATED' | 'RESOLVED' | 'EXPIRED' | 'CANCELLED';

export interface RescueAlertOutcome {
  /** Lowest CGM value from the alert until 45 min later (or until it closed). */
  min_glucose_mgdl: number | null;
  went_below_70: boolean;
  treated: boolean;
  /** "Nie podaję" was chosen (and no carbs were logged afterwards). */
  declined: boolean;
  treatment_carbs_g: number | null;
  minutes_to_treatment: number | null;
  /** No carbs logged and glucose stayed >= 70: the alert was not needed. */
  false_alarm: boolean;
  closed_reason: string;
}

export interface RescueAlertRecord {
  id: string;
  patient_id: string;
  status: RescueAlertStatus;
  level: RescueLevel;
  trigger_source: RescueTriggerSource;
  first_flag_at: string;
  first_flag_reading_at: string | null;
  notified_at: string | null;
  /** The level the last push announced (a later URGENT_LOW sends the reminder at once). */
  notified_level: RescueLevel | null;
  reminder_sent_at: string | null;
  /**
   * Delivery of the alert's push and of its reminder (migration 078): sends tried and when one reached a phone.
   * Absent on records without delivery tracking (the offline backtest): nothing is resent for them.
   */
  alert_push_attempts?: number;
  alert_last_push_attempt_at?: string | null;
  alert_delivered_at?: string | null;
  reminder_push_attempts?: number;
  reminder_last_push_attempt_at?: string | null;
  reminder_delivered_at?: string | null;
  last_evaluated_at: string;
  clear_since: string | null;
  evaluation: RescueEvaluation;
  proposal: RescueDoseProposal | null;
  conversation_id: string | null;
  treatment_event_id: string | null;
  treatment_carbs_g: number | null;
  treated_at: string | null;
  treated_by_user_id: string | null;
  /** ALERT (its own card), CHAT_CARD (a card of a conversation) or MANUAL ("+" → "Dosłodzenie" in the meals tab). */
  treatment_source: 'ALERT' | 'CHAT_CARD' | 'MANUAL' | null;
  treatment_proposal_id: string | null;
  /** The carbs went to Trio as this remote command (treated from its authorization; the Trio entry becomes
   * treatment_event_id once it is matched; a refused command gives the treatment back). */
  treatment_command_id?: string | null;
  /** "Nie podaję": the caregiver decided not to give rescue carbs for this alert. */
  declined_at: string | null;
  declined_by_user_id: string | null;
  outcome: RescueAlertOutcome | null;
  resolved_at: string | null;
  created_at: string;
}

export type RescueAlertDecision =
  | { action: 'NONE'; clear_since?: string | null }
  | { action: 'START_PENDING' }
  | { action: 'NOTIFY' }
  | { action: 'REMIND' }
  | { action: 'CANCEL' }
  | { action: 'CLOSE'; status: 'RESOLVED' | 'EXPIRED'; reason: string; restart: 'NONE' | 'PENDING' | 'NOTIFY' };

const LEVEL_RANK: Record<RescueLevel, number> = { PREDICTED_LOW: 1, LOW_NOW: 2, URGENT_LOW: 3 };

const minutesBetween = (fromIso: string | null, now: Date): number => (fromIso ? (now.getTime() - Date.parse(fromIso)) / 60_000 : Number.NaN);

export function decideRescueAlert(active: RescueAlertRecord | null, evaluation: RescueEvaluation, now: Date): RescueAlertDecision {
  const policy = RESCUE_ALERT_POLICY;
  const triggered = evaluation.status === 'TRIGGER';
  const urgent = triggered && evaluation.level === 'URGENT_LOW';
  // rescue-carbs.v2: a predicted low needs its confirmation; v1 evaluations have no `confirmed` and need two flags.
  const gated = evaluation.confirmed !== undefined && evaluation.level === 'PREDICTED_LOW';

  if (!active) {
    if (!triggered) return { action: 'NONE' };
    return urgent ? { action: 'NOTIFY' } : { action: 'START_PENDING' };
  }

  if (active.status === 'PENDING') {
    if (minutesBetween(active.first_flag_at, now) > policy.pending_max_minutes) return { action: 'CANCEL' };
    if (evaluation.status === 'NO_DATA') return { action: 'NONE' };
    if (!triggered) return { action: 'CANCEL' };
    const newerReading = evaluation.glucose && active.first_flag_reading_at
      ? Date.parse(evaluation.glucose.at) > Date.parse(active.first_flag_reading_at)
      : true;
    if (gated) return evaluation.confirmed && newerReading ? { action: 'NOTIFY' } : { action: 'NONE' };
    if (urgent || (minutesBetween(active.first_flag_at, now) >= policy.confirm_after_minutes && newerReading)) return { action: 'NOTIFY' };
    return { action: 'NONE' };
  }

  if (active.status !== 'NOTIFIED' && active.status !== 'TREATED') return { action: 'NONE' };

  // Glucose and forecast back above 80 long enough: the alert is over.
  const clearSince = evaluation.status === 'NO_DATA' ? active.clear_since : evaluation.clear ? active.clear_since ?? now.toISOString() : null;
  if (clearSince && minutesBetween(clearSince, now) >= policy.clear_for_minutes) {
    return { action: 'CLOSE', status: 'RESOLVED', reason: 'CLEARED', restart: 'NONE' };
  }

  if (active.status === 'TREATED') {
    const sinceTreatment = minutesBetween(active.treated_at, now);
    if (triggered && sinceTreatment >= policy.retreat_after_minutes) {
      // The recheck after 15 min: still low or a low still coming, so the next alert starts (urgent: at once).
      return { action: 'CLOSE', status: 'RESOLVED', reason: 'RETRIGGERED_AFTER_TREATMENT', restart: urgent ? 'NOTIFY' : 'PENDING' };
    }
    if (sinceTreatment >= policy.max_open_minutes) return { action: 'CLOSE', status: 'RESOLVED', reason: 'TREATED_TIMEOUT', restart: 'NONE' };
    return { action: 'NONE', clear_since: clearSince };
  }

  // NOTIFIED, nothing logged yet.
  if (minutesBetween(active.notified_at, now) >= policy.max_open_minutes) {
    return { action: 'CLOSE', status: 'EXPIRED', reason: active.declined_at ? 'DECLINED' : 'NO_TREATMENT_LOGGED', restart: 'NONE' };
  }
  if (active.declined_at) {
    // "Nie podaję": no reminder. A worse level than the push announced (a real low after a predicted one, < 54 after
    // < 70) is a new situation, so the next alert starts (urgent: at once).
    const announced = active.notified_level ?? active.level;
    if (triggered && evaluation.level && LEVEL_RANK[evaluation.level] > LEVEL_RANK[announced]) {
      return { action: 'CLOSE', status: 'RESOLVED', reason: 'ESCALATED_AFTER_DECLINE', restart: urgent ? 'NOTIFY' : 'PENDING' };
    }
    return { action: 'NONE', clear_since: clearSince };
  }
  if (triggered && !active.reminder_sent_at && (!gated || evaluation.confirmed)) {
    if (urgent && active.notified_level !== 'URGENT_LOW') return { action: 'REMIND' };
    if (minutesBetween(active.notified_at, now) >= policy.reminder_after_minutes) return { action: 'REMIND' };
  }
  // The one reminder is out and glucose got worse than its push said (a real low, < 54): a new situation, as after
  // "Nie podaję", so the next alert starts instead of silence until the alert expires.
  const lastPushed = active.notified_level ?? active.level;
  if (triggered && active.reminder_sent_at && evaluation.level && LEVEL_RANK[evaluation.level] > LEVEL_RANK[lastPushed]) {
    return { action: 'CLOSE', status: 'RESOLVED', reason: 'ESCALATED_AFTER_REMINDER', restart: urgent ? 'NOTIFY' : 'PENDING' };
  }
  return { action: 'NONE', clear_since: clearSince };
}

/**
 * The push to send again (the newest one: the reminder once it went out), or null: a NOTIFIED alert whose push reached
 * no phone yet, not declined or treated, within 30 min of that push and 45 s after the last try. The resend has the
 * same alert id (one collapse id on the phone, one bell entry).
 */
export function rescuePushToResend(alert: RescueAlertRecord, now: Date): 'ALERT' | 'REMINDER' | null {
  const policy = RESCUE_ALERT_POLICY;
  if (alert.status !== 'NOTIFIED' || alert.declined_at || hasRescueTreatment(alert)) return null;
  const reminder = alert.reminder_sent_at !== null;
  const sentAt = reminder ? alert.reminder_sent_at : alert.notified_at;
  const attempts = (reminder ? alert.reminder_push_attempts : alert.alert_push_attempts) ?? 0;
  const delivered = reminder ? alert.reminder_delivered_at : alert.alert_delivered_at;
  if (!sentAt || attempts === 0 || delivered) return null;
  if (minutesBetween(sentAt, now) > policy.resend_for_minutes) return null;
  const lastAttempt = (reminder ? alert.reminder_last_push_attempt_at : alert.alert_last_push_attempt_at) ?? sentAt;
  if (now.getTime() - Date.parse(lastAttempt) < policy.resend_every_seconds * 1000) return null;
  return reminder ? 'REMINDER' : 'ALERT';
}

/** What happened after the alert: the basis of its false-alarm rate. */
export function computeRescueOutcome(alert: Pick<RescueAlertRecord, 'notified_at' | 'first_flag_at' | 'treated_at' | 'treatment_carbs_g' | 'declined_at'>, readings: RescueReading[], reason: string, now: Date): RescueAlertOutcome {
  const startIso = alert.notified_at ?? alert.first_flag_at;
  const startMs = Date.parse(startIso);
  const endMs = Math.min(now.getTime(), startMs + RESCUE_ALERT_POLICY.outcome_window_minutes * 60_000);
  const values = readings
    .filter((reading) => Date.parse(reading.at) >= startMs && Date.parse(reading.at) <= endMs)
    .map((reading) => reading.value);
  const min = values.length > 0 ? Math.min(...values) : null;
  const treated = alert.treated_at !== null;
  const below = min !== null && min < RESCUE_DETECTION_POLICY.low_mgdl;
  return {
    min_glucose_mgdl: min,
    went_below_70: below,
    treated,
    declined: !treated && Boolean(alert.declined_at),
    treatment_carbs_g: alert.treatment_carbs_g,
    minutes_to_treatment: treated ? Math.round((Date.parse(alert.treated_at!) - startMs) / 60_000) : null,
    false_alarm: !treated && min !== null && !below,
    closed_reason: reason,
  };
}

/** An alert has its treatment: logged in GlucoMind, or sent to Trio (rescue carbs to Trio, migration 064). */
export function hasRescueTreatment(alert: Pick<RescueAlertRecord, 'treatment_event_id' | 'treatment_command_id'>): boolean {
  return alert.treatment_event_id !== null || (alert.treatment_command_id ?? null) !== null;
}
