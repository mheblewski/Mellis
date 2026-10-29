import { ConflictError, NotFoundError } from '@shared/errors/app-error';
import { REMOTE_COMMAND_MATCH_LOOKBACK_MINUTES } from './remote-command-reconciler';
import { commandLoopNames, type RemoteCommandRecord } from './remote-command-record';
import {
  OPEN_PLANNED_BOLUS_STATUSES,
  cardMealCarbs,
  mealCarbsChangeUpdates,
  plannedMealCarbs,
  planParts,
  planTrigger,
  plannedBolusDueAt,
  SPLIT_BOLUS_POLICY,
  toPlannedBolusSummary,
  type PlannedBolusRecord,
  type PlannedBolusStatus,
  type PlannedBolusSummary,
} from './split-bolus';

/**
 * The planned second parts of split meal boluses (split-bolus.v1): made when the first part's meal is saved, settled
 * when either caregiver gives (a remote command, or a manual bolus assigned to the meal as an addition) or skips it,
 * expired when nobody did within SPLIT_BOLUS_POLICY.expire_after_due_minutes.
 */

export interface PlannedBolusStore {
  create(plan: Omit<PlannedBolusRecord, 'id' | 'status' | 'notified_at' | 'resolved_at' | 'resolved_by_user_id' | 'resolved_by_name' | 'given_command_id' | 'given_loop_action_id' | 'given_insulin_u' | 'created_at'>): Promise<PlannedBolusRecord | null>;
  get(patientId: string, planId: string): Promise<PlannedBolusRecord | null>;
  latestForMeal(patientId: string, mealRecordId: string): Promise<PlannedBolusRecord | null>;
  listForProposals(patientId: string, proposalIds: string[]): Promise<Map<string, PlannedBolusRecord>>;
  /** Every plan of a meal (optional: older stores show the current one only). */
  listForMeal?(patientId: string, mealRecordId: string): Promise<PlannedBolusRecord[]>;
  /** Every part of each card (optional: older stores show the current one only). */
  listAllForProposals?(patientId: string, proposalIds: string[]): Promise<Map<string, PlannedBolusRecord[]>>;
  listOpen(): Promise<PlannedBolusRecord[]>;
  markNotified(patientId: string, planId: string): Promise<boolean>;
  /** An open part follows its meal's carbs (optional: older stores leave the parts as planned). */
  followMealChange?(patientId: string, planId: string, fields: { carbs_g: number; dose_carbs_g: number | null; planned_insulin_u: number; meal_carbs_g: number; meal_change_g: number; cancel: boolean; reopen: boolean; meal_excess_g: number }): Promise<boolean>;
  resolve(patientId: string, planId: string, to: Exclude<PlannedBolusStatus, 'SCHEDULED' | 'NOTIFIED'>, fields?: { user_id?: string | null; command_id?: string | null; loop_action_id?: string | null; insulin_u?: number | null }): Promise<PlannedBolusRecord | null>;
}

export interface PlannedBolusServiceDeps {
  store: PlannedBolusStore;
  commands: {
    latestForPlannedBolus(patientId: string, planId: string): Promise<RemoteCommandRecord | null>;
    /** The commands of a chat card (its first command and its retries). */
    listForProposal?(patientId: string, proposalId: string): Promise<RemoteCommandRecord[]>;
  };
  /** Moves the meal's WBT reminder to no earlier than this (never two doses within an hour). */
  postponeWbtReminder?(patientId: string, mealRecordId: string, notBeforeIso: string): Promise<void>;
  log?(event: Record<string, unknown>): void;
}

/** A command that may still deliver (the button stays hidden on both phones while it is on its way or unanswered). */
export const LIVE_COMMAND_STATUSES: readonly string[] = ['AUTHORIZED', 'SENT', 'TRIO_ACCEPTED', 'SUCCEEDED', 'NO_REPLY'];

/** The meal's insulin excess changed with a carbs change (grams removed beyond the later parts). */
export interface MealExcessChange {
  before_g: number;
  after_g: number;
  /** after_g / the card's ICR; null without it. */
  excess_u: number | null;
}

export class PlannedBolusService {
  constructor(private readonly deps: PlannedBolusServiceDeps) {}

  /**
   * The meal of a card's command gets its later part, due the plan's delay after the meal start: more carbs with their
   * dose (SPLIT), or the dose for the carbs sent (DEFERRED_INSULIN; the carbs the caregiver actually sent, minus the
   * insulin sent with them). A glucose condition is waited for until its waiting time is over (later-plan.v1).
   */
  /**
   * The card's insulin a later dose takes off: what its commands delivered or may have delivered, not what the first
   * one asked for (a bolus Trio refused, PARTIAL, gave nothing; its bolus-only retry did). Null: nothing to take off.
   */
  async cardInsulinGiven(plan: Pick<PlannedBolusRecord, 'patient_id' | 'proposal_id' | 'subtract_first_insulin' | 'first_insulin_u'>): Promise<number | null> {
    if (!plan.subtract_first_insulin) return null;
    if (!plan.proposal_id || !this.deps.commands.listForProposal) return plan.first_insulin_u;
    const commands = await this.deps.commands.listForProposal(plan.patient_id, plan.proposal_id);
    const given = commands
      .filter((command) => !command.planned_bolus_id && LIVE_COMMAND_STATUSES.includes(command.status))
      .reduce((sum, command) => sum + Math.max(0, command.insulin_u ?? 0), 0);
    return Math.round(given * 100) / 100;
  }

  /** When the meal's latest earlier part was given (its dose took off the loop's extra insulin until then); null: none. */
  async earlierPartGivenAt(plan: Pick<PlannedBolusRecord, 'id' | 'patient_id' | 'meal_record_id' | 'part_index'>): Promise<string | null> {
    const parts = await this.deps.store.listForMeal?.(plan.patient_id, plan.meal_record_id).catch(() => []) ?? [];
    const given = parts
      .filter((part) => part.id !== plan.id && part.status === 'GIVEN' && (part.part_index ?? 0) < (plan.part_index ?? 0) && part.resolved_at)
      .map((part) => part.resolved_at as string)
      .sort();
    return given.at(-1) ?? null;
  }

  /**
   * The meal's carbs changed (a change from the chat, its page or "Cofnij"): its open later parts follow them, so a dose
   * still to come is not for carbs that are no longer there (mealCarbsChangeUpdates).
   */
  async followMealCarbs(
    patientId: string,
    mealRecordId: string,
    mealCarbsG: number | null,
    step = 0.05,
    options: { carbsFromCaregiver?: boolean } = {},
  ): Promise<MealExcessChange | null> {
    if (mealCarbsG === null || !Number.isFinite(mealCarbsG) || !this.deps.store.listForMeal || !this.deps.store.followMealChange) return null;
    const parts = await this.deps.store.listForMeal(patientId, mealRecordId);
    if (parts.length === 0) return null;
    // A part whose command is on its way keeps the numbers that were sent (audit 2026-10-26): cancelling it would
    // leave insulin the loop gave marked as switched off.
    const locked = new Set<string>();
    for (const part of parts.filter((candidate) => OPEN_PLANNED_BOLUS_STATUSES.includes(candidate.status))) {
      const command = await this.deps.commands.latestForPlannedBolus(patientId, part.id).catch(() => null);
      if (command && LIVE_COMMAND_STATUSES.includes(command.status)) locked.add(part.id);
    }
    // Carbs the caregiver set are the whole meal: a card without item macros compares them with the card's own.
    const baseline = options.carbsFromCaregiver ? cardMealCarbs(parts) : null;
    const before = parts.reduce((sum, part) => sum + (part.meal_excess_g ?? 0), 0);
    let after = before;
    for (const update of mealCarbsChangeUpdates(parts, mealCarbsG, step, { locked, baseline_when_unknown: baseline })) {
      const previous = parts.find((candidate) => candidate.id === update.plan_id)?.meal_excess_g ?? 0;
      const applied = await this.deps.store.followMealChange(patientId, update.plan_id, update);
      if (applied) after += update.meal_excess_g - previous;
      this.deps.log?.({ event: 'planned_bolus_meal_changed', planned_bolus_id: update.plan_id, meal_record_id: mealRecordId, meal_carbs_g: mealCarbsG, meal_change_g: update.meal_change_g, carbs_g: update.carbs_g, dose_carbs_g: update.dose_carbs_g, cancelled: update.cancel, reopened: update.reopen, meal_excess_g: update.meal_excess_g, applied });
    }
    if (after === before) return null;
    const icr = parts.find((part) => part.icr_g_per_u && part.icr_g_per_u > 0)?.icr_g_per_u ?? null;
    return { before_g: before, after_g: after, excess_u: icr ? Math.round((after / icr) * 100) / 100 : null };
  }

  async createForMeal(command: RemoteCommandRecord, mealRecordId: string, mealStartedAt: string): Promise<PlannedBolusRecord | null> {
    let first: PlannedBolusRecord | null = null;
    let insulinTakenOff = false;
    for (const [index, split] of planParts(command.split_plan).entries()) {
      const deferred = split.kind === 'DEFERRED_INSULIN';
      if ((!deferred && split.later_carbs_g <= 0) || (deferred && command.carbs_g <= 0)) continue;
      const dueAt = plannedBolusDueAt(mealStartedAt, split.later_after_minutes);
      const glucoseTrigger = split.trigger !== undefined && planTrigger(split) !== 'AFTER_MINUTES';
      // The card's insulin is taken off the one dose the plan chose when the card was made (the same the card's estimate
      // took it off); plans stored before that flag: the first computed dose for the card's own carbs.
      const takesOff = split.subtract_card_insulin !== undefined
        ? split.subtract_card_insulin && !insulinTakenOff
        : deferred && !insulinTakenOff && (split.fixed_insulin_u === null || split.fixed_insulin_u === undefined) && (split.dose_carbs_g === null || split.dose_carbs_g === undefined);
      if (takesOff) insulinTakenOff = true;
      // One part that cannot be stored (e.g. an estimate over the 30 U limit) never stops the parts after it.
      const plan = await this.deps.store.create({
        kind: deferred ? 'DEFERRED_INSULIN' : 'SPLIT',
        patient_id: command.patient_id,
        meal_record_id: mealRecordId,
        proposal_id: command.proposal_id,
        conversation_id: command.conversation_id,
        first_command_id: command.id,
        first_carbs_g: command.carbs_g,
        first_insulin_u: command.insulin_u,
        carbs_g: split.later_carbs_g,
        planned_insulin_u: split.later_insulin_u,
        icr_g_per_u: command.icr_g_per_u,
        now_percent: split.now_percent,
        delay_minutes: split.later_after_minutes,
        due_at: dueAt,
        trigger: split.trigger ?? null,
        threshold_mgdl: split.threshold_mgdl ?? null,
        dose_carbs_g: split.dose_carbs_g ?? null,
        fixed_insulin_u: split.fixed_insulin_u ?? null,
        drop_cover_g: split.drop_cover_g ?? null,
        subtract_first_insulin: takesOff,
        wait_until: glucoseTrigger && split.wait_minutes ? new Date(Date.parse(dueAt) + split.wait_minutes * 60_000).toISOString() : null,
        part_index: index,
        // The meal gets the whole meal's carbs (the reconciler fills it right after, remote-command-reconciler fillMeal).
        meal_carbs_g: command.meal_payload?.macros ? plannedMealCarbs(command.carbs_g, command.split_plan) : null,
      }).catch((error: unknown) => {
        this.deps.log?.({ event: 'planned_bolus_create_failed', remote_command_id: command.id, meal_record_id: mealRecordId, part_index: index, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
        return null;
      });
      this.deps.log?.({ event: plan ? 'planned_bolus_created' : 'planned_bolus_not_created', remote_command_id: command.id, meal_record_id: mealRecordId, planned_bolus_id: plan?.id ?? null, part_index: index, due_at: plan?.due_at ?? null });
      first = first ?? plan;
    }
    return first;
  }

  /**
   * A second part's command reached the loop: given by its sender. Not after PARTIAL (Trio kept the carbs, refused the
   * bolus): no insulin was given, so the part stays open for the bolus-only retry.
   */
  async markGivenByCommand(command: RemoteCommandRecord, loopActionId: string): Promise<void> {
    if (!command.planned_bolus_id || command.status === 'PARTIAL') return;
    const plan = await this.deps.store.resolve(command.patient_id, command.planned_bolus_id, 'GIVEN', {
      user_id: command.user_id,
      command_id: command.id,
      loop_action_id: loopActionId,
      insulin_u: command.insulin_u,
    });
    if (plan) await this.afterGiven(plan);
  }

  /** A manual bolus the caregiver assigned to the meal as an addition after the first part settles its plan. */
  async markGivenByLoopAction(plan: PlannedBolusRecord, action: { id: string; assigned_by_user_id: string | null; bolus_units: number | null }): Promise<boolean> {
    const settled = await this.deps.store.resolve(plan.patient_id, plan.id, 'GIVEN', {
      user_id: action.assigned_by_user_id,
      loop_action_id: action.id,
      insulin_u: action.bolus_units,
    });
    if (settled) await this.afterGiven(settled);
    return settled !== null;
  }

  async skip(patientId: string, userId: string, planId: string): Promise<PlannedBolusRecord> {
    const plan = await this.deps.store.get(patientId, planId);
    if (!plan) throw new NotFoundError('Planned bolus not found');
    const command = await this.deps.commands.latestForPlannedBolus(patientId, planId);
    if (command && LIVE_COMMAND_STATUSES.includes(command.status)) {
      throw new ConflictError(`PLANNED_BOLUS_SENDING: Ta część bolusa została już wysłana do ${commandLoopNames(command).genitive}.`);
    }
    const skipped = await this.deps.store.resolve(patientId, planId, 'SKIPPED', { user_id: userId });
    if (!skipped) throw new ConflictError('PLANNED_BOLUS_SETTLED: Ta część bolusa nie jest już zaplanowana.');
    return skipped;
  }

  async summaryForMeal(patientId: string, mealRecordId: string): Promise<PlannedBolusSummary | null> {
    const plan = await this.deps.store.latestForMeal(patientId, mealRecordId);
    if (!plan) return null;
    return toPlannedBolusSummary(plan, await this.openCommand(plan));
  }

  async summariesForProposals(patientId: string, proposalIds: string[]): Promise<Map<string, PlannedBolusSummary>> {
    const plans = await this.deps.store.listForProposals(patientId, proposalIds);
    const summaries = new Map<string, PlannedBolusSummary>();
    for (const [proposalId, plan] of plans) summaries.set(proposalId, toPlannedBolusSummary(plan, await this.openCommand(plan)));
    return summaries;
  }

  /** Every planned part of a meal, as the meal's time line lists them (each with its own switch-off). */
  async summariesForMeal(patientId: string, mealRecordId: string): Promise<PlannedBolusSummary[]> {
    const plans = this.deps.store.listForMeal ? await this.deps.store.listForMeal(patientId, mealRecordId) : [];
    const list: PlannedBolusSummary[] = [];
    for (const plan of plans) list.push(toPlannedBolusSummary(plan, await this.openCommand(plan)));
    return list;
  }

  /** Every planned part of each card, as the chat card lists them (with its own switch-off). */
  async allSummariesForProposals(patientId: string, proposalIds: string[]): Promise<Map<string, PlannedBolusSummary[]>> {
    const all = this.deps.store.listAllForProposals ? await this.deps.store.listAllForProposals(patientId, proposalIds) : new Map<string, PlannedBolusRecord[]>();
    const summaries = new Map<string, PlannedBolusSummary[]>();
    for (const [proposalId, plans] of all) {
      const list: PlannedBolusSummary[] = [];
      for (const plan of plans) list.push(toPlannedBolusSummary(plan, await this.openCommand(plan)));
      summaries.set(proposalId, list);
    }
    return summaries;
  }

  /** The newest command of an open plan (settled plans need none). */
  /**
   * An overdue plan is not expired while its command may still settle it when it reaches the loop: a live command, but
   * a NO_REPLY one only while the reconciler still matches it (REMOTE_COMMAND_MATCH_LOOKBACK_MINUTES after it was
   * authorized). Later nothing can settle the plan, so it expires.
   */
  async commandMaySettle(plan: PlannedBolusRecord, now: Date): Promise<boolean> {
    const command = await this.openCommand(plan);
    if (!command || !LIVE_COMMAND_STATUSES.includes(command.status)) return false;
    return now.getTime() - Date.parse(command.authorized_at) < REMOTE_COMMAND_MATCH_LOOKBACK_MINUTES * 60_000;
  }

  /**
   * Trio said "Bolus started" for the part's command, but no loop entry matched it within the reconciler's look-back
   * (Nightscout late, or the entry grouped with another): the part is given by that command, so it does not stay
   * "sending" on both phones, unskippable, holding the WBT reminder back.
   */
  async settleConfirmedUnmatched(plan: PlannedBolusRecord, now: Date): Promise<boolean> {
    const command = await this.openCommand(plan);
    if (!command || command.status !== 'SUCCEEDED') return false;
    if (now.getTime() - Date.parse(command.authorized_at) < REMOTE_COMMAND_MATCH_LOOKBACK_MINUTES * 60_000) return false;
    const given = await this.deps.store.resolve(plan.patient_id, plan.id, 'GIVEN', { user_id: command.user_id, command_id: command.id, insulin_u: command.insulin_u });
    if (given) await this.afterGiven(given);
    return given !== null;
  }

  async openCommand(plan: PlannedBolusRecord): Promise<RemoteCommandRecord | null> {
    if (!OPEN_PLANNED_BOLUS_STATUSES.includes(plan.status)) return null;
    return this.deps.commands.latestForPlannedBolus(plan.patient_id, plan.id);
  }

  private async afterGiven(plan: PlannedBolusRecord): Promise<void> {
    this.deps.log?.({ event: 'planned_bolus_given', planned_bolus_id: plan.id, meal_record_id: plan.meal_record_id, command_id: plan.given_command_id, loop_action_id: plan.given_loop_action_id });
    const notBefore = new Date(Date.parse(plan.resolved_at ?? new Date().toISOString()) + SPLIT_BOLUS_POLICY.wbt_min_gap_minutes * 60_000).toISOString();
    try {
      await this.deps.postponeWbtReminder?.(plan.patient_id, plan.meal_record_id, notBefore);
    } catch (error) {
      this.deps.log?.({ event: 'planned_bolus_wbt_postpone_failed', planned_bolus_id: plan.id, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    }
  }
}
