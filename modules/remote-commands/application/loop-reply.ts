import { loopSystemNames } from '@modules/loop-system/domain/loop-system';
import type { RemoteCommandStatus } from './remote-command-status';

/**
 * Loop's answers to a command (loop-support-plan.md, stage 3). Loop answers each push on its own
 * (NightscoutService RemoteNotificationResponseManager): `command_type` carbs or bolus, `command_status` success or
 * failed, and a text ("Bolus of 2.00 units delivered successfully", "Command failed: …"). A meal with a bolus is two
 * pushes, carbs first; the phone sends the bolus only after Loop confirmed the carbs.
 *
 * A push Loop refuses before handling it (a wrong, expired or reused one-time password, an expired command) gets no
 * answer: Loop writes a Nightscout note instead, with the push's `remote-address` ("Mellis:<command id>:<step>") in it;
 * the import keeps that address (therapy-context-events) and the reconciler settles the command from it.
 */

export type LoopReplyStep = 'carbs' | 'bolus';

/** The `remote-address` GlucoMind puts in a Loop push; Loop copies it into the note of a refused push. */
export function loopRemoteAddress(commandId: string, step: LoopReplyStep): string {
  return `Mellis:${commandId}:${step}`;
}

/** The command and push a refused push's note is about; null for another sender's note. */
export function readLoopRemoteAddress(address: string): { command_id: string; step: LoopReplyStep } | null {
  const match = /^Mellis:([0-9a-f-]{36}):(carbs|bolus)$/i.exec(address.trim());
  return match ? { command_id: match[1].toLowerCase(), step: match[2].toLowerCase() as LoopReplyStep } : null;
}

export function classifyLoopReply(input: { step: LoopReplyStep; success: boolean; carbs_g: number; insulin_u: number }): RemoteCommandStatus {
  if (input.step === 'carbs') {
    if (!input.success) return 'REJECTED';
    // The carbs are in Loop; the bolus push follows.
    return input.insulin_u > 0 ? 'TRIO_ACCEPTED' : 'SUCCEEDED';
  }
  if (input.success) return 'SUCCEEDED';
  // A refused bolus after confirmed carbs leaves the carbs in Loop, as Trio's PARTIAL.
  return input.carbs_g > 0 ? 'PARTIAL' : 'REJECTED';
}

const LOOP = loopSystemNames('LOOP');

/** Polish text of Loop's answer for the caregiver. */
export function describeLoopReply(status: RemoteCommandStatus, message: string, insulinU: number): string {
  if (status === 'TRIO_ACCEPTED') return `Węglowodany zapisane w ${LOOP.locative}, wysyłam bolus…`;
  if (status === 'SUCCEEDED') return insulinU > 0 ? 'Bolus podany' : `Posiłek zapisany w ${LOOP.locative}`;
  const reason = translateLoopReason(message);
  return status === 'PARTIAL' ? `Węglowodany zapisane w ${LOOP.locative}, bolus odrzucony: ${reason}` : `Błąd: ${reason}`;
}

/** Loop's reasons in Polish (its own errors, and the ones its note gives for a refused push); others as Loop wrote them. */
export function translateLoopReason(message: string): string {
  const text = message.replace(/^Command failed:\s*/i, '').trim();
  // Loop's own wording (OTPManager, RemoteCommandValidator, ServicesManager, LoopDataManager); a Loop in Polish
  // answers in Polish already, and that text is kept.
  const rules: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
    [/password .*was already used/i, () => 'kod jednorazowy był już użyty'],
    [/password (sent at .* )?has expired/i, () => 'kod jednorazowy wygasł (zegary telefonów się różnią albo polecenie szło za długo)'],
    [/password is incorrect|invalid format/i, () => 'zły kod jednorazowy: zeskanuj ponownie kod QR z Loopa'],
    [/password is required|missing otp/i, () => 'brak kodu jednorazowego'],
    [/password validation is not available/i, () => 'zdalne polecenia nie są skonfigurowane w Loopie'],
    [/^(error: )?expired\.?$/i, () => 'polecenie dotarło za późno'],
    [/exceeds maximum allowed bolus/i, () => 'bolus przekracza maksymalny bolus w Loopie'],
    [/missing maximum allowed bolus/i, () => 'w Loopie nie ustawiono maksymalnego bolusa'],
    [/invalid bolus amount/i, () => 'zła dawka bolusa'],
    [/exceeds maximum allowed carbs/i, () => 'węglowodany przekraczają maksimum Loopa'],
    [/invalid carb amount/i, () => 'zła ilość węglowodanów'],
    [/invalid absorption time/i, () => 'zły czas wchłaniania'],
    [/start time is out of range/i, () => 'zła godzina posiłku (za daleko w przód lub w tył)'],
  ];
  for (const [pattern, render] of rules) {
    const match = text.match(pattern);
    if (match) return render(match);
  }
  return text || 'Loop nie podał powodu';
}
