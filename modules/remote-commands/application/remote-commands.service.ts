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
import { DOSE_CALCULATOR_POLICY, doseSafetyWarnings, logCalculatorFailure, safeDoseCalculation, withRemoteBoluses, type DoseCalculation } from './dose-calculator';
import type { MealForecastData } from './meal-dose-forecast';

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
  /**
   * Insulin while glucose is below 70 or a low is near (INSULIN_WHILE_LOW): set only by the separate low-glucose alert
   * of builds that have it (review H1, owner 2026-10-29). Without it such a command is refused, so builds that ack the
   * warning with the one slide cannot send insulin while low. Carbs-only commands never need it.
   */
  low_glucose_confirmed?: boolean;
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
  /**
   * The loop-style calculator for these carbs, lowering only (dose-calculator.v1): its default, the breakdown and the
   * line for under the dose. Builds that ask for it (`dose_default=CALCULATOR`) get its default as `insulin_u`.
   */
  dose_calculation: DoseCalculation | null;
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
export type RemoteCommandContextProvider = (patientId: string, now: Date, carbsAt?: Date | null) => Promise<Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'> & { forecast_inputs?: BolusForecastInputs | null; meal_forecast?: MealForecastData | null }>;

/** A meal sent this long ago with a bolus and the same meal again (same carbs or name) is pointed out (dose-calculator.v1). */
export const SAME_MEAL_POLICY = { window_minutes: 90, carbs_tolerance_g: 1, carbs_tolerance_ratio: 0.05 } as const;
const SAME_MEAL_SOURCES: readonly RemoteCommandSource[] = ['BOLUS_SCREEN', 'CHAT_CARD', 'NEW_MEAL'];
/** Statuses of a command whose bolus may have been given. */
const MAY_HAVE_GIVEN: readonly RemoteCommandStatus[] = ['SENT', 'TRIO_ACCEPTED', 'SUCCEEDED', 'NO_REPLY'];
/** Statuses of a command whose carbs may be in the loop (PARTIAL: the carbs were kept, the bolus refused). */
const CARBS_MAY_BE_STORED: readonly RemoteCommandStatus[] = [...MAY_HAVE_GIVEN, 'PARTIAL'];

/** Insulin while low without the separate confirmation (review H1). */
export const LOW_GLUCOSE_CONFIRMATION_MESSAGE = 'Glukoza jest niska: najpierw węglowodany. Aby mimo to podać insulinę, zaktualizuj aplikację i potwierdź osobno.';

/**
 * A planned part's dose as the server estimates it when it is due, before the calculator lowers it (estimatePlannedBolus
 * without forecast): the later_part reference its authorization is held against (review M2). Null: not known.
 */
export type PlannedPartEstimator = (patientId: string, plan: PlannedBolusRecord, now: Date) => Promise<number | null>;

export class RemoteCommandsService {
  constructor(
    private readonly store: RemoteCommandStore,
    private readonly contextProvider: RemoteCommandContextProvider,
    /** Chat cards a command may come from; without it, commands from cards are refused. */
    private readonly proposals: { get(patientId: string, proposalId: string): Promise<{ conversation_id: string; status: string; expires_at: string; split?: SplitPlan | null; carbs_g?: number; insulin_u?: number; warnings?: RemoteCommandEvaluation['warnings']; purpose?: string; meal_payload?: RemoteCommandMealPayload | null } | null> } | null = null,
    /** Planned second parts of split meal boluses; without it, PLANNED_BOLUS commands are refused. */
    private readonly plannedBoluses: { get(patientId: string, planId: string): Promise<PlannedBolusRecord | null> } | null = null,
    /** Rescue alerts and cards a RESCUE_CARBS command treats; without it, RESCUE_CARBS commands are refused. */
    private readonly rescue: Pick<RescueCommandLink, 'checkAvailable' | 'reserveForCommand' | 'takenOtherOption'> | null = null,
    /** A planned part's dose before the calculator (review M2); without it, the part's planned dose is used. */
    private readonly plannedEstimate: PlannedPartEstimator | null = null,
  ) {}

  /** `meal_in_minutes`: when the carbs will be eaten (the usual pre-bolus when absent): the chart's meal time and, with
   * carbs, the ICR of that time (the Bolus tab's "+15 min" dates the carbs then in Trio). `proposal_id`: a chat card's
   * confirmation, which also shows the card's own warnings. */
  async preview(patientId: string, input: { carbs_g: number; insulin_u: number | null; bolus_step: number; meal_in_minutes?: number | null; proposal_id?: string | null; dose_default?: 'CALCULATOR' | null; source?: RemoteCommandSource | null; planned_bolus_id?: string | null }, now = new Date()): Promise<RemoteCommandPreview> {
    const { forecast_inputs: forecastInputs, meal_forecast: mealForecast, ...context } = await this.context(patientId, now, carbsAt(now, input.carbs_g, input.meal_in_minutes));
    const pumpStep = pumpBolusStep(context.pump_bolus_step);
    const step = pumpStep ?? validStep(input.bolus_step);
    // A planned part is held against the server's own later-part estimate (review M2), as at authorization.
    const plan = input.planned_bolus_id ? await this.plannedBoluses?.get(patientId, input.planned_bolus_id).catch(() => null) ?? null : null;
    // dose-calculator.v1: the loop-style calculator, lowering only, for the carbs on the form.
    const { calculation, failed } = await this.calculate(patientId, { now, carbs_g: input.carbs_g, step, context, meal_forecast: mealForecast ?? null, plan, where: 'preview' });
    const firstPass = evaluateRemoteCommand({ carbs_g: input.carbs_g, insulin_u: input.insulin_u ?? 0, bolus_step: step, context, calculator_default_u: calculation?.default_u ?? null });
    // Without a dose typed in, the form starts from the calculator's default (builds that show it), else carbs / ICR.
    const insulin = input.insulin_u ?? (input.dose_default === 'CALCULATOR' && input.carbs_g > 0 && calculation ? calculation.default_u : firstPass.icr_insulin_u ?? 0);
    const evaluation = input.insulin_u === null ? evaluateRemoteCommand({ carbs_g: input.carbs_g, insulin_u: insulin, bolus_step: step, context, calculator_default_u: calculation?.default_u ?? null }) : firstPass;
    const proposal = input.proposal_id ? await this.proposals?.get(patientId, input.proposal_id).catch(() => null) ?? null : null;
    const cardWarnings = proposal && sameAmounts(proposal, { carbs_g: input.carbs_g, insulin_u: insulin, step }) ? cardOnlyWarnings(proposal.warnings) : [];
    const source = input.source ?? (input.proposal_id ? 'CHAT_CARD' : 'BOLUS_SCREEN');
    const safety = evaluation.blocks.every((block) => block.code !== 'INVALID_AMOUNTS')
      ? await this.safetyWarnings(patientId, { now, carbs_g: input.carbs_g, insulin_u: insulin, calculation, failed, context, source, card_purpose: proposal?.purpose ?? null, proposal_id: input.proposal_id ?? null, description: proposal?.meal_payload?.description ?? null, follows: plan !== null || source === 'WBT_SCREEN' })
      : [];
    return {
      carbs_g: input.carbs_g,
      insulin_u: insulin,
      icr_g_per_u: context.icr_g_per_u,
      icr_insulin_u: evaluation.icr_insulin_u,
      context,
      blocks: evaluation.blocks,
      warnings: liveAndCardWarnings([...evaluation.warnings, ...safety], cardWarnings),
      bolus_step: step,
      bolus_step_source: pumpStep ? 'PUMP' : 'SETTINGS',
      forecast: chartFor(forecastInputs, { now, carbs_g: input.carbs_g, insulin_u: insulin, icr_g_per_u: context.icr_g_per_u, meal_in_minutes: input.meal_in_minutes ?? null }),
      dose_calculation: calculation,
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
    let cardPurpose: string | null = null;
    let cardMealName: string | null = null;
    if (request.proposal_id) {
      // A card is used while it is valid (its data are recent) and only in its own conversation; a retry of its
      // refused command may come later (the values are checked again here anyway).
      const proposal = await this.proposals?.get(patientId, request.proposal_id);
      if (!proposal || proposal.status !== 'PROPOSED' || proposal.conversation_id !== request.conversation_id) {
        throw new ValidationError('proposal_id does not match a bolus card of this conversation');
      }
      cardPurpose = proposal.purpose ?? null;
      cardMealName = proposal.meal_payload?.description ?? null;
      if (!follows && Date.parse(proposal.expires_at) <= now.getTime()) {
        throw new ConflictError('PROPOSAL_EXPIRED: Karta jest nieaktualna. Poproś w rozmowie o przeliczenie dawki.');
      }
      assertRetriesNewestRefusal(await this.store.listForProposal(patientId, request.proposal_id), follows, request.carbs_g);
      if (!follows) await this.assertOptionFree(patientId, request.proposal_id);
      // The command that brings the carbs to Trio carries the plan (it makes the meal): the first one, or a retry after
      // Trio stored nothing (REJECTED). A bolus-only retry after PARTIAL joins the meal the stored carbs made.
      splitPlan = !follows || request.carbs_g > 0 ? proposal.split ?? null : null;
      // A build that did not show them (no card_warnings_shown) still sends: its card showed them above the button. The
      // live checks below are required from every build either way (review H2): a card's warning is added, never
      // instead of a live one.
      if (request.card_warnings_shown === true && sameAmounts(proposal, { carbs_g: request.carbs_g, insulin_u: request.insulin_u, step: requestedStep })) cardWarnings = cardOnlyWarnings(proposal.warnings);
    }
    // The chart's inputs are not part of what a command is checked against and stored with.
    const { forecast_inputs: _forecastInputs, meal_forecast: mealForecast, ...liveContext } = await this.context(patientId, now, carbsAt(now, request.carbs_g, mealIn));
    assertDriverFitsLoop(liveContext.loop_system ?? 'TRIO', request.driver ?? 'TRIO');
    // The pump's own step wins over the phone's setting: a dose it cannot deliver is refused here, not by Trio.
    const step = pumpBolusStep(liveContext.pump_bolus_step) ?? requestedStep;
    // dose-calculator.v1, recomputed on live data: a dose dangerously above it (or insulin while carbs come first, or
    // recent insulin it could not count) must be among the acknowledged warnings, whatever the phone showed.
    const { calculation, failed } = await this.calculate(patientId, { now, carbs_g: request.carbs_g, step, context: liveContext, meal_forecast: mealForecast ?? null, plan, where: 'authorize' });
    const context: RemoteCommandContext = { ...liveContext, dose_calculation: calculation };
    const evaluation = evaluateRemoteCommand({ carbs_g: request.carbs_g, insulin_u: request.insulin_u, bolus_step: step, context, calculator_default_u: calculation?.default_u ?? null });
    if (evaluation.blocks.length > 0) {
      throw new ConflictError(`REMOTE_COMMAND_BLOCKED: ${evaluation.blocks.map((block) => block.message).join(' ')}`);
    }
    const safety = await this.safetyWarnings(patientId, { now, carbs_g: request.carbs_g, insulin_u: request.insulin_u, calculation, failed, context, source: request.source, card_purpose: cardPurpose, proposal_id: request.proposal_id ?? null, description: request.meal?.description ?? cardMealName, follows: follows !== null || wbtMealId !== null || plan !== null });
    // Acknowledged by key: the same kind of warning about newer data (another bolus, a lower reading) is a new one. The
    // live warnings are always required with their live values; the card's own are added to them (review H2).
    const acknowledged = new Set(request.acknowledged_warnings ?? []);
    const warnings = liveAndCardWarnings([...evaluation.warnings, ...safety], cardWarnings);
    const unseen = warnings.filter((warning) => !acknowledged.has(warning.key));
    if (unseen.length > 0) {
      // Something changed since the confirmation was drawn (a new reading, a bolus): it is shown again.
      throw new ConflictError(`REMOTE_COMMAND_WARNINGS_CHANGED: ${unseen.map((warning) => warning.message).join(' ')}`);
    }
    // Insulin while low: acknowledged AND confirmed on its own (review H1). A build without the separate alert acks it
    // with the slide only: refused, it cannot send insulin while low (intended). Carbs alone never get here.
    if (request.insulin_u > 0 && warnings.some((warning) => warning.code === 'INSULIN_WHILE_LOW') && request.low_glucose_confirmed !== true) {
      throw new ConflictError(`LOW_GLUCOSE_CONFIRMATION_REQUIRED: ${LOW_GLUCOSE_CONFIRMATION_MESSAGE}`);
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

  /**
   * The same meal sent with a bolus in the last 90 min from any screen or conversation (dose-calculator.v1, change 4):
   * the same name, or the same carbs. None for a retry, a WBT or a planned part (they belong to their meal).
   */
  private async sameMealWarnings(patientId: string, command: { carbs_g: number; insulin_u: number; source: RemoteCommandSource; proposal_id: string | null; description: string | null; follows: boolean }, now: Date): Promise<RemoteCommandEvaluation['warnings']> {
    if (!this.store.listRecentMealBoluses || command.follows || !(command.carbs_g > 0) || !(command.insulin_u > 0) || !SAME_MEAL_SOURCES.includes(command.source)) return [];
    const since = new Date(now.getTime() - SAME_MEAL_POLICY.window_minutes * 60_000).toISOString();
    let recent: RemoteCommandRecord[];
    try {
      recent = await this.store.listRecentMealBoluses(patientId, since);
    } catch (error) {
      // Not checked is not "not sent" (review L4): logged, and the caregiver acknowledges checking the history.
      logCalculatorFailure({ where: 'remote-commands.same-meal', patient_id: patientId }, error);
      return [{ code: 'SAME_MEAL_CHECK_UNAVAILABLE', key: 'SAME_MEAL_CHECK_UNAVAILABLE', severity: 'DANGER', message: 'Nie udało się sprawdzić, czy ten posiłek już wysłano — sprawdź historię bolusów, zanim podasz.' }];
    }
    const name = mealNameOf(command.description);
    const tolerance = Math.max(SAME_MEAL_POLICY.carbs_tolerance_g, command.carbs_g * SAME_MEAL_POLICY.carbs_tolerance_ratio);
    const match = recent
      .filter((earlier) => MAY_HAVE_GIVEN.includes(earlier.status) && earlier.carbs_g > 0 && earlier.insulin_u > 0 && !earlier.purpose)
      .filter((earlier) => !command.proposal_id || earlier.proposal_id !== command.proposal_id)
      .filter((earlier) => (name !== '' && mealNameOf(earlier.meal_payload?.description) === name) || Math.abs(earlier.carbs_g - command.carbs_g) <= tolerance + 1e-9)
      .sort((left, right) => Date.parse(right.sent_at ?? right.authorized_at) - Date.parse(left.sent_at ?? left.authorized_at))[0];
    if (!match) return [];
    const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(match.sent_at ?? match.authorized_at)) / 60_000));
    const where = match.source === 'CHAT_CARD' ? 'z rozmowy' : match.source === 'BOLUS_SCREEN' ? 'z zakładki Bolus' : 'z aplikacji';
    return [{
      code: 'ALREADY_SENT_FOR_MEAL',
      // The same command's RECENT_REMOTE_BOLUS says less: it is left out (withoutSameCommand).
      key: `ALREADY_SENT_FOR_MEAL:command:${match.id}:${match.sent_at ?? match.authorized_at}`,
      severity: 'DANGER',
      message: `${minutes} min temu wysłano ${where} ${match.carbs_g} g i ${formatUnitsPl(match.insulin_u)} j${match.meal_payload?.description ? ` (${match.meal_payload.description})` : ''}. Jeśli to ten sam posiłek, ta dawka poda insulinę drugi raz.`,
    }];
  }

  /**
   * The calculator for a command (dose-calculator.v1), never throwing but never silent (review M4). A planned part is
   * held against the server's own later-part estimate (review M2): its IOB and COB hold the meal's first part. The
   * meal's own just-sent carbs do not switch the near-low gate off (review L2).
   */
  private async calculate(patientId: string, input: { now: Date; carbs_g: number; step: number; context: Pick<RemoteCommandContext, 'icr_g_per_u'>; meal_forecast: MealForecastData | null; plan: PlannedBolusRecord | null; where: string }): Promise<{ calculation: DoseCalculation | null; failed: boolean }> {
    const { now, plan, step } = input;
    const data = await this.withoutOwnMealCarbs(patientId, input.meal_forecast, now);
    const log = { where: `remote-commands.${input.where}`, patient_id: patientId, id: plan?.id ?? null };
    if (plan) {
      let laterDose: number | null = null;
      try {
        laterDose = this.plannedEstimate ? await this.plannedEstimate(patientId, plan, now) : null;
      } catch (error) {
        logCalculatorFailure({ ...log, where: `${log.where}.planned-estimate` }, error);
        return { calculation: null, failed: true };
      }
      const dose = laterDose ?? plan.fixed_insulin_u ?? plan.planned_insulin_u;
      return safeDoseCalculation({ now, carbs_g: 0, icr_g_per_u: input.context.icr_g_per_u, step, data, later_part: { dose_u: Number.isFinite(dose) ? dose : null } }, log);
    }
    return safeDoseCalculation({ now, carbs_g: input.carbs_g, icr_g_per_u: input.context.icr_g_per_u, step, data }, log);
  }

  /**
   * The newest carbs of the last 15 min hold the near-low gate back (fast carbs may already work), except the carbs of a
   * meal GlucoMind itself just sent without insulin (review L2): those are the meal the insulin is for, not rescue carbs.
   * A meal is a command without purpose (not WBT, a part or rescue carbs) with a split plan, a meal or "Zapisz jako
   * posiłek", whose carbs' time is within 5 min of the newest carbs. Without the list (an error): the gate stays on.
   */
  private async withoutOwnMealCarbs(patientId: string, data: MealForecastData | null, now: Date): Promise<MealForecastData | null> {
    if (!data?.last_carbs_at || !this.store.listRecent) return data;
    const carbsMs = Date.parse(data.last_carbs_at);
    let recent: RemoteCommandRecord[];
    try {
      recent = await this.store.listRecent(patientId, new Date(now.getTime() - 30 * 60_000).toISOString());
    } catch (error) {
      logCalculatorFailure({ where: 'remote-commands.own-meal-carbs', patient_id: patientId }, error);
      return { ...data, last_carbs_at: null };
    }
    const own = recent.some((command) => command.carbs_g > 0 && command.insulin_u === 0 && command.purpose === null && command.source !== 'RESCUE_CARBS'
      && (command.split_plan !== null || command.meal_payload !== null || command.create_meal === true)
      && CARBS_MAY_BE_STORED.includes(command.status)
      && Math.abs(Date.parse(command.context?.carbs_at ?? command.sent_at ?? command.authorized_at) - carbsMs) <= 5 * 60_000);
    return own ? { ...data, last_carbs_at: null } : data;
  }

  /** The live dose checks (preview and authorization alike) and the same-meal check of a command with insulin. */
  private async safetyWarnings(patientId: string, input: { now: Date; carbs_g: number; insulin_u: number; calculation: DoseCalculation | null; failed: boolean; context: RemoteCommandContext; source: RemoteCommandSource; card_purpose: string | null; proposal_id: string | null; description: string | null; follows: boolean }): Promise<RemoteCommandEvaluation['warnings']> {
    if (!(input.insulin_u > 0)) return [];
    return [
      ...doseSafetyWarnings({
        insulin_u: input.insulin_u,
        calculation: input.calculation,
        recent: recentWithRemote(input.context, input.now),
        calculator_checks: calculatorChecks(input.source, input.card_purpose, input.carbs_g),
        glucose: input.context.glucose,
        now: input.now,
        calculator_failed: input.failed,
      }),
      ...await this.sameMealWarnings(patientId, { carbs_g: input.carbs_g, insulin_u: input.insulin_u, source: input.source, proposal_id: input.proposal_id, description: input.description, follows: input.follows }, input.now),
    ];
  }

  private async context(patientId: string, now: Date, carbsAt: Date | null = null): Promise<RemoteCommandContext & { forecast_inputs?: BolusForecastInputs | null; meal_forecast?: MealForecastData | null }> {
    const [base, inFlight] = await Promise.all([this.contextProvider(patientId, now, carbsAt), this.store.findInFlight(patientId, now.toISOString())]);
    const since = new Date(now.getTime() - REMOTE_COMMAND_POLICY.recent_remote_bolus_minutes * 60_000).toISOString();
    const recent = await this.store.findRecentWithInsulin(patientId, since);
    // Every remote bolus of the recent-insulin window that may have been given (review L3), for the recent insulin.
    const windowMinutes = base.recent_insulin?.window_minutes ?? DOSE_CALCULATOR_POLICY.recent_insulin_default_minutes;
    let remotes: RemoteCommandContext['recent_remote_boluses'] = null;
    if (this.store.listRecent) {
      try {
        remotes = (await this.store.listRecent(patientId, new Date(now.getTime() - windowMinutes * 60_000).toISOString()))
          .filter((command) => command.insulin_u > 0 && MAY_HAVE_GIVEN.includes(command.status))
          .map((command) => ({ id: command.id, at: command.sent_at ?? command.authorized_at, units: command.insulin_u }));
      } catch (error) {
        // The newest one (recent_remote_bolus) is still counted.
        logCalculatorFailure({ where: 'remote-commands.recent-remote-boluses', patient_id: patientId }, error);
      }
    }
    return {
      ...base,
      in_flight_command_id: inFlight?.id ?? null,
      recent_remote_bolus: recent ? { at: recent.sent_at ?? recent.authorized_at, units: recent.insulin_u, status: recent.status } : null,
      ...(remotes ? { recent_remote_boluses: remotes } : {}),
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
      ? 'Pacjent ma teraz Loop: zaktualizuj aplikację Mellis, żeby wysyłać polecenia do Loopa.'
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

/**
 * The recent-insulin window with every remote bolus Nightscout does not show yet (review L3): the whole window's
 * (recent_remote_boluses), else the newest of the last 30 min; matched against all of Nightscout's boluses.
 */
function recentWithRemote(context: RemoteCommandContext, now: Date) {
  const remote = context.recent_remote_bolus;
  const remotes = context.recent_remote_boluses ?? (remote ? [{ at: remote.at, units: remote.units }] : []);
  const nightscout = context.last_bolus ? [context.last_bolus] : [];
  return withRemoteBoluses(context.recent_insulin ?? null, remotes, now, nightscout);
}

/**
 * The live warnings, always (review H2), and the card's own added to them. A card's warning never replaces or hides a
 * live one: where both say the same (the card's DOSE_ABOVE_FORMULA and the live DOSE_ABOVE_CALCULATOR, the card's and
 * the live ALREADY_SENT_FOR_MEAL) the card's is the one left out, so the live values are what is acknowledged. A remote
 * bolus the live same-meal warning names is said once, there.
 */
function liveAndCardWarnings(live: RemoteCommandEvaluation['warnings'], card: RemoteCommandEvaluation['warnings']): RemoteCommandEvaluation['warnings'] {
  const sameMealAt = new Set(live.filter((warning) => warning.code === 'ALREADY_SENT_FOR_MEAL' && warning.key.startsWith('ALREADY_SENT_FOR_MEAL:command:')).map((warning) => warning.key.split(':').slice(3).join(':')));
  const kept = live.filter((warning) => !(warning.code === 'RECENT_REMOTE_BOLUS' && sameMealAt.has(warning.key.slice('RECENT_REMOTE_BOLUS:'.length))));
  const liveCodes = new Set(kept.map((warning) => warning.code));
  const cardAdded = card.filter((warning) => !(warning.code === 'DOSE_ABOVE_FORMULA' && liveCodes.has('DOSE_ABOVE_CALCULATOR'))
    && !(warning.code === 'ALREADY_SENT_FOR_MEAL' && liveCodes.has('ALREADY_SENT_FOR_MEAL')));
  return withCardWarnings(kept, cardAdded);
}

function mealNameOf(description: unknown): string {
  return typeof description === 'string' ? description.trim().toLowerCase().replace(/[\u2018\u2019]/g, "'") : '';
}

function formatUnitsPl(units: number): string {
  return (Math.round(units * 100) / 100).toString().replace('.', ',');
}

/**
 * Doses held against the calculator. Exempt only without carbs (review M1): a pre-bolus (its carbs come later) or WBT
 * insulin alone (fat and protein, which neither COB nor the calculator counts; the WBT screen has its own standard
 * dose). A command with carbs is held against the calculator for those carbs whatever its purpose: an edited pre-bolus
 * card or a WBT with its carbs-equivalent. Insulin while low is checked for every dose.
 */
function calculatorChecks(source: RemoteCommandSource | null, cardPurpose: string | null, carbsG: number): boolean {
  if (carbsG > 0) return true;
  return cardPurpose !== 'PRE_BOLUS' && source !== 'WBT_SCREEN';
}
