import { REMOTE_COMMAND_POLICY } from './remote-command-policy';
import { type RemoteCommandRecord , commandLoopNames } from './remote-command-record';
import { translateTrioReason } from './remote-command-status';
import { agree, capitalized, remoteCommandDriver } from '@modules/loop-system/domain/loop-system';
import { translateLoopReason } from './loop-reply';

/**
 * What the meal page says about the remote command that created the meal (remote-bolus-trio-plan.md W8): when Trio
 * stored the carbs but refused the bolus, the meal says so and offers the bolus alone, so nobody assumes it was given.
 * Null when the bolus went through the first time (nothing to point out) or the meal did not come from GlucoMind.
 */
export interface MealRemoteBolusView {
  /** BOLUS_NOT_GIVEN (refused, may be given now), RETRY_IN_PROGRESS (a retry waits for Trio), BOLUS_GIVEN_ON_RETRY. */
  state: 'BOLUS_NOT_GIVEN' | 'RETRY_IN_PROGRESS' | 'BOLUS_GIVEN_ON_RETRY';
  message: string;
  /** The dose that was asked for (the retry starts from it; the caregiver may lower it). */
  insulin_u: number;
  /** Present while the bolus may be given from the meal (within the retry window). */
  retry: { follows_command_id: string; proposal_id: string | null; conversation_id: string | null; until: string } | null;
}

export function mealRemoteBolusView(commands: RemoteCommandRecord[], now: Date): MealRemoteBolusView | null {
  if (commands.length === 0) return null;
  const ordered = [...commands].sort((a, b) => Date.parse(a.authorized_at) - Date.parse(b.authorized_at));
  const latest = ordered[ordered.length - 1];
  const asked = ordered.find((command) => command.insulin_u > 0)?.insulin_u ?? latest.insulin_u;
  if (latest.status === 'PARTIAL' || latest.status === 'REJECTED') {
    const until = new Date(Date.parse(latest.authorized_at) + REMOTE_COMMAND_POLICY.retry_window_minutes * 60_000);
    const loop = commandLoopNames(latest);
    const toLoop = remoteCommandDriver(latest.context?.loop_system ?? 'TRIO') === 'LOOP';
    const reason = latest.trio_message
      ? (toLoop ? translateLoopReason(latest.trio_message) : translateTrioReason(latest.trio_message))
      : `${capitalized(loop.nominative)} ${agree(loop, { m: 'odrzucił', f: 'odrzuciła', n: 'odrzuciło' })} bolus`;
    return {
      state: 'BOLUS_NOT_GIVEN',
      message: `Bolus nie został podany: ${reason}. Węglowodany są w ${loop.locative}, insuliny nie podano.`,
      insulin_u: latest.insulin_u > 0 ? latest.insulin_u : asked,
      retry: until.getTime() > now.getTime()
        ? { follows_command_id: latest.id, proposal_id: latest.proposal_id, conversation_id: latest.conversation_id, until: until.toISOString() }
        : null,
    };
  }
  if (!latest.follows_command_id) return null;
  if (latest.status === 'SUCCEEDED') {
    return { state: 'BOLUS_GIVEN_ON_RETRY', message: `Bolus podany przy ponowieniu: ${String(latest.insulin_u).replace('.', ',')} j.`, insulin_u: latest.insulin_u, retry: null };
  }
  return { state: 'RETRY_IN_PROGRESS', message: latest.status_message ?? `Ponowiony bolus czeka na odpowiedź ${commandLoopNames(latest).genitive}.`, insulin_u: latest.insulin_u, retry: null };
}
