import { LOOP_ACTION_POLICY, type LoopActionPurpose } from '@modules/loop-actions/application/loop-action-policy';
import { REMOTE_COMMAND_POLICY } from './remote-command-policy';
import { commandLoopNames, type RemoteCommandRecord } from './remote-command-record';
import type { RemoteCommandStatus } from './remote-command-status';

/**
 * A command's carb entry and bolus come back from Trio through Nightscout as an ordinary loop action
 * (remote-bolus-trio-plan.md W8). The worker links them: the action gets the purpose the caregiver already gave, and
 * a meal is created from the command's meal. Matching is strict: the same carbs, the same bolus (±0.05 U), shortly
 * after the command; anything else stays an action without a purpose (the chat can still give it one).
 */

export interface MatchableLoopAction {
  id: string;
  started_at: string;
  purpose: LoopActionPurpose | null;
  carbs_g: number | null;
  bolus_units: number | null;
  /** The action's carb entry (rescue carbs link it to their alert). */
  carb_event_id?: string | null;
  /**
   * Another command is matched to it already. A Bolus tab dose leaves its action without a purpose, so the purpose alone
   * would let the next command with the same amounts take it (and read "Bolus podany" before its own bolus was given).
   */
  linked_to_command?: boolean;
}

/** An action no caregiver and no command has claimed yet. */
function isFree(action: MatchableLoopAction): boolean {
  return action.purpose === null && action.linked_to_command !== true;
}

export interface RemoteCommandMatch {
  loop_action_id: string;
  purpose: LoopActionPurpose;
  /** The status Nightscout proves for a command still waiting for Trio's answer; null to leave it. */
  settled_status: RemoteCommandStatus | null;
  status_message: string | null;
}

const BOLUS_TOLERANCE_U = 0.051;
/** Trio may date the entry a little before the command reached it (clock differences). */
const EARLY_TOLERANCE_MS = 2 * 60_000;

export function matchRemoteCommand(command: RemoteCommandRecord, actions: MatchableLoopAction[], nowIso: string): RemoteCommandMatch | null {
  const authorizedMs = Date.parse(command.authorized_at);
  // A meal eaten later (Bolus tab "+15 min"): Trio dates the carbs then, the bolus now.
  const carbsAtMs = command.carbs_g > 0 && command.context?.carbs_at ? Date.parse(command.context.carbs_at) : NaN;
  const scheduled = Number.isFinite(carbsAtMs);
  const referenceMs = scheduled ? carbsAtMs : authorizedMs;
  const windowEndMs = Math.max(authorizedMs, referenceMs) + REMOTE_COMMAND_POLICY.match_window_minutes * 60_000;
  const nowMs = Date.parse(nowIso);
  const bolusExpected = command.insulin_u > 0 && command.status !== 'PARTIAL';
  // Its bolus is an action of its own (minutes before the carbs, outside the loop's grouping): seen there, it proves
  // the bolus as an action with both would.
  const scheduledBolusSeen = scheduled && bolusExpected && lateBolusCandidates(command, actions).length > 0;

  const candidates = actions
    .filter(isFree)
    .filter((action) => {
      const startedMs = Date.parse(action.started_at);
      return startedMs >= authorizedMs - EARLY_TOLERANCE_MS && startedMs <= windowEndMs;
    })
    .filter((action) => {
      const carbsMatch = command.carbs_g > 0 ? action.carbs_g === command.carbs_g : action.carbs_g === null;
      if (!carbsMatch) return false;
      if (action.bolus_units !== null) {
        return bolusExpected && Math.abs(action.bolus_units - command.insulin_u) <= BOLUS_TOLERANCE_U;
      }
      if (!bolusExpected) return command.carbs_g > 0;
      // Trio confirmed the bolus: the carbs alone are enough to save the meal now (the bolus joins it when it syncs).
      if (command.status === 'SUCCEEDED') return command.carbs_g > 0;
      if (scheduledBolusSeen) return true;
      // Carbs without the bolus yet: wait until the bolus would have joined the action.
      return command.carbs_g > 0 && nowMs - Date.parse(action.started_at) >= LOOP_ACTION_POLICY.settle_minutes * 60_000;
    })
    .sort((a, b) => Math.abs(Date.parse(a.started_at) - referenceMs) - Math.abs(Date.parse(b.started_at) - referenceMs));

  const action = candidates[0];
  if (!action) return null;

  const waiting = command.status === 'SENT' || command.status === 'TRIO_ACCEPTED' || command.status === 'NO_REPLY';
  let settled: RemoteCommandStatus | null = null;
  let message: string | null = null;
  // Only what Nightscout shows settles a command; a bolus not there (yet) proves nothing, so the carbs alone never
  // make it PARTIAL (a late "Bolus started" must still count, and nobody may be invited to give it again).
  if (waiting && (action.bolus_units !== null || command.insulin_u === 0 || scheduledBolusSeen)) {
    settled = 'SUCCEEDED';
    message = command.insulin_u > 0
      ? 'Bolus podany (widoczny w Nightscout)'
      : command.purpose === 'HYPO_TREATMENT' ? `Dosłodzenie zapisane w ${commandLoopNames(command).locative} (widoczne w Nightscout)` : `Posiłek zapisany w ${commandLoopNames(command).locative} (widoczny w Nightscout)`;
  }
  return {
    loop_action_id: action.id,
    // A planned second part joins its meal as an addition (its carbs and bolus are the meal's).
    // Rescue carbs are a hypo treatment: no meal.
    // A correction card's carbs are correction carbs, not a meal (no meal record, note or WBT check).
    purpose: command.purpose === 'WBT' ? 'WBT'
      : command.purpose === 'MEAL_PART' ? 'MEAL_ADDITION'
        : command.purpose === 'HYPO_TREATMENT' ? 'HYPO_TREATMENT'
          : command.card_purpose === 'CORRECTION' ? 'CORRECTION'
            : command.carbs_g > 0 ? 'NEW_MEAL' : 'CORRECTION',
    settled_status: settled,
    status_message: message,
  };
}

/**
 * The bolus of a matched command that synced after its carbs: an unassigned bolus-only action with the command's dose,
 * shortly after it. Null when the command's action has its bolus already or no such action exists.
 */
export function findLateBolusAction(command: RemoteCommandRecord, matchedAction: MatchableLoopAction | undefined, actions: MatchableLoopAction[]): MatchableLoopAction | null {
  if (!matchedAction || matchedAction.bolus_units !== null || command.insulin_u <= 0 || command.status === 'PARTIAL' || command.status === 'REJECTED') return null;
  return lateBolusCandidates(command, actions.filter((action) => action.id !== matchedAction.id))[0] ?? null;
}

/** Unassigned bolus-only actions with the command's dose, shortly after it was authorized, oldest first. */
function lateBolusCandidates(command: RemoteCommandRecord, actions: MatchableLoopAction[]): MatchableLoopAction[] {
  const authorizedMs = Date.parse(command.authorized_at);
  const windowEndMs = authorizedMs + REMOTE_COMMAND_POLICY.match_window_minutes * 60_000;
  return actions
    .filter((action) => isFree(action) && action.carbs_g === null && action.bolus_units !== null)
    .filter((action) => Math.abs((action.bolus_units ?? 0) - command.insulin_u) <= BOLUS_TOLERANCE_U)
    .filter((action) => {
      const startedMs = Date.parse(action.started_at);
      return startedMs >= authorizedMs - EARLY_TOLERANCE_MS && startedMs <= windowEndMs;
    })
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
}
