/**
 * Options under an answer (answer-options.v1): when the caregiver asks what to do, the answer lists
 * 2–3 options (A–C, the recommended one marked) and prepares the cards of each, tagged with its key. The app shows the
 * options as a picker with the recommended one chosen, the cards of the chosen option, and "Własny plan" (no cards, the
 * chat field highlighted). Under a picker every card has its option: the worker discards cards without one (and
 * drops options left without cards).
 */
export const ANSWER_OPTION_KEYS = ['A', 'B', 'C'] as const;
export type AnswerOptionKey = (typeof ANSWER_OPTION_KEYS)[number];

export interface AnswerOption {
  key: AnswerOptionKey;
  /** "Najpierw 3 g, bolus później" */
  title: string;
  /** "15 g do Trio bez insuliny, dawka gdy przestanie spadać" */
  detail: string | null;
  /** "⚠️ Trzeba dopilnować dawki po zatrzymaniu spadku": what the cards do not show, in small print (null: nothing). */
  note: string | null;
  recommended: boolean;
}

/** The prompt asks for titles up to 40 and notes up to 100 characters; these clip only what runs well over. */
export const MAX_ANSWER_OPTION_TITLE = 60;
export const MAX_ANSWER_OPTION_DETAIL = 140;
export const MAX_ANSWER_OPTION_NOTE = 140;

export function readOptionKey(value: unknown): AnswerOptionKey | null {
  return typeof value === 'string' && (ANSWER_OPTION_KEYS as readonly string[]).includes(value.trim().toUpperCase())
    ? (value.trim().toUpperCase() as AnswerOptionKey)
    : null;
}

/**
 * The answer's options as stored: 2–3 with distinct keys in the model's order (the prompt puts the recommended A
 * first), titles trimmed, exactly one recommended (the first marked; the first option when the model marked none). Anything else is no options (the cards then show as before).
 */
export function sanitizeAnswerOptions(raw: unknown): AnswerOption[] {
  if (!Array.isArray(raw)) return [];
  const options: AnswerOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const key = readOptionKey(record.key);
    const title = typeof record.title === 'string' ? clip(record.title, MAX_ANSWER_OPTION_TITLE) : '';
    if (!key || !title || options.some((option) => option.key === key)) continue;
    const detail = typeof record.detail === 'string' ? clip(record.detail, MAX_ANSWER_OPTION_DETAIL) : '';
    const note = typeof record.note === 'string' ? clip(record.note, MAX_ANSWER_OPTION_NOTE) : '';
    options.push({ key, title, detail: detail || null, note: note || null, recommended: record.recommended === true });
    if (options.length === ANSWER_OPTION_KEYS.length) break;
  }
  if (options.length < 2) return [];
  const recommended = options.findIndex((option) => option.recommended);
  return options.map((option, index) => ({ ...option, recommended: index === (recommended < 0 ? 0 : recommended) }));
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
