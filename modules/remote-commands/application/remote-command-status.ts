/**
 * The life of one remote command (remote-bolus-trio-plan.md W6, §4):
 *
 *   AUTHORIZED ─ phone sends ─▶ SENT ─ Trio "Initiating bolus…" ─▶ TRIO_ACCEPTED ─▶ SUCCEEDED | REJECTED | PARTIAL
 *        │                      │                                     │
 *        ├─ the phone says it did not send ─▶ SEND_FAILED                └─ no answer in time ─▶ NO_REPLY
 *        └─ no report by the deadline ─▶ NO_REPLY (the push may have left: unknown, never "not sent")
 *
 * NO_REPLY is not a failure: the command may have been delivered. Nightscout decides later (the loop's carb entry and
 * bolus matched to the command), and a final answer that arrives late still counts. Trio's answer may also arrive
 * before the phone's "sent" report: AUTHORIZED moves straight to Trio's status. EXPIRED is kept for old rows only.
 */

const REMOTE_COMMAND_STATUSES = [
  'AUTHORIZED',
  'EXPIRED',
  'SENT',
  'SEND_FAILED',
  'TRIO_ACCEPTED',
  'SUCCEEDED',
  'PARTIAL',
  'REJECTED',
  'NO_REPLY',
] as const;
export type RemoteCommandStatus = (typeof REMOTE_COMMAND_STATUSES)[number];

/** Statuses that still wait for Trio (another command of the patient must wait). */
export const IN_FLIGHT_STATUSES: ReadonlySet<RemoteCommandStatus> = new Set(['AUTHORIZED', 'SENT', 'TRIO_ACCEPTED']);

const TRANSITIONS: Record<RemoteCommandStatus, RemoteCommandStatus[]> = {
  AUTHORIZED: ['SENT', 'SEND_FAILED', 'TRIO_ACCEPTED', 'SUCCEEDED', 'PARTIAL', 'REJECTED', 'NO_REPLY'],
  SENT: ['TRIO_ACCEPTED', 'SUCCEEDED', 'PARTIAL', 'REJECTED', 'NO_REPLY'],
  TRIO_ACCEPTED: ['SUCCEEDED', 'PARTIAL', 'REJECTED', 'NO_REPLY'],
  // Only a final answer: an intermediate one would put the command back in flight.
  NO_REPLY: ['SUCCEEDED', 'PARTIAL', 'REJECTED'],
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
  if (input.carbs_g > 0 && input.insulin_u > 0 && isBolusStageFailure(message)) return 'PARTIAL';
  return 'REJECTED';
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
  const reason = translateTrioReason(message);
  return status === 'PARTIAL' ? `Węglowodany zapisane w Trio, bolus odrzucony: ${reason}` : `Błąd: ${reason}`;
}

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
