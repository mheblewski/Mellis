/**
 * Dose answers in one model turn (dose-one-turn.v1, AI_DOSE_ONE_TURN, Claude only): the answer is written first and
 * streamed, the cards follow in the same turn, so the caregiver reads the text seconds earlier and the extra turn
 * after the cards goes away. The server gives the low advice up front (current_state_snapshot.dose_situation_now), so
 * the model decides without reading a card result, and checks the results afterwards: an answer they contradict is
 * asked for again in a normal second turn.
 */

export const DOSE_ONE_TURN_POLICY_VERSION = 'dose-one-turn.v1';

/** Cards and reminders only: any other tool's result is something the answer would have needed to read first. */
const SAME_TURN_TOOLS = new Set(['propose_bolus', 'propose_rescue_carbs', 'set_reminder']);
const ACCEPTED_STATUSES = new Set(['PROPOSED', 'SET']);
/** Results that carry a note the text has to say: the normal turn writes it. */
const NOTES_TO_READ = ['dose_above_formula', 'earlier_plan', 'already_sent', 'phone_limit'];

export const DOSE_ONE_TURN_INSTRUCTIONS = [
  'An answer with a dose or rescue card has an empty follow_up_candidates (this wins over the rule above): the card is the next step.',
  'current_state_snapshot.foods_looked_up: these products were already searched: use their values, and call search_food only for a main component it lacks.',
  'To the caregiver the server is "aplikacja": never write "serwer" or a field name.',
  'Answer directly without deliberating: the server computes doses, splits and risks, so do not recompute them.',
  'The standard plan is the card with insulin_u null, which the server lowers or defers for a low. When current_state_snapshot.dose_situation_now.fast_carbs_first is set, the standard option passes standard_plan true: the dose for all carbs by ICR, with its risk badge.',
].join('\n');

interface SameTurnAnswer {
  assistant_message?: unknown;
  answer_options?: Array<{ key?: unknown }>;
  [key: string]: unknown;
}

export type SameTurnVerdict =
  | { accepted: true; answer: SameTurnAnswer; warning_added: boolean }
  | { accepted: false; reason: string };

/**
 * Whether the answer written next to its cards stands. A warning of a card without options that the text does not
 * mention is added by the server (one sentence, the most severe) instead of rewriting a text the caregiver is reading.
 */
export function settleSameTurnAnswer(answer: unknown, results: ReadonlyArray<{ tool_name: string; result: unknown }>): SameTurnVerdict {
  const parsed = answer as SameTurnAnswer;
  const text = typeof parsed?.assistant_message === 'string' ? parsed.assistant_message : '';
  if (!text.trim()) return { accepted: false, reason: 'NO_TEXT' };
  const optionKeys = new Set((Array.isArray(parsed.answer_options) ? parsed.answer_options : []).map((option) => option.key));
  const warnings: string[] = [];
  let deferred = false;
  let insulinNow = false;
  for (const entry of results) {
    if (!SAME_TURN_TOOLS.has(entry.tool_name)) return { accepted: false, reason: `TOOL:${entry.tool_name}` };
    const result = (entry.result ?? {}) as Record<string, unknown>;
    if (!ACCEPTED_STATUSES.has(String(result.status))) return { accepted: false, reason: `${entry.tool_name}:${String(result.status)}` };
    const note = NOTES_TO_READ.find((key) => result[key]);
    if (note) return { accepted: false, reason: note };
    if (entry.tool_name !== 'propose_bolus') continue;
    const card = (result.card ?? {}) as { option?: unknown; insulin_u?: unknown; warnings?: unknown };
    if (optionKeys.size > 0 && (result.split_advice as { advised?: unknown } | undefined)?.advised === false) return { accepted: false, reason: 'SPLIT_NOT_ADVISED' };
    if (optionKeys.size > 0 && !optionKeys.has(card.option)) return { accepted: false, reason: 'CARD_OPTION_UNKNOWN' };
    if (optionKeys.size === 0 && card.option) return { accepted: false, reason: 'CARD_OPTION_WITHOUT_OPTIONS' };
    if (result.deferred_for_low) deferred = true;
    if (typeof card.insulin_u === 'number' && card.insulin_u > 0) insulinNow = true;
    if (Array.isArray(card.warnings)) warnings.push(...card.warnings.filter((warning): warning is string => typeof warning === 'string'));
  }
  // Every option deferring the dose: the standard plan the caregiver must be offered is missing.
  if (optionKeys.size > 0 && deferred && !insulinNow) return { accepted: false, reason: 'STANDARD_OPTION_MISSING' };
  if (optionKeys.size > 0 || warnings.length === 0 || text.includes('⚠️')) return { accepted: true, answer: parsed, warning_added: false };
  const worst = warnings.find((warning) => warning.startsWith('[!!] ')) ?? warnings[0];
  return {
    accepted: true,
    answer: { ...parsed, assistant_message: `${text.trimEnd()}\n\n⚠️ ${worst.replace(/^\[!!\] /, '')}` },
    warning_added: true,
  };
}
