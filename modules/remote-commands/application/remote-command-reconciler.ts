import type { LoopActionPurpose } from '@modules/loop-actions/application/loop-action-policy';
import type { MealItem } from '@modules/meal-candidates/application/meal-items';
import { findLateBolusAction, matchRemoteCommand, type MatchableLoopAction } from './remote-command-matching';
import { commandLoopNames, type RemoteCommandRecord } from './remote-command-record';
import type { BolusReminderRequest } from './bolus-reminders';
import type { RemoteCommandStatus } from './remote-command-status';
import { plannedMealCarbs } from './split-bolus';
import { remoteCommandDriver } from '@modules/loop-system/domain/loop-system';
import { classifyLoopReply, describeLoopReply, readLoopRemoteAddress } from './loop-reply';

/**
 * The worker's side of remote commands (runs with loop actions, every 30 s): deadlines (EXPIRED, NO_REPLY) and the
 * link between a command and the loop action Trio's entries became. A matched meal command creates the meal at once
 * with the meal the caregiver confirmed. A command from the Bolus tab says nothing about what its carbs and insulin
 * were for: its action stays unassigned, like an entry made in Trio itself (meal, addition, WBT, correction...), unless
 * the caregiver set reminders with it (bolus-reminders.v1): then it becomes a meal (no description, named by its carbs,
 * insulin and time) that has them.
 */

export interface RemoteCommandReconcilerDeps {
  commands: {
    applyDeadlines(nowIso: string): Promise<RemoteCommandRecord[]>;
    listPatientsWithUnmatched(sinceIso: string): Promise<string[]>;
    listUnmatched(patientId: string, sinceIso: string): Promise<RemoteCommandRecord[]>;
    /** Matched commands with a bolus whose action may still be waiting for it (patients and their commands). */
    listMatchedWithInsulinSince(sinceIso: string): Promise<RemoteCommandRecord[]>;
    markMatched(patientId: string, commandId: string, match: { loop_action_id: string; meal_record_id: string | null; settled_status: RemoteCommandStatus | null; status_message: string | null }): Promise<void>;
    addMealNote(command: RemoteCommandRecord, mealRecordId: string, content: string): Promise<void>;
    get(patientId: string, commandId: string): Promise<RemoteCommandRecord | null>;
  };
  /** Nightscout notes Loop wrote for pushes it refused (no answer push then): the commands they name are settled. */
  loopRefusals?: {
    listSince(sinceIso: string): Promise<Array<{ patient_id: string; remote_address: string; notes: string | null }>>;
    transition(patientId: string, commandId: string, to: RemoteCommandStatus, fields: { trio_message?: string | null; status_message?: string | null; answered_at?: string }): Promise<RemoteCommandRecord | null>;
  };
  loopActions: {
    listActionsBetween(patientId: string, fromIso: string, toIso: string): Promise<Array<MatchableLoopAction & { meal_record_id: string | null }>>;
    assign(args: { patientId: string; actionId: string; purpose: LoopActionPurpose; mealRecordId: string | null; userId: string; expected: { purpose: null; mealRecordId: null } }): Promise<void>;
    getAction(patientId: string, actionId: string): Promise<{ meal_record_id: string | null } | null>;
    joinBolusToAction(patientId: string, sourceActionId: string, targetActionId: string): Promise<boolean>;
  };
  meals: {
    findMealIdentityById(patientId: string, mealRecordId: string): Promise<string | null>;
    editContent(patientId: string, mealIdentity: string, caregiverUserId: string, edit: { description?: string | null; items?: MealItem[] | null; macros?: { carbs_g: number | null; protein_g: number | null; fat_g: number | null } }): Promise<number>;
    /** Switches the meal's WBT reminder on or off from its protein and fat (AUTO; a caregiver's own choice stays). */
    afterMealSaved?(patientId: string, mealRecordId: string): Promise<void>;
  };
  /** Split meal boluses: the first part's meal gets its planned second part; a sent second part settles it. */
  plannedBoluses?: {
    createForMeal(command: RemoteCommandRecord, mealRecordId: string, mealStartedAt: string): Promise<void>;
    markGivenByCommand(command: RemoteCommandRecord, loopActionId: string): Promise<void>;
  };
  /**
   * Reminders set with a Bolus tab dose (bolus-reminders.v1): created on its new meal, timed from the loop's entry.
   * Without it a Bolus tab command with reminders still becomes a meal, without them.
   */
  bolusTabReminders?: {
    createForMeal(command: RemoteCommandRecord, reminders: BolusReminderRequest[], mealRecordId: string, entryAt: string): Promise<void>;
  };
  /** Rescue carbs to Trio: the Trio entry becomes the alert's treatment; refused commands give it back. */
  rescue?: {
    linkCommandEntry(patientId: string, commandId: string, carbEventId: string): Promise<void>;
    releaseFailedCommandTreatments(): Promise<number>;
  };
  log(event: Record<string, unknown>): void;
}

/** Commands authorized this long ago are still matched (a NO_REPLY command may show up in Nightscout late). */
export const REMOTE_COMMAND_MATCH_LOOKBACK_MINUTES = 60;

export class RemoteCommandReconciler {
  constructor(private readonly deps: RemoteCommandReconcilerDeps) {}

  async run(nowIso: string): Promise<void> {
    const noReply = await this.deps.commands.applyDeadlines(nowIso);
    for (const command of noReply) {
      this.deps.log({ event: 'remote_command_no_reply', remote_command_id: command.id, patient_id: command.patient_id });
    }
    const sinceIso = new Date(Date.parse(nowIso) - REMOTE_COMMAND_MATCH_LOOKBACK_MINUTES * 60_000).toISOString();
    for (const patientId of await this.deps.commands.listPatientsWithUnmatched(sinceIso)) {
      await this.matchPatient(patientId, sinceIso, nowIso);
    }
    if (this.deps.rescue) {
      try {
        const released = await this.deps.rescue.releaseFailedCommandTreatments();
        if (released > 0) this.deps.log({ event: 'rescue_command_treatments_released', count: released });
      } catch (error) {
        // Migration 064 not applied yet.
        this.deps.log({ event: 'rescue_command_release_failed', error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
      }
    }
    await this.attachLateBoluses(sinceIso, nowIso);
    await this.settleLoopRefusals(sinceIso, nowIso);
  }

  /**
   * A push Loop refused before handling it (one-time password, expiry) gets no answer, only a Nightscout note naming the
   * push: refused carbs leave nothing in Loop (REJECTED); a refused bolus came after Loop confirmed the carbs (PARTIAL).
   */
  private async settleLoopRefusals(sinceIso: string, nowIso: string): Promise<void> {
    if (!this.deps.loopRefusals) return;
    for (const note of await this.deps.loopRefusals.listSince(sinceIso)) {
      const named = readLoopRemoteAddress(note.remote_address);
      if (!named) continue;
      const command = await this.deps.commands.get(note.patient_id, named.command_id);
      if (!command || remoteCommandDriver(command.context?.loop_system ?? 'TRIO') !== 'LOOP') continue;
      const to = classifyLoopReply({ step: named.step, success: false, carbs_g: command.carbs_g, insulin_u: command.insulin_u });
      const reason = note.notes ?? '';
      // A final status is kept (the transition refuses): the note is read again every run until it ages out.
      const settled = await this.deps.loopRefusals.transition(note.patient_id, command.id, to, { trio_message: reason, status_message: describeLoopReply(to, reason, command.insulin_u), answered_at: nowIso });
      if (settled) this.deps.log({ event: 'remote_command_loop_refusal', remote_command_id: command.id, patient_id: note.patient_id, step: named.step, status: to });
    }
  }

  /** A meal saved from its carbs alone (Trio confirmed the bolus) gets its bolus when that syncs: one action, both. */
  private async attachLateBoluses(sinceIso: string, nowIso: string): Promise<void> {
    const commands = await this.deps.commands.listMatchedWithInsulinSince(sinceIso);
    const byPatient = new Map<string, RemoteCommandRecord[]>();
    for (const command of commands) byPatient.set(command.patient_id, [...(byPatient.get(command.patient_id) ?? []), command]);
    for (const [patientId, patientCommands] of byPatient) {
      const fromIso = new Date(Math.min(...patientCommands.map((command) => Date.parse(command.authorized_at))) - 5 * 60_000).toISOString();
      const actions = await this.deps.loopActions.listActionsBetween(patientId, fromIso, new Date(Math.max(Date.parse(nowIso), ...patientCommands.map(carbsAtMs)) + 60_000).toISOString());
      for (const command of patientCommands) {
        const late = findLateBolusAction(command, actions.find((action) => action.id === command.loop_action_id), actions);
        if (!late || !command.loop_action_id) continue;
        if (await this.deps.loopActions.joinBolusToAction(patientId, late.id, command.loop_action_id)) {
          this.deps.log({ event: 'remote_command_late_bolus_joined', remote_command_id: command.id, loop_action_id: command.loop_action_id });
        }
      }
    }
  }

  private async matchPatient(patientId: string, sinceIso: string, nowIso: string): Promise<void> {
    const commands = await this.deps.commands.listUnmatched(patientId, sinceIso);
    if (commands.length === 0) return;
    const fromIso = new Date(Date.parse(commands[0].authorized_at) - 5 * 60_000).toISOString();
    // Carbs of a meal eaten later are dated ahead of now (Bolus tab "+15 min").
    const untilIso = new Date(Math.max(Date.parse(nowIso), ...commands.map(carbsAtMs)) + 60_000).toISOString();
    let actions = await this.deps.loopActions.listActionsBetween(patientId, fromIso, untilIso);
    for (const command of commands) {
      const match = matchRemoteCommand(command, actions, nowIso);
      if (!match) continue;
      const matchedAction = actions.find((action) => action.id === match.loop_action_id);
      actions = actions.filter((action) => action.id !== match.loop_action_id);
      let mealRecordId: string | null = null;
      let linkedActionId = match.loop_action_id;
      try {
        // A bolus-only retry after "carbs stored, bolus refused" joins the meal's own action: one entry, carbs and bolus.
        const followed = match.purpose !== 'NEW_MEAL' ? await this.chainRoot(patientId, command) : null;
        if (followed?.loop_action_id && (await this.deps.loopActions.joinBolusToAction(patientId, match.loop_action_id, followed.loop_action_id))) {
          linkedActionId = followed.loop_action_id;
          mealRecordId = followed.meal_record_id;
          await this.deps.commands.markMatched(patientId, command.id, { ...match, loop_action_id: linkedActionId, meal_record_id: mealRecordId });
          await this.settlePlannedPart(command, linkedActionId, match.settled_status);
          this.deps.log({ event: 'remote_command_matched', remote_command_id: command.id, loop_action_id: linkedActionId, meal_record_id: mealRecordId, settled_status: match.settled_status, joined_meal_action: true });
          continue;
        }
        const tabRoot = await this.bolusTabRoot(patientId, command);
        // A retry sent without its own reminders keeps the ones the refused command was set with.
        const tabReminders = tabRoot ? (command.reminders ?? tabRoot.reminders ?? null) : null;
        // "Zapisz jako posiłek" (or a reminder, which needs a meal): the tab's dose becomes a meal; a retry keeps the root's tick.
        const tabMeal = !!tabRoot && (command.create_meal === true || tabRoot.create_meal === true || (tabReminders?.length ?? 0) > 0);
        if (tabRoot && !(tabMeal && match.purpose === 'NEW_MEAL')) {
          // Nobody is asked what it was for; the link still settles the command and joins a late bolus.
          await this.deps.commands.markMatched(patientId, command.id, { ...match, meal_record_id: null });
          this.deps.log({ event: 'remote_command_matched', remote_command_id: command.id, loop_action_id: match.loop_action_id, meal_record_id: null, settled_status: match.settled_status, left_unassigned: true });
          continue;
        }
        // A bolus-only retry after "carbs stored, bolus refused" belongs to the meal those carbs started; WBT from the
        // WBT window belongs to the meal the window was opened for.
        // A planned second part belongs to its meal too.
        const followedMeal = match.purpose === 'WBT' || command.purpose === 'MEAL_PART' ? command.target_meal_record_id : followed?.meal_record_id ?? null;
        await this.deps.loopActions.assign({ patientId, actionId: match.loop_action_id, purpose: match.purpose, mealRecordId: followedMeal, userId: command.user_id, expected: { purpose: null, mealRecordId: null } });
        if (followedMeal) mealRecordId = followedMeal;
        if (match.purpose === 'HYPO_TREATMENT' && matchedAction?.carb_event_id) {
          await this.deps.rescue?.linkCommandEntry(patientId, command.id, matchedAction.carb_event_id);
        }
        if (match.purpose === 'WBT' && followedMeal) await this.deps.commands.addMealNote(command, followedMeal, wbtNote(command));
        if (command.purpose === 'MEAL_PART' && followedMeal) await this.deps.commands.addMealNote(command, followedMeal, mealPartNote(command));
        if (match.purpose === 'NEW_MEAL') {
          mealRecordId = (await this.deps.loopActions.getAction(patientId, match.loop_action_id))?.meal_record_id ?? null;
          // The first part of a split card: the meal's later parts are planned from the loop's carb entry time, first,
          // so a failed description or note never loses the insulin still to come (the command is not looked at again).
          if (mealRecordId && command.split_plan) {
            await this.deps.plannedBoluses?.createForMeal(command, mealRecordId, matchedAction?.started_at ?? command.sent_at ?? command.authorized_at);
          }
          if (mealRecordId) {
            const mealId = mealRecordId;
            try {
              if (command.meal_payload) await this.fillMeal(patientId, mealId, command);
              await this.deps.commands.addMealNote(command, mealId, mealNote(command));
              // The WBT reminder follows the meal's protein and fat, as for a meal saved in the app.
              await this.deps.meals.afterMealSaved?.(patientId, mealId);
            } catch (error) {
              this.deps.log({ event: 'remote_command_meal_fill_failed', remote_command_id: command.id, meal_record_id: mealId, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
            }
            if (tabReminders && tabReminders.length > 0) {
              // After the meal's own WBT decision, so the caregiver's WBT reminder (MANUAL) is the one that stays. A
              // failure never blocks the link: the meal is there, the caregiver can still set them on its page.
              try {
                await this.deps.bolusTabReminders?.createForMeal(command, tabReminders, mealId, matchedAction?.started_at ?? command.sent_at ?? command.authorized_at);
                this.deps.log({ event: 'bolus_tab_reminders_created', remote_command_id: command.id, meal_record_id: mealId, kinds: tabReminders.map((reminder) => reminder.kind) });
              } catch (error) {
                this.deps.log({ event: 'bolus_tab_reminders_failed', remote_command_id: command.id, meal_record_id: mealId, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
              }
            }
          }
        }
      } catch (error) {
        // The caregiver answered the action in the meantime, or meal history is off: the command is linked anyway.
        this.deps.log({ event: 'remote_command_assign_failed', remote_command_id: command.id, loop_action_id: match.loop_action_id, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
      }
      await this.deps.commands.markMatched(patientId, command.id, { ...match, meal_record_id: mealRecordId });
      await this.settlePlannedPart(command, match.loop_action_id, match.settled_status);
      this.deps.log({ event: 'remote_command_matched', remote_command_id: command.id, loop_action_id: match.loop_action_id, meal_record_id: mealRecordId, settled_status: match.settled_status });
    }
  }

  /**
   * A planned second part whose command reached the loop is given (both phones drop its button). Not when Trio kept its
   * carbs and refused its bolus (PARTIAL): no insulin was given, the part stays open for the bolus-only retry.
   */
  private async settlePlannedPart(command: RemoteCommandRecord, loopActionId: string, settledStatus: RemoteCommandStatus | null): Promise<void> {
    if (!command.planned_bolus_id || !this.deps.plannedBoluses) return;
    if ((settledStatus ?? command.status) === 'PARTIAL') {
      this.deps.log({ event: 'planned_bolus_left_open', remote_command_id: command.id, planned_bolus_id: command.planned_bolus_id, reason: 'bolus_refused' });
      return;
    }
    try {
      await this.deps.plannedBoluses.markGivenByCommand(command, loopActionId);
    } catch (error) {
      this.deps.log({ event: 'planned_bolus_settle_failed', remote_command_id: command.id, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    }
  }

  /**
   * The command the chain of retries started with when it started in the Bolus tab, else null (a retry from a meal's
   * page is sent as BOLUS_SCREEN too, but its chain started with the meal's own command).
   */
  private async bolusTabRoot(patientId: string, command: RemoteCommandRecord): Promise<RemoteCommandRecord | null> {
    let current = command;
    for (let depth = 0; depth < 5 && current.follows_command_id; depth += 1) {
      const previous = await this.deps.commands.get(patientId, current.follows_command_id);
      if (!previous) break;
      current = previous;
    }
    return current.source === 'BOLUS_SCREEN' && current.purpose === null ? current : null;
  }

  /** The command a chain of retries started from (the one linked to the meal's action), at most a few retries back. */
  private async chainRoot(patientId: string, command: RemoteCommandRecord): Promise<RemoteCommandRecord | null> {
    let current = command;
    for (let depth = 0; depth < 5 && current.follows_command_id; depth += 1) {
      const previous = await this.deps.commands.get(patientId, current.follows_command_id);
      if (!previous) return null;
      if (previous.loop_action_id) return previous;
      current = previous;
    }
    return null;
  }

  private async fillMeal(patientId: string, mealRecordId: string, command: RemoteCommandRecord): Promise<void> {
    const payload = command.meal_payload;
    const identity = await this.deps.meals.findMealIdentityById(patientId, mealRecordId);
    if (!payload || !identity) return;
    await this.deps.meals.editContent(patientId, identity, command.user_id, {
      description: payload.description,
      ...(payload.items ? { items: payload.items } : {}),
      // The carbs are what the loop got and, for a split card, what its later parts will send (the whole meal, as its
      // items; a change of the meal then reaches the parts still to come); protein and fat are the meal's (they stay in
      // GlucoMind, WBT reminders use them).
      ...(payload.macros ? { macros: { carbs_g: plannedMealCarbs(command.carbs_g, command.split_plan), protein_g: payload.macros.protein_g, fat_g: payload.macros.fat_g } } : {}),
    });
  }
}

/** "WBT wysłane do Trio z okna WBT: 15 g węglowodanów, 1,2 j insuliny." (the command's loop by name) */
function wbtNote(command: RemoteCommandRecord): string {
  const loop = commandLoopNames(command);
  if (command.status === 'PARTIAL') return `WBT z okna WBT: ${command.carbs_g} g węglowodanów zapisane w ${loop.locative}, ${refusedBolus(command)}.`;
  const amounts = [...(command.carbs_g > 0 ? [`${command.carbs_g} g węglowodanów`] : []), ...(command.insulin_u > 0 ? [`${units(command.insulin_u)} j insuliny`] : [])].join(', ');
  return `WBT wysłane do ${loop.genitive} z okna WBT: ${amounts}.`;
}

/**
 * "Druga część bolusa wysłana do Trio: 15 g węglowodanów, 1,2 j insuliny." After PARTIAL: "Druga część bolusa: 15 g
 * węglowodanów zapisane w Trio, bolus 1,2 j odrzucony."
 */
function mealPartNote(command: RemoteCommandRecord): string {
  const loop = commandLoopNames(command);
  if (command.status === 'PARTIAL') return `Druga część bolusa: ${command.carbs_g} g węglowodanów zapisane w ${loop.locative}, ${refusedBolus(command)}.`;
  const amounts = [...(command.carbs_g > 0 ? [`${command.carbs_g} g węglowodanów`] : []), ...(command.insulin_u > 0 ? [`${units(command.insulin_u)} j insuliny`] : [])].join(', ');
  return `Druga część bolusa wysłana do ${loop.genitive}: ${amounts}.`;
}

/** "Posiłek zapisany z karty bolusa w rozmowie: 46 g węglowodanów, 3,8 j insuliny." (after PARTIAL: the bolus refused) */
function mealNote(command: RemoteCommandRecord): string {
  const loop = commandLoopNames(command);
  const from = command.source === 'BOLUS_SCREEN' ? 'z zakładki Bolus' : command.source === 'NEW_MEAL' ? 'z nowego posiłku' : 'z karty bolusa w rozmowie';
  if (command.status === 'PARTIAL') return `Posiłek zapisany ${from}: ${command.carbs_g} g węglowodanów zapisane w ${loop.locative}, ${refusedBolus(command)}.`;
  const amounts = [`${command.carbs_g} g węglowodanów`, ...(command.insulin_u > 0 ? [`${units(command.insulin_u)} j insuliny`] : [])].join(', ');
  return `Posiłek zapisany ${from}: ${amounts} wysłane do ${loop.genitive}.`;
}

function refusedBolus(command: RemoteCommandRecord): string {
  return `bolus ${units(command.insulin_u)} j odrzucony przez ${commandLoopNames(command).genitive} (insuliny nie podano)`;
}

function units(value: number): string {
  return String(value).replace('.', ',');
}

/** When Trio dated the command's carbs (later than now for a meal eaten later); 0 without such a date. */
function carbsAtMs(command: RemoteCommandRecord): number {
  const at = command.context?.carbs_at ? Date.parse(command.context.carbs_at) : NaN;
  return Number.isFinite(at) ? at : 0;
}
