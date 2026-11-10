/**
 * The life of one remote command (remote-bolus-trio-plan.md W6, §4):
 *
 *   AUTHORIZED ─ phone sends ─▶ SENT ─ Trio "Initiating bolus…" ─▶ TRIO_ACCEPTED ─▶ SUCCEEDED | REJECTED | PARTIAL | UNCERTAIN
 *        │                      │                                     │
 *        ├─ the phone says it did not send ─▶ SEND_FAILED                └─ no answer in time ─▶ NO_REPLY
 *        └─ no report by the deadline ─▶ NO_REPLY (the push may have left: unknown, never "not sent")
 *
 * NO_REPLY is not a failure: the command may have been delivered. Nightscout decides later (the loop's carb entry and
 * bolus matched to the command), and a final answer that arrives late still counts. Trio's answer may also arrive
 * before the phone's "sent" report: AUTHORIZED moves straight to Trio's status. EXPIRED is kept for old rows only.
 *
 * UNCERTAIN: the pump's answer to the bolus was garbled ("Bolus may have failed", MinimedKit SetBolusError.uncertain).
 * Trio then records the dose as given (it is in Nightscout seconds before the answer: 5 of 5 such answers 2026-10-22 to
 * 11-10, and the pump history showed it given), so it is never offered again: Nightscout's bolus settles it as
 * SUCCEEDED, and without one it stays "not known whether given" (check the pump).
 */

export const REMOTE_COMMAND_STATUSES = [
  'AUTHORIZED',
  'EXPIRED',
  'SENT',
  'SEND_FAILED',
  'TRIO_ACCEPTED',
  'SUCCEEDED',
  'PARTIAL',
  'REJECTED',
  'NO_REPLY',
  'UNCERTAIN',
] as const;
export type RemoteCommandStatus = (typeof REMOTE_COMMAND_STATUSES)[number];

/**
 * A command whose bolus may have reached the pump (sent, accepted, given, unanswered, uncertain). Uncertain stays here
 * until Nightscout shows its bolus: it never turns REJECTED, so the caregiver's pump check decides before more insulin.
 * Read by the database (matching to the loop's entries, the recent-bolus warning) as well as by the dose sums.
 */
export const REACHED_TRIO_STATUSES: readonly RemoteCommandStatus[] = ['SENT', 'TRIO_ACCEPTED', 'SUCCEEDED', 'NO_REPLY', 'UNCERTAIN'];

/**
 * Insulin counted as given wherever a dose is summed (a part, the rest of a meal, what the calculator held back): what
 * reached Trio and what was confirmed but not sent yet (it is sent, or turns NO_REPLY after its deadline). Counting a
 * dose that later fails only leaves a smaller rest for a moment; not counting one may give it twice.
 */
export const INSULIN_COUNTED_STATUSES: readonly RemoteCommandStatus[] = ['AUTHORIZED', ...REACHED_TRIO_STATUSES];

/** Carbs counted as in the loop: as insulin, plus PARTIAL (carbs entered, the bolus refused: its insulin is 0). */
export const CARBS_COUNTED_STATUSES: readonly RemoteCommandStatus[] = [...INSULIN_COUNTED_STATUSES, 'PARTIAL'];

/** The database's commands still to match with the loop's entries: reached Trio, PARTIAL too (its carbs entry). */
export const MATCHABLE_STATUSES: readonly RemoteCommandStatus[] = [...REACHED_TRIO_STATUSES, 'PARTIAL'];

/** Statuses that still wait for Trio (another command of the patient must wait). */
export const IN_FLIGHT_STATUSES: ReadonlySet<RemoteCommandStatus> = new Set(['AUTHORIZED', 'SENT', 'TRIO_ACCEPTED']);

const TRANSITIONS: Record<RemoteCommandStatus, RemoteCommandStatus[]> = {
  AUTHORIZED: ['SENT', 'SEND_FAILED', 'TRIO_ACCEPTED', 'SUCCEEDED', 'PARTIAL', 'REJECTED', 'UNCERTAIN', 'NO_REPLY'],
  SENT: ['TRIO_ACCEPTED', 'SUCCEEDED', 'PARTIAL', 'REJECTED', 'UNCERTAIN', 'NO_REPLY'],
  TRIO_ACCEPTED: ['SUCCEEDED', 'PARTIAL', 'REJECTED', 'UNCERTAIN', 'NO_REPLY'],
  // Only a final answer: an intermediate one would put the command back in flight.
  NO_REPLY: ['SUCCEEDED', 'PARTIAL', 'REJECTED', 'UNCERTAIN'],
  // Only Nightscout's bolus (or a late "Bolus started") settles it.
  UNCERTAIN: ['SUCCEEDED'],
  EXPIRED: [],
  SEND_FAILED: [],
  SUCCEEDED: [],
  PARTIAL: [],
  REJECTED: [],
};

export function canTransitionRemoteCommand(from: RemoteCommandStatus, to: RemoteCommandStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * What Trio's answer means for the command. Trio answers "Initiating bolus..." before the pump starts, then "Bolus
 * started" or the reason it failed; a meal without a bolus is "Meal logged". In a meal with a bolus Trio stores the
 * carbs before it checks the bolus, so a bolus refusal there leaves the carbs in Trio (PARTIAL).
 */
export function classifyTrioReply(input: { success: boolean; message: string; carbs_g: number; insulin_u: number }): RemoteCommandStatus {
  const message = input.message.trim();
  if (input.success) {
    // With insulin only "Bolus started" is final; anything else ("Initiating bolus...", "Meal logged") is a step.
    if (input.insulin_u > 0) return /bolus started/i.test(message) ? 'SUCCEEDED' : 'TRIO_ACCEPTED';
    return 'SUCCEEDED';
  }
  if (input.insulin_u > 0 && isUncertainDelivery(message)) return 'UNCERTAIN';
  if (input.carbs_g > 0 && input.insulin_u > 0 && isBolusStageFailure(message)) return 'PARTIAL';
  return 'REJECTED';
}

/**
 * The pump may have started the bolus: MinimedKit's "Bolus may have failed: …" (SetBolusError.uncertain), in the
 * languages Trio ships. Trio records such a dose as given.
 */
export function isUncertainDelivery(message: string): boolean {
  return /bolus may have failed|bolus mógł się nie udać|bolus ist möglicherweise fehlgeschlagen|posible que el bolo haya fallado|le bolus a peut-être échoué|il bolo potrebbe essere fallito|bolus kan have fejlet|bolus kan ha mislyktes|bolus kan ha misslyckats|bolus mogelijk mislukt|bolusul să fi eșuat|болюс не прошел|bolus başarısız olmuş olabilir/i.test(message);
}

/** Failures Trio reports after it already stored the meal's carbs (bolus checks and the pump itself). */
function isBolusStageFailure(message: string): boolean {
  if (/carbs amount|fat amount|protein amount|newer carb entries|meal data is incomplete|too old|future timestamp|decryption|shared secret|disabled|unsupported/i.test(message)) {
    return false;
  }
  return /bolus|IOB|pump|APS Manager/i.test(message);
}

/** Polish text of Trio's answer for the caregiver; known reasons are translated, others are kept as Trio wrote them. */
export function describeTrioReply(status: RemoteCommandStatus, message: string, insulinU: number): string {
  if (status === 'TRIO_ACCEPTED') return 'Trio przyjęło polecenie, rozpoczyna bolus…';
  if (status === 'SUCCEEDED') return insulinU > 0 ? 'Bolus podany' : 'Posiłek zapisany w Trio';
  if (status === 'UNCERTAIN') return UNCERTAIN_BOLUS_MESSAGE;
  const reason = translateTrioReason(message);
  return status === 'PARTIAL' ? `Węglowodany zapisane w Trio, bolus odrzucony: ${reason}` : `Błąd: ${reason}`;
}

/** An UNCERTAIN command's text (the app says "checking" for its first minute). */
export const UNCERTAIN_BOLUS_MESSAGE = 'Nie wiadomo, czy bolus został podany: pompa odpowiedziała niewyraźnie. Sprawdź historię bolusów w pompie.';

export function translateTrioReason(message: string): string {
  const text = message.replace(/\s*Details:.*$/s, '').replace(/^Command rejected:\s*/i, '').trim();
  const rules: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
    [/bolus amount \(([\d.]+) units\) exceeds the maximum allowed \(([\d.]+) units\)/i, (m) => `bolus ${m[1]} j przekracza maksymalny bolus w Trio (${m[2]} j)`],
    [/would exceed max IOB \(([\d.]+) units\)\. Current IOB: ([\d.]+)/i, (m) => `przekroczyłby maksymalne IOB w Trio (${m[1]} j, teraz ${m[2]} j)`],
    [/current IOB is not available/i, () => 'Trio nie zna aktualnego IOB'],
    [/boluses totaling more than 20%/i, () => 'od wysłania polecenia podano już bolus'],
    [/carbs amount \(([\d.]+)g\) exceeds the maximum allowed \(([\d.]+)g\)/i, (m) => `${m[1]} g przekracza maksymalne węglowodany w Trio (${m[2]} g)`],
    [/newer carb entries have been logged/i, () => 'od wysłania polecenia w Trio wpisano nowe węglowodany'],
    [/message is too old/i, () => 'polecenie dotarło za późno (ponad 10 min)'],
    [/invalid future timestamp/i, () => 'zegar telefonu różni się od zegara Trio'],
    [/remote control is disabled/i, () => 'Remote Control jest wyłączone w Trio'],
    [/decryption failed|shared secret/i, () => 'Shared Secret nie zgadza się z Trio'],
  ];
  for (const [pattern, render] of rules) {
    const match = text.match(pattern);
    if (match) return render(match);
  }
  return text || 'Trio nie podało powodu';
}
