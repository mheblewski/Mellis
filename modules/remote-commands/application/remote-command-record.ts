import type { MealItem } from '@modules/meal-candidates/application/meal-items';
import type { RemoteCommandContext, RemoteCommandSource, RemoteCommandWarning } from './remote-command-policy';
import type { RemoteCommandStatus } from './remote-command-status';
import type { SplitPlan } from './split-bolus';
import type { BolusReminderRequest } from './bolus-reminders';
import { loopSystemNames, type LoopSystemKind, type LoopSystemNames } from '@modules/loop-system/domain/loop-system';

/** The meal a command's carbs are for; it becomes the meal record once the loop's carb entry arrives. */
export interface RemoteCommandMealPayload {
  description: string | null;
  items: MealItem[] | null;
  macros: { carbs_g: number | null; protein_g: number | null; fat_g: number | null } | null;
}

export interface RemoteCommandRecord {
  id: string;
  patient_id: string;
  user_id: string;
  device_id: string;
  source: RemoteCommandSource;
  conversation_id: string | null;
  proposal_id: string | null;
  /** A retry of this failed command (REJECTED, or PARTIAL: carbs stored, bolus refused). */
  follows_command_id: string | null;
  /**
   * WBT: the carbs-equivalent and bolus are the WBT of target_meal_record_id (no new meal); MEAL_PART: the second part
   * of a split meal bolus (planned_bolus_id) for target_meal_record_id; HYPO_TREATMENT: rescue carbs (no meal); null otherwise.
   */
  purpose: 'WBT' | 'MEAL_PART' | 'HYPO_TREATMENT' | null;
  /** The chat card's purpose (MEAL, CORRECTION, PRE_BOLUS), read with unmatched commands; absent elsewhere. */
  card_purpose?: string | null;
  target_meal_record_id: string | null;
  planned_bolus_id: string | null;
  /** HYPO_TREATMENT (rescue carbs to Trio, migration 064): the alert or chat card the dose answers; null otherwise. */
  rescue_alert_id?: string | null;
  rescue_proposal_id?: string | null;
  /** The card's split (the first part of a split meal bolus): its meal gets the planned second part. */
  split_plan: SplitPlan | null;
  carbs_g: number;
  insulin_u: number;
  bolus_step: number;
  icr_g_per_u: number | null;
  icr_insulin_u: number | null;
  meal_payload: RemoteCommandMealPayload | null;
  /** Bolus tab only (migration 073): the reminders set with the dose; the dose becomes a meal that has them. */
  reminders?: BolusReminderRequest[] | null;
  /** Bolus tab only (migration 089): "Zapisz jako posiłek" was ticked; the dose becomes a meal of the journal. */
  create_meal?: boolean;
  context: RemoteCommandContext;
  warnings: Array<{ code: RemoteCommandWarning; key: string; message: string }>;
  policy_version: string;
  status: RemoteCommandStatus;
  trio_message: string | null;
  status_message: string | null;
  authorized_at: string;
  send_deadline: string;
  sent_at: string | null;
  answered_at: string | null;
  loop_action_id: string | null;
  meal_record_id: string | null;
  matched_at: string | null;
}

export type NewRemoteCommand = Omit<RemoteCommandRecord, 'id' | 'status' | 'trio_message' | 'status_message' | 'authorized_at' | 'sent_at' | 'answered_at' | 'loop_action_id' | 'meal_record_id' | 'matched_at'>;

export interface RemoteCommandStore {
  /** Stores an authorized command; ConflictError when another command of the patient or this proposal is in flight. */
  insert(command: NewRemoteCommand): Promise<RemoteCommandRecord>;
  get(patientId: string, commandId: string): Promise<RemoteCommandRecord | null>;
  list(patientId: string, limit: number): Promise<RemoteCommandRecord[]>;
  /** The patient's command still waiting for Trio, after expiring the ones past their deadlines. */
  findInFlight(patientId: string, nowIso: string): Promise<RemoteCommandRecord | null>;
  /** Moves a command forward; null when the move is not allowed from its current status (nothing changes). */
  transition(patientId: string, commandId: string, to: RemoteCommandStatus, fields: { trio_message?: string | null; status_message?: string | null; sent_at?: string; answered_at?: string }): Promise<RemoteCommandRecord | null>;
  /** Keeps the send time of a command whose "sent" report came after it went NO_REPLY. */
  recordSentAt(patientId: string, commandId: string, sentAtIso: string): Promise<void>;
  /** The newest command with insulin that may have reached Trio since a time (not counting AUTHORIZED). */
  findRecentWithInsulin(patientId: string, sinceIso: string): Promise<RemoteCommandRecord | null>;
  /**
   * Commands with carbs and insulin authorized since a time, any screen or conversation (dose-calculator.v1: the same
   * meal sent twice). Optional: without it the check is skipped.
   */
  listRecentMealBoluses?(patientId: string, sinceIso: string): Promise<RemoteCommandRecord[]>;
  /**
   * Every command authorized since a time, newest first (dose-calculator.v1 review: the remote boluses of the whole
   * recent-insulin window, L3; the meal's own just-sent carbs, L2). Optional: without it those checks use less.
   */
  listRecent?(patientId: string, sinceIso: string): Promise<RemoteCommandRecord[]>;
  /** Every command sent from a chat card (retries and failed sends too), oldest first. */
  listForProposal(patientId: string, proposalId: string): Promise<RemoteCommandRecord[]>;
  /** Every command sent for a planned second part (retries and failed sends too), oldest first. */
  listForPlannedBolus(patientId: string, plannedBolusId: string): Promise<RemoteCommandRecord[]>;
  /** Every WBT command sent from a meal's WBT window (retries and failed sends too), oldest first. */
  listWbtForMeal(patientId: string, mealRecordId: string): Promise<RemoteCommandRecord[]>;
  /** Queues Nightscout reads of the patient's sources at these times (once per command and time). */
  requestNightscoutSync?(patientId: string, commandId: string, atIsos: string[]): Promise<void>;
}

/** The name of the loop the command went to ("Trio", "Loop"); rows from before loop-support went to Trio. */
export function commandLoopNames(command: { context?: { loop_system?: LoopSystemKind } | null }): LoopSystemNames {
  return loopSystemNames(command.context?.loop_system ?? 'TRIO');
}
