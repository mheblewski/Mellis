import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@shared/errors/app-error';
import { computeBolusForecast, type BolusForecastChart, type BolusForecastInputs } from '@modules/glucose-forecast/application/bolus-forecast';
import { sanitizeMealItems, type MealItem } from '@modules/meal-candidates/application/meal-items';
import {
  CARD_ONLY_WARNINGS,
  pumpBolusStep,
  roundDownToStep,
  evaluateRemoteCommand,
  REMOTE_COMMAND_POLICY,
  type RemoteCommandContext,
  type RemoteCommandEvaluation,
  type RemoteCommandSource,
} from './remote-command-policy';
import { commandLoopNames, type RemoteCommandMealPayload, type RemoteCommandRecord, type RemoteCommandStore } from './remote-command-record';
import { classifyTrioReply, describeTrioReply, type RemoteCommandStatus } from './remote-command-status';
import { OPEN_PLANNED_BOLUS_STATUSES, type PlannedBolusRecord, type SplitPlan } from './split-bolus';
import type { RescueCommandLink } from '@modules/rescue-carbs/application/rescue-carbs-store';
import type { BolusReminderRequest } from './bolus-reminders';
import { loopSystemNames, remoteCommandDriver, type LoopSystemKind, type RemoteCommandDriver } from '@modules/loop-system/domain/loop-system';
import { classifyLoopReply, describeLoopReply, type LoopReplyStep } from './loop-reply';

/**
 * Remote meals and boluses to Trio (remote-bolus-trio-plan.md W3–W6): the server checks and records, the phone sends.
 * Every command is evaluated twice: for the form (preview) and again when the caregiver confirms (authorize), with
 * fresh data; a block or a warning the caregiver did not see stops it.
 */


/** A meal's bolus the phone never sent to Loop (no confirmation of the carbs). */
export const LOOP_BOLUS_WITHHELD_MESSAGE = 'Loop nie potwierdził węglowodanów: bolusu nie wysłano. Sprawdź w Loopie, czy węglowodany są zapisane, zanim podasz bolus.';

export interface RemoteCommandRequest {
  source: RemoteCommandSource;
  carbs_g: number;
  insulin_u: number;
  bolus_step: number;
  device_id: string;
  conversation_id?: string | null;
  proposal_id?: string | null;
  /** Retrying this command, which Trio refused (REJECTED) or whose bolus it refused after storing the carbs (PARTIAL). */
  follows_command_id?: string | null;
  meal?: { description?: string | null; items?: unknown; macros?: { carbs_g?: number | null; protein_g?: number | null; fat_g?: number | null } | null } | null;
  /** The WBT window's meal (source WBT_SCREEN): the carbs-equivalent and bolus become that meal's WBT. */
  wbt_meal_id?: string | null;
  /** The planned second part of a split meal bolus (source PLANNED_BOLUS): its carbs and bolus join that meal. */
  planned_bolus_id?: string | null;
  /** Rescue carbs (source RESCUE_CARBS): the alert or the chat card the dose answers (none from the meals tab). */
  rescue_alert_id?: string | null;
  rescue_proposal_id?: string | null;
  /** Warning codes shown in the confirmation the caregiver accepted. */
  acknowledged_warnings: string[];
  /** The confirmation's preview named the card (proposal_id), so the card's own warnings were in it and acknowledged. */
  card_warnings_shown?: boolean;
  /** Bolus tab only (bolus-reminders.v1): "Przypomnij" next to the dose. */
  reminders?: BolusReminderRequest[] | null;
  /** Bolus tab only: "Zapisz jako posiłek", the dose becomes a meal of the Meals journal (reminders imply it). */
  create_meal?: boolean;
  /**
   * Bolus tab only ("+15 min"): the meal is eaten this many minutes from now. The dose is checked with the ICR of that
   * time and the command's `carbs_at` is the date the phone gives Trio for the carbs (the bolus starts now).
   */
  meal_in_minutes?: number | null;
  /** How the phone will send it (loop-support-plan.md); builds before Loop support send none: Trio's. */
  driver?: RemoteCommandDriver | null;
}

export interface RemoteCommandPreview {
  carbs_g: number;
  insulin_u: number;
  icr_g_per_u: number | null;
  icr_insulin_u: number | null;
  context: RemoteCommandContext;
  blocks: RemoteCommandEvaluation['blocks'];
  warnings: RemoteCommandEvaluation['warnings'];
  /** The step the dose was rounded to and the command must keep: the pump's (PUMP) or the phone's setting (SETTINGS). */
  bolus_step: number;
  bolus_step_source: 'PUMP' | 'SETTINGS';
  /** The chart above the form (bolus-forecast.v1): 3 hours without and with this dose; null without fresh glucose. */
  forecast: BolusForecastChart | null;
}

/** A command as the app shows it. */
export interface RemoteCommandView {
  id: string;
  /** The phone checks it is the patient it sent for before the push goes out. */
  patient_id: string;
  status: RemoteCommandStatus;
  status_message: string | null;
  source: RemoteCommandSource;
  carbs_g: number;
  insulin_u: number;
  icr_g_per_u: number | null;
  meal_description: string | null;
  conversation_id: string | null;
  proposal_id: string | null;
  follows_command_id: string | null;
  /** WBT of target_meal_record_id (from the WBT window), MEAL_PART (a planned second part), HYPO_TREATMENT (rescue carbs); null for a meal or a correction. */
  purpose: 'WBT' | 'MEAL_PART' | 'HYPO_TREATMENT' | null;
  target_meal_record_id: string | null;
  planned_bolus_id: string | null;
  sent_by_me: boolean;
  authorized_at: string;
  send_deadline: string;
  sent_at: string | null;
  answered_at: string | null;
  meal_record_id: string | null;
  loop_action_id: string | null;
  warnings: RemoteCommandEvaluation['warnings'];
  /** The reminders set with a Bolus tab dose; null without any. */
  reminders: BolusReminderRequest[] | null;
  /** The carbs' date in Trio when the meal is eaten later (Trio's `scheduled_time`); null: now. */
  carbs_at: string | null;
}

/** The context, and for the form's chart the readings, the loop's forecast and the profile (bolus-forecast.v1). */
export type RemoteCommandContextProvider = (patientId: string, now: Date, carbsAt?: Date | null) => Promise<Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'> & { forecast_inputs?: BolusForecastInputs | null }>;

export class RemoteCommandsService {
  constructor(
    private readonly store: RemoteCommandStore,
    private readonly contextProvider: RemoteCommandContextProvider,
    /** Chat cards a command may come from; without it, commands from cards are refused. */
    private readonly proposals: { get(patientId: string, proposalId: string): Promise<{ conversation_id: string; status: string; expires_at: string; split?: SplitPlan | null; carbs_g?: number; insulin_u?: number; warnings?: RemoteCommandEvaluation['warnings'] } | null> } | null = null,
    /** Planned second parts of split meal boluses; without it, PLANNED_BOLUS commands are refused. */
    private readonly plannedBoluses: { get(patientId: string, planId: string): Promise<PlannedBolusRecord | null> } | null = null,
    /** Rescue alerts and cards a RESCUE_CARBS command treats; without it, RESCUE_CARBS commands are refused. */
    private readonly rescue: Pick<RescueCommandLink, 'checkAvailable' | 'reserveForCommand' | 'takenOtherOption'> | null = null,
  ) {}

  /** `meal_in_minutes`: when the carbs will be eaten (the usual pre-bolus when absent): the chart's meal time and, with
   * carbs, the ICR of that time (the Bolus tab's "+15 min" dates the carbs then in Trio). `proposal_id`: a chat card's
   * confirmation, which also shows the card's own warnings. */
  async preview(patientId: string, input: { carbs_g: number; insulin_u: number | null; bolus_step: number; meal_in_minutes?: number | null; proposal_id?: string | null }, now = new Date()): Promise<RemoteCommandPreview> {
    const { forecast_inputs: forecastInputs, ...context } = await this.context(patientId, now, carbsAt(now, input.carbs_g, input.meal_in_minutes));
    const pumpStep = pumpBolusStep(context.pump_bolus_step);
    const step = pumpStep ?? validStep(input.bolus_step);
    const firstPass = evaluateRemoteCommand({ carbs_g: input.carbs_g, insulin_u: input.insulin_u ?? 0, bolus_step: step, context });
    // Without a dose typed in, the form starts from carbs / ICR.
    const insulin = input.insulin_u ?? firstPass.icr_insulin_u ?? 0;
    const evaluation = input.insulin_u === null ? evaluateRemoteCommand({ carbs_g: input.carbs_g, insulin_u: insulin, bolus_step: step, context }) : firstPass;
    return {
      carbs_g: input.carbs_g,
      insulin_u: insulin,
      icr_g_per_u: context.icr_g_per_u,
      icr_insulin_u: evaluation.icr_insulin_u,
      context,
      blocks: evaluation.blocks,
      warnings: withCardWarnings(evaluation.warnings, input.proposal_id ? await this.cardWarnings(patientId, input.proposal_id, { carbs_g: input.carbs_g, insulin_u: insulin, step }) : []),
      bolus_step: step,
      bolus_step_source: pumpStep ? 'PUMP' : 'SETTINGS',
      forecast: chartFor(forecastInputs, { now, carbs_g: input.carbs_g, insulin_u: insulin, icr_g_per_u: context.icr_g_per_u, meal_in_minutes: input.meal_in_minutes ?? null }),
    };
  }

  async authorize(patientId: string, userId: string, request: RemoteCommandRequest, now = new Date()): Promise<RemoteCommandView> {
    const requestedStep = validStep(request.bolus_step);
    if (!request.device_id || request.device_id.length > 200) throw new ValidationError('device_id is required');
    const wbtMealId = request.wbt_meal_id ?? null;
    if ((request.source === 'WBT_SCREEN') !== (wbtMealId !== null)) {
      throw new ValidationError('WBT_SCREEN commands name their meal (wbt_meal_id), and only they do');
    }
    if (wbtMealId && (request.proposal_id || request.follows_command_id)) {
      throw new ValidationError('A WBT command is not sent from a chat card');
    }
    // Rescue carbs to Trio (migration 064): carbs alone, for a hypo; no meal, no card of the bolus kind.
    const rescue = request.source === 'RESCUE_CARBS';
    const rescueAlertId = request.rescue_alert_id ?? null;
    const rescueProposalId = request.rescue_proposal_id ?? null;
    if (!rescue && (rescueAlertId || rescueProposalId)) throw new ValidationError('Only RESCUE_CARBS commands name a rescue alert or card');
    let rescueAlertChecked: string | null = null;
    if (rescue) {
      if (!this.rescue) throw new ValidationError('Rescue carbs cannot be sent to Trio here');
      if (request.insulin_u !== 0 || !(request.carbs_g > 0)) throw new ValidationError('Rescue carbs are carbs alone (insulin_u 0, carbs_g > 0)');
      // Rescue carbs are a portion, never a meal (the alert's treatment column holds at most 50 g).
      if (request.carbs_g > 50) throw new ValidationError('Rescue carbs are at most 50 g');
      if (request.proposal_id || request.follows_command_id || request.wbt_meal_id || request.planned_bolus_id) throw new ValidationError('A rescue command is not a bolus card, retry, WBT or planned part');
      const available = await this.rescue.checkAvailable({ patientId, alertId: rescueAlertId, proposalId: rescueProposalId });
      if (available.status === 'NOT_FOUND') throw new ValidationError('rescue_alert_id / rescue_proposal_id do not match this patient');
      if (available.status === 'ALREADY_LOGGED') {
        throw new ConflictError(`RESCUE_ALREADY_LOGGED: Dosłodzenie jest już zapisane${available.logged_by ? ` (${available.logged_by})` : ''}.`);
      }
      rescueAlertChecked = available.alert_id;
      if (rescueProposalId) await this.assertOptionFree(patientId, rescueProposalId);
    }
    // Reminders come with a Bolus tab meal: they need its carbs (the loop's carb entry makes the meal they belong to).
    const reminders = request.reminders && request.reminders.length > 0 ? request.reminders : null;
    const mealIn = request.meal_in_minutes ?? null;
    if (mealIn !== null) {
      if (request.source !== 'BOLUS_SCREEN') throw new ValidationError('Only BOLUS_SCREEN commands date the meal later (meal_in_minutes)');
      if (!(request.carbs_g > 0)) throw new ValidationError('meal_in_minutes dates the carbs: carbs_g must be above 0');
      if (!Number.isInteger(mealIn) || mealIn < 1 || mealIn > REMOTE_COMMAND_POLICY.max_meal_in_minutes) throw new ValidationError(`meal_in_minutes must be 1–${REMOTE_COMMAND_POLICY.max_meal_in_minutes}`);
    }
    if (reminders && request.source !== 'BOLUS_SCREEN') throw new ValidationError('Only BOLUS_SCREEN commands set reminders');
    if (reminders && !(request.carbs_g > 0)) throw new ValidationError('Reminders are set for a meal: carbs_g must be above 0');
    const createMeal = request.create_meal === true;
    if (createMeal && request.source !== 'BOLUS_SCREEN') throw new ValidationError('Only BOLUS_SCREEN commands ask for a meal (create_meal)');
    if (createMeal && !(request.carbs_g > 0)) throw new ValidationError('A meal needs carbs: carbs_g must be above 0');
    const planId = request.planned_bolus_id ?? null;
    if ((request.source === 'PLANNED_BOLUS') !== (planId !== null)) {
      throw new ValidationError('PLANNED_BOLUS commands name their planned part (planned_bolus_id), and only they do');
    }
    let plan: PlannedBolusRecord | null = null;
    if (planId) {
      if (request.proposal_id) throw new ValidationError('A planned part is not sent from a chat card');
      plan = (await this.plannedBoluses?.get(patientId, planId)) ?? null;
      if (!plan) throw new ValidationError('planned_bolus_id does not match a planned bolus of this patient');
      if (!OPEN_PLANNED_BOLUS_STATUSES.includes(plan.status)) {
        throw new ConflictError(`PLANNED_BOLUS_SETTLED: ${plan.status === 'GIVEN' ? `Tę część bolusa już podano${plan.resolved_by_name ? ` (${plan.resolved_by_name})` : ''}.` : 'Ta część bolusa nie jest już zaplanowana.'}`);
      }
    }
    const follows = await this.followedCommand(patientId, request, now);
    if (follows && (follows.planned_bolus_id ?? null) !== planId) {
      throw new ValidationError('A retry keeps the planned part of the command it follows');
    }
    if (wbtMealId) assertWbtNotGiven(await this.store.listWbtForMeal(patientId, wbtMealId), request.carbs_g);
    if (plan) assertRetriesNewestRefusal(await this.store.listForPlannedBolus(patientId, plan.id), follows, request.carbs_g);
    let splitPlan: SplitPlan | null = null;
    let cardWarnings: RemoteCommandEvaluation['warnings'] = [];
    if (request.proposal_id) {
      // A card is used while it is valid (its data are recent) and only in its own conversation; a retry of its
      // refused command may come later (the values are checked again here anyway).
      const proposal = await this.proposals?.get(patientId, request.proposal_id);
      if (!proposal || proposal.status !== 'PROPOSED' || proposal.conversation_id !== request.conversation_id) {
        throw new ValidationError('proposal_id does not match a bolus card of this conversation');
      }
      if (!follows && Date.parse(proposal.expires_at) <= now.getTime()) {
        throw new ConflictError('PROPOSAL_EXPIRED: Karta jest nieaktualna. Poproś w rozmowie o przeliczenie dawki.');
      }
      assertRetriesNewestRefusal(await this.store.listForProposal(patientId, request.proposal_id), follows, request.carbs_g);
      if (!follows) await this.assertOptionFree(patientId, request.proposal_id);
      // The command that brings the carbs to Trio carries the plan (it makes the meal): the first one, or a retry after
      // Trio stored nothing (REJECTED). A bolus-only retry after PARTIAL joins the meal the stored carbs made.
      splitPlan = !follows || request.carbs_g > 0 ? proposal.split ?? null : null;
      // A build that did not show them (no card_warnings_shown) still sends: its card showed them above the button.
      if (request.card_warnings_shown === true && sameAmounts(proposal, { carbs_g: request.carbs_g, insulin_u: request.insulin_u, step: requestedStep })) cardWarnings = cardOnlyWarnings(proposal.warnings);
    }
    // The chart's inputs are not part of what a command is checked against and stored with.
    const { forecast_inputs: _forecastInputs, ...context } = await this.context(patientId, now, carbsAt(now, request.carbs_g, mealIn));
    assertDriverFitsLoop(context.loop_system ?? 'TRIO', request.driver ?? 'TRIO');
    // The pump's own step wins over the phone's setting: a dose it cannot deliver is refused here, not by Trio.
    const step = pumpBolusStep(context.pump_bolus_step) ?? requestedStep;
    const evaluation = evaluateRemoteCommand({ carbs_g: request.carbs_g, insulin_u: request.insulin_u, bolus_step: step, context });
    if (evaluation.blocks.length > 0) {
      throw new ConflictError(`REMOTE_COMMAND_BLOCKED: ${evaluation.blocks.map((block) => block.message).join(' ')}`);
    }
    // Acknowledged by key: the same kind of warning about newer data (another bolus, a lower reading) is a new one.
    const acknowledged = new Set(request.acknowledged_warnings ?? []);
    const warnings = withCardWarnings(evaluation.warnings, cardWarnings);
    const unseen = warnings.filter((warning) => !acknowledged.has(warning.key));
    if (unseen.length > 0) {
      // Something changed since the confirmation was drawn (a new reading, a bolus): it is shown again.
      throw new ConflictError(`REMOTE_COMMAND_WARNINGS_CHANGED: ${unseen.map((warning) => warning.message).join(' ')}`);
    }
    const record = await this.store.insert({
      patient_id: patientId,
      user_id: userId,
      device_id: request.device_id,
      source: request.source,
      conversation_id: request.conversation_id ?? null,
      proposal_id: request.proposal_id ?? null,
      follows_command_id: follows?.id ?? null,
      carbs_g: request.carbs_g,
      insulin_u: request.insulin_u,
      bolus_step: step,
      icr_g_per_u: context.icr_g_per_u,
      icr_insulin_u: evaluation.icr_insulin_u,
      // WBT carbs and a planned part belong to the meal they are for: no meal of their own.
      meal_payload: request.carbs_g > 0 && !wbtMealId && !plan && !rescue ? mealPayload(request.meal) : null,
      purpose: wbtMealId ? 'WBT' : plan ? 'MEAL_PART' : rescue ? 'HYPO_TREATMENT' : null,
      rescue_alert_id: rescue ? rescueAlertChecked : null,
      rescue_proposal_id: rescue ? rescueProposalId : null,
      target_meal_record_id: wbtMealId ?? plan?.meal_record_id ?? null,
      planned_bolus_id: plan?.id ?? null,
      split_plan: splitPlan,
      reminders,
      create_meal: createMeal,
      context,
      warnings,
      policy_version: REMOTE_COMMAND_POLICY.version,
      send_deadline: new Date(now.getTime() + REMOTE_COMMAND_POLICY.send_window_seconds * 1000).toISOString(),
    });
    if (rescue && this.rescue) {
      // Treated from now on (no reminder, nobody logs it twice); a refusal gives the treatment back. Treated by someone
      // else between the check and here: the command is withdrawn before the phone sends it.
      const reservation = await this.rescue.reserveForCommand({ patientId, commandId: record.id, alertId: rescueAlertChecked, proposalId: rescueProposalId, carbsG: request.carbs_g, atIso: now.toISOString(), userId });
      if (!reservation.reserved) {
        await this.store.transition(patientId, record.id, 'SEND_FAILED', { status_message: 'Dosłodzenie było już zapisane: polecenie nie zostało wysłane.' }).catch(() => undefined);
        throw new ConflictError('RESCUE_ALREADY_LOGGED: Dosłodzenie jest już zapisane.');
      }
    }
    return toView(record, userId);
  }

  /**
   * The card's own warnings (CARD_ONLY_WARNINGS) while the confirmation holds the card's amounts: changed amounts make
   * them the card's history (the phone says so). None for a card of another patient or without the card store.
   */
  private async cardWarnings(patientId: string, proposalId: string, amounts: { carbs_g: number; insulin_u: number; step: number }): Promise<RemoteCommandEvaluation['warnings']> {
    const proposal = await this.proposals?.get(patientId, proposalId).catch(() => null);
    return proposal && sameAmounts(proposal, amounts) ? cardOnlyWarnings(proposal.warnings) : [];
  }

  /** answer-options.v1: a card of another option of the same answer was already sent or logged. */
  private async assertOptionFree(patientId: string, proposalId: string): Promise<void> {
    const taken = await this.rescue?.takenOtherOption?.(patientId, proposalId);
    if (taken) throw new ConflictError(`OPTION_TAKEN: Wybrano już opcję ${taken} tej odpowiedzi; ta karta nie zostanie wysłana.`);
  }

  /** The sending phone reports APNs's answer. */
  async reportSent(patientId: string, userId: string, commandId: string, report: { accepted: boolean; message?: string | null }, now = new Date()): Promise<RemoteCommandView> {
    const command = await this.ownCommand(patientId, userId, commandId);
    const to: RemoteCommandStatus = report.accepted ? 'SENT' : 'SEND_FAILED';
    const updated = await this.store.transition(patientId, commandId, to, {
      sent_at: report.accepted ? now.toISOString() : undefined,
      trio_message: report.accepted ? undefined : (report.message ?? null),
      status_message: report.accepted ? `Polecenie wysłane, czekam na odpowiedź ${loopSystemNames(command.context?.loop_system ?? 'TRIO').genitive}.` : (report.message ?? 'Nie udało się wysłać polecenia.'),
    });
    if (!updated && report.accepted) {
      // A late report (the command already went NO_REPLY or Trio already answered): only the send time is kept.
      await this.store.recordSentAt(patientId, commandId, now.toISOString());
    }
    return toView(updated ?? (await this.store.get(patientId, commandId)) ?? command, userId);
  }

  /**
   * The sending phone reports the loop's answer (a push to that phone). Late answers after NO_REPLY still count. Loop
   * answers each of its pushes on its own: `step` says which one (carbs or bolus).
   *
   * `withheld` (Loop): the phone did not send a meal's bolus because Loop never confirmed its carbs. Nothing is known
   * of the carbs, but the bolus surely was not given: the command stays unanswered (NO_REPLY) with that said, so no
   * caregiver reads "the insulin may have been given". A late confirmation of the carbs then makes it PARTIAL.
   */
  async reportReply(patientId: string, userId: string, commandId: string, reply: { success: boolean; message: string; step?: LoopReplyStep | null; withheld?: boolean }, now = new Date()): Promise<RemoteCommandView> {
    const command = await this.ownCommand(patientId, userId, commandId);
    const message = String(reply.message ?? '').slice(0, 1000);
    const toLoop = remoteCommandDriver(command.context?.loop_system ?? 'TRIO') === 'LOOP';
    if (reply.withheld) {
      if (!toLoop || command.insulin_u <= 0 || command.carbs_g <= 0) throw new ValidationError('Only a meal sent to Loop has a bolus that can be withheld');
      const withheld = await this.store.transition(patientId, commandId, 'NO_REPLY', { trio_message: message, status_message: LOOP_BOLUS_WITHHELD_MESSAGE });
      return toView(withheld ?? (await this.store.get(patientId, commandId)) ?? command, userId);
    }
    if (toLoop && !reply.step) throw new ValidationError('A Loop answer names its step (carbs or bolus)');
    const to = toLoop
      ? classifyLoopReply({ step: reply.step!, success: reply.success, carbs_g: command.carbs_g, insulin_u: command.insulin_u })
      : classifyTrioReply({ success: reply.success, message, carbs_g: command.carbs_g, insulin_u: command.insulin_u });
    const updated = await this.store.transition(patientId, commandId, to, {
      trio_message: message,
      status_message: toLoop ? describeLoopReply(to, message, command.insulin_u) : describeTrioReply(to, message, command.insulin_u),
      answered_at: to === 'TRIO_ACCEPTED' ? undefined : now.toISOString(),
    });
    // Trio stored something: read Nightscout again in a few seconds so the meal does not wait for the minute's sync.
    if (updated && (updated.status === 'TRIO_ACCEPTED' || updated.status === 'SUCCEEDED' || updated.status === 'PARTIAL')) {
      const atIsos = REMOTE_COMMAND_POLICY.sync_after_answer_seconds.map((seconds) => new Date(now.getTime() + seconds * 1000).toISOString());
      try {
        await this.store.requestNightscoutSync?.(patientId, commandId, atIsos);
      } catch {
        // Only faster: the minute's sync still brings the entries.
      }
    }
    return toView(updated ?? (await this.store.get(patientId, commandId)) ?? command, userId);
  }

  async list(patientId: string, userId: string, limit = 20): Promise<RemoteCommandView[]> {
    return (await this.store.list(patientId, limit)).map((record) => toView(record, userId));
  }

  async get(patientId: string, userId: string, commandId: string): Promise<RemoteCommandView> {
    const record = await this.store.get(patientId, commandId);
    if (!record) throw new NotFoundError('Remote command not found');
    return toView(record, userId);
  }

  private async context(patientId: string, now: Date, carbsAt: Date | null = null): Promise<RemoteCommandContext & { forecast_inputs?: BolusForecastInputs | null }> {
    const [base, inFlight] = await Promise.all([this.contextProvider(patientId, now, carbsAt), this.store.findInFlight(patientId, now.toISOString())]);
    const since = new Date(now.getTime() - REMOTE_COMMAND_POLICY.recent_remote_bolus_minutes * 60_000).toISOString();
    const recent = await this.store.findRecentWithInsulin(patientId, since);
    return {
      ...base,
      in_flight_command_id: inFlight?.id ?? null,
      recent_remote_bolus: recent ? { at: recent.sent_at ?? recent.authorized_at, units: recent.insulin_u, status: recent.status } : null,
    };
  }

  /** The refused command a retry follows: the newest of its card, refused, recent, and no carbs again after PARTIAL. */
  private async followedCommand(patientId: string, request: RemoteCommandRequest, now: Date): Promise<RemoteCommandRecord | null> {
    if (!request.follows_command_id) return null;
    const follows = await this.store.get(patientId, request.follows_command_id);
    if (!follows || (follows.status !== 'PARTIAL' && follows.status !== 'REJECTED') || follows.proposal_id !== (request.proposal_id ?? null)) {
      throw new ValidationError('Only a command Trio refused can be retried');
    }
    if (now.getTime() - Date.parse(follows.authorized_at) > REMOTE_COMMAND_POLICY.retry_window_minutes * 60_000) {
      throw new ConflictError('RETRY_TOO_LATE: Minęło ponad 30 minut od odrzuconego polecenia. Poproś w rozmowie o nową dawkę.');
    }
    if (request.carbs_g > 0 && (await this.carbsStoredInChain(patientId, follows))) {
      throw new ValidationError(`Węglowodany są już w ${commandLoopNames(follows).locative}: ponów sam bolus.`);
    }
    return follows;
  }

  /** Whether Trio kept the carbs of this command or of one it retries (a refused retry of a PARTIAL keeps them there). */
  private async carbsStoredInChain(patientId: string, command: RemoteCommandRecord): Promise<boolean> {
    let current: RemoteCommandRecord | null = command;
    for (let depth = 0; current && depth < 10; depth += 1) {
      if (storedCarbs(current)) return true;
      current = current.follows_command_id ? await this.store.get(patientId, current.follows_command_id) : null;
    }
    return false;
  }

  private async ownCommand(patientId: string, userId: string, commandId: string): Promise<RemoteCommandRecord> {
    const command = await this.store.get(patientId, commandId);
    if (!command) throw new NotFoundError('Remote command not found');
    // Only the caregiver who sent it reports for it (Trio answers that phone only).
    if (command.user_id !== userId) throw new ForbiddenError('Only the sender reports on a remote command');
    return command;
  }
}

/** The carbs of an earlier command are in its loop: only the bolus is sent again. */
function carbsAlreadyInLoop(earlier: RemoteCommandRecord[]): string {
  const stored = earlier.find(storedCarbs);
  return `Węglowodany są już w ${stored ? commandLoopNames(stored).locative : 'pętli'}: ponów sam bolus.`;
}

/** Trio kept this command's carbs (or may have: an unanswered one is never sent twice). */
function storedCarbs(command: RemoteCommandRecord): boolean {
  return command.carbs_g > 0 && (command.status === 'PARTIAL' || command.status === 'SUCCEEDED' || command.status === 'NO_REPLY');
}

/**
 * The earlier commands of a card or a planned part, whatever the newest one is (a retry whose send failed leaves the
 * refusal before it standing): a refused dose is sent again only as a retry of the newest refusal, and the carbs Trio
 * already kept are never sent again.
 */
function assertRetriesNewestRefusal(earlier: RemoteCommandRecord[], follows: RemoteCommandRecord | null, carbsG: number): void {
  const refusal = earlier.filter((command) => command.status === 'PARTIAL' || command.status === 'REJECTED').at(-1);
  if (refusal && refusal.id !== follows?.id) {
    throw new ValidationError('A dose Trio refused is retried with follows_command_id of its newest refusal');
  }
  if (carbsG > 0 && earlier.some(storedCarbs)) throw new ValidationError(carbsAlreadyInLoop(earlier));
}

/** The statuses after which a meal's WBT may be sent again (the same ones a card's unique index lets through). */
const WBT_RETRYABLE_STATUSES: ReadonlySet<RemoteCommandStatus> = new Set(['EXPIRED', 'SEND_FAILED', 'REJECTED', 'PARTIAL']);

/**
 * A meal's WBT is given once, like a card's dose: its retries are new commands for the same meal (no follows chain),
 * allowed only while every earlier one was refused or never left (a given WBT, or one that may have been, is not sent
 * again), and the carbs-equivalent Trio kept with a refused bolus (PARTIAL) is never sent again.
 */
function assertWbtNotGiven(earlier: RemoteCommandRecord[], carbsG: number): void {
  const given = earlier.find((command) => !WBT_RETRYABLE_STATUSES.has(command.status));
  if (given) {
    throw new ConflictError(`WBT_ALREADY_SENT: WBT tego posiłku już wysłano do ${commandLoopNames(given).genitive}.`);
  }
  if (carbsG > 0 && earlier.some(storedCarbs)) throw new ValidationError(carbsAlreadyInLoop(earlier));
}

function toView(record: RemoteCommandRecord, userId: string): RemoteCommandView {
  return {
    id: record.id,
    patient_id: record.patient_id,
    status: record.status,
    status_message: record.status_message,
    source: record.source,
    carbs_g: record.carbs_g,
    insulin_u: record.insulin_u,
    icr_g_per_u: record.icr_g_per_u,
    meal_description: record.meal_payload?.description ?? null,
    conversation_id: record.conversation_id,
    proposal_id: record.proposal_id,
    follows_command_id: record.follows_command_id,
    purpose: record.purpose,
    target_meal_record_id: record.target_meal_record_id,
    planned_bolus_id: record.planned_bolus_id,
    sent_by_me: record.user_id === userId,
    authorized_at: record.authorized_at,
    send_deadline: record.send_deadline,
    sent_at: record.sent_at,
    answered_at: record.answered_at,
    meal_record_id: record.meal_record_id,
    loop_action_id: record.loop_action_id,
    warnings: record.warnings,
    reminders: record.reminders ?? null,
    carbs_at: record.context?.carbs_at ?? null,
  };
}

/** The carbs eaten `mealInMinutes` from now (null: now, or no carbs). */
function carbsAt(now: Date, carbsG: number, mealInMinutes: number | null | undefined): Date | null {
  return carbsG > 0 && mealInMinutes ? new Date(now.getTime() + mealInMinutes * 60_000) : null;
}

/** The form's chart; it never fails the preview (no chart instead). */
function chartFor(inputs: BolusForecastInputs | null | undefined, dose: { now: Date; carbs_g: number; insulin_u: number; icr_g_per_u: number | null; meal_in_minutes: number | null }): BolusForecastChart | null {
  if (!inputs) return null;
  try {
    return computeBolusForecast({ ...inputs, ...dose });
  } catch {
    return null;
  }
}

function validStep(step: number): number {
  if (step === 0.05 || step === 0.1) return step;
  throw new ValidationError('bolus_step must be 0.05 or 0.1');
}

/**
 * The phone sends with the driver of the loop the patient runs now: a Trio command never goes to Loop (an older build
 * knows only Trio's), and a phone set up for Loop never sends to a Trio that replaced it.
 */
function assertDriverFitsLoop(loopSystem: LoopSystemKind, driver: RemoteCommandDriver): void {
  const expected = remoteCommandDriver(loopSystem);
  if (expected === driver) return;
  const names = loopSystemNames(loopSystem);
  const message = expected === null
    ? `Mellis nie wysyła poleceń do ${names.genitive}.`
    : driver === 'TRIO' && expected === 'LOOP'
      ? 'Pacjent ma teraz Loop: zaktualizuj Mellisa, żeby wysyłać polecenia do Loopa.'
      : loopSystem === 'UNKNOWN'
        // Nothing recent in Nightscout says which loop it is (commands then go Trio's way).
        ? 'Nightscout nie pokazuje teraz Loopa tego pacjenta: sprawdź, czy Loop wysyła dane do Nightscout.'
        : `Pacjent ma teraz ${names.nominative}: ustaw zdalne sterowanie dla ${names.genitive} w ustawieniach.`;
  throw new ConflictError(`LOOP_DRIVER_MISMATCH: ${message} Nic nie zostało wysłane.`);
}

function mealPayload(meal: RemoteCommandRequest['meal']): RemoteCommandMealPayload | null {
  if (!meal) return null;
  const description = typeof meal.description === 'string' && meal.description.trim() ? meal.description.trim().slice(0, 2000) : null;
  let items: MealItem[] | null = null;
  if (meal.items !== undefined && meal.items !== null) {
    const sanitized = sanitizeMealItems(meal.items);
    if ('problem' in sanitized) throw new ValidationError(`meal.items: ${sanitized.problem}`);
    items = sanitized.items;
  }
  const grams = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000 ? Math.round(value * 10) / 10 : null);
  const macros = meal.macros ? { carbs_g: grams(meal.macros.carbs_g), protein_g: grams(meal.macros.protein_g), fat_g: grams(meal.macros.fat_g) } : null;
  if (!description && (!items || items.length === 0) && !macros) return null;
  return { description, items: items && items.length > 0 ? items : null, macros };
}

/** The warnings of a card that only the card computes (its forecast, advice, meal history). */
function cardOnlyWarnings(warnings: RemoteCommandEvaluation['warnings'] | null | undefined): RemoteCommandEvaluation['warnings'] {
  return (warnings ?? []).filter((warning) => CARD_ONLY_WARNINGS.includes(warning.code));
}

/** The amounts are the card's (its dose rounded down to the step, as the phone does). */
function sameAmounts(card: { carbs_g?: number; insulin_u?: number }, amounts: { carbs_g: number; insulin_u: number; step: number }): boolean {
  if (typeof card.carbs_g !== 'number' || typeof card.insulin_u !== 'number') return false;
  const cardInsulin = Number(card.insulin_u);
  return Number(card.carbs_g) === amounts.carbs_g
    && (Math.abs(cardInsulin - amounts.insulin_u) < 1e-6 || Math.abs(roundDownToStep(cardInsulin, amounts.step) - amounts.insulin_u) < 1e-6);
}

/** The live warnings and the card's own, each key once. */
function withCardWarnings(live: RemoteCommandEvaluation['warnings'], card: RemoteCommandEvaluation['warnings']): RemoteCommandEvaluation['warnings'] {
  const keys = new Set(live.map((warning) => warning.key));
  return [...live, ...card.filter((warning) => !keys.has(warning.key))];
}
