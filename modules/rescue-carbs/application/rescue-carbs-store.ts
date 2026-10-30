import type { AnswerOptionKey } from '@modules/ai-gateway/application/answer-options';
import type { RescueAlertRecord, RescueAlertStatus } from './rescue-alert-policy';
import type { RescueEvaluation } from './rescue-detection';
import type { RescueDoseProposal } from './rescue-dose';

/** source_system and events.payload.entry_source of the carbs logged in GlucoMind (never in Nightscout or the loop). */
export const RESCUE_CARB_ENTRY_SOURCE = 'GLUCOMIND';

/** RESCUE_CARB_ALERTS_ENABLED: the worker evaluates predicted lows and pushes alerts (devices still opt in). */
export function isRescueCarbAlertsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.RESCUE_CARB_ALERTS_ENABLED ?? '').trim());
}

export interface RescueCarbProposalRecord {
  id: string;
  patient_id: string;
  /** null: a card of an ordinary conversation (no alert); confirming it logs the carbs like the meals tab's "+". */
  alert_id: string | null;
  conversation_id: string;
  user_message_id: string;
  carbs_g: number;
  reason: string | null;
  /** The answer's option the card belongs to (answer-options.v1, migration 067); null without options. */
  option_key: AnswerOptionKey | null;
  status: 'PROPOSED' | 'ACCEPTED' | 'DISCARDED';
  created_at: string;
  /** What confirming a card without an alert logged (an alert's card: the alert's treatment). event_id is null while
   * carbs sent to Trio have not come back through Nightscout yet. */
  treatment: { event_id: string | null; carbs_g: number; given_at: string; logged_by_user_id: string | null; in_loop: boolean; command_id: string | null } | null;
}

/** Rescue carbs sent to Trio (migration 064): the alert or card is treated by the command, then by its Trio entry. */
export interface RescueCommandLink {
  /** Refuses (ALREADY_LOGGED) when the alert or card already has a treatment; before the command is stored.
   * `issued_at` (stale-alerts.v1): when the named card was proposed, else when the named alert last pushed; null for
   * neither (the meals tab), and absent from older stores. */
  checkAvailable(args: { patientId: string; alertId: string | null; proposalId: string | null }): Promise<{ status: 'OK'; alert_id: string | null; issued_at?: string | null } | { status: 'ALREADY_LOGGED'; logged_by: string | null } | { status: 'NOT_FOUND' }>;
  /** Marks the alert (the given one, the card's, or the open one) and the card treated by the stored command;
   * reserved false when the named card or alert was treated meanwhile (the command must not go). */
  reserveForCommand(args: { patientId: string; commandId: string; alertId: string | null; proposalId: string | null; carbsG: number; atIso: string; userId: string }): Promise<{ alert_id: string | null; reserved: boolean }>;
  /** answer-options.v1: another option of the same answer was already sent or logged (its key), so this card is not. */
  takenOtherOption?(patientId: string, proposalId: string): Promise<string | null>;
  /** The command's Trio entry arrived: it is the alert's and card's treatment. */
  linkCommandEntry(patientId: string, commandId: string, carbEventId: string): Promise<void>;
  /** Treatments of commands Trio refused or that never left are given back (the alert can remind again). */
  releaseFailedCommandTreatments(): Promise<number>;
}

/** "Zatwierdź Y g" on a card without an alert. */
export type ChatRescueProposalResult =
  | { status: 'LOGGED'; proposal: RescueCarbProposalRecord; alert_id: string | null }
  | { status: 'ALREADY_LOGGED'; logged_by: string | null }
  | { status: 'OPTION_TAKEN'; option: string }
  | { status: 'PROPOSAL_NOT_FOUND' };

export type RescueTreatmentResult =
  | { status: 'LOGGED'; alert: RescueAlertRecord; event_id: string }
  | { status: 'ALREADY_LOGGED'; logged_by: string | null }
  | { status: 'NOT_FOUND' }
  | { status: 'PROPOSAL_NOT_FOUND' };

/** "Nie podaję": repeating it keeps the first decision; carbs already logged win. */
export type RescueDeclineResult =
  | { status: 'DECLINED'; alert: RescueAlertRecord }
  | { status: 'ALREADY_LOGGED'; logged_by: string | null }
  | { status: 'NOT_FOUND' };

export interface RescueCarbsStore {
  listPatientsWithAlertDevices(): Promise<string[]>;
  listAlertDevices(patientId: string): Promise<Array<{ device_id: string; push_token: string }>>;
  getActiveAlert(patientId: string): Promise<RescueAlertRecord | null>;
  insertAlert(alert: { patientId: string; status: 'PENDING' | 'NOTIFIED'; evaluation: RescueEvaluation; now: string }): Promise<RescueAlertRecord | null>;
  touchAlert(alertId: string, args: { evaluation: RescueEvaluation; now: string; clearSince: string | null }): Promise<void>;
  /**
   * The first push or the reminder goes out (status NOTIFIED, its conversation, one send attempt counted). The first
   * push only from PENDING and the one reminder only from NOTIFIED without a reminder or a decline, so two workers never
   * both push; null otherwise.
   */
  markNotified(alertId: string, args: { patientId: string; evaluation: RescueEvaluation; proposal: RescueDoseProposal; now: string; reminder: boolean; conversationTitle: string }): Promise<RescueAlertRecord | null>;
  /**
   * Claims a resend of a push that reached no phone yet (one more attempt counted): null when the alert is no longer
   * NOTIFIED, was declined or treated, the push was delivered meanwhile, or the last try is under 45 s old.
   */
  claimPushResend(alertId: string, args: { reminder: boolean; now: string }): Promise<RescueAlertRecord | null>;
  /** The push (or the reminder) reached at least one phone: no more resends. */
  markPushDelivered(alertId: string, args: { reminder: boolean; now: string }): Promise<void>;
  closeAlert(alertId: string, args: { status: Extract<RescueAlertStatus, 'RESOLVED' | 'EXPIRED' | 'CANCELLED'>; outcome: unknown | null; now: string }): Promise<void>;
  /** Newest eaten carbs in [from, to] of any kind (a meal or rescue carbs), and the newest rescue carbs (HYPO_TREATMENT). */
  getRecentEatenCarbs(patientId: string, fromIso: string, toIso: string): Promise<{ last_carbs_at: string | null; last_hypo_treatment_at: string | null }>;
}
