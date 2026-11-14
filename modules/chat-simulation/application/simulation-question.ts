/**
 * Whether an owner's message may need the simulation tools (chat-simulation.v1). Their rules ("never a dose in units for
 * a meal", no "najbardziej prawdopodobne", no "SMB") were attached to every owner answer, dose cards and hypo causes
 * included (audit 2026-11-12): now only a question about settings, a dosing rule, a what-if or a comparison of periods,
 * or a short follow-up right after one, gets them.
 */
const SIMULATION_TOPIC = /\b(?:zasymul\w*|symul\w*|przelicz\w*|co by (?:bylo|sie stalo|dalo|zmienilo)|gdyby\w*|jakby\w*|co jesli|czy pomogl\w*|co zmienic|zmien\w*|zmian\w*|zwieksz\w*|zmniejsz\w*|podnies\w*|podniesc|obniz\w*|obnizyc|ustawien\w*|bazal\w*|baz[aeyi]|baze|bazie|icr|isf|przelicznik\w*|wspolczynnik\w*|cel\w* glikemi\w*|target\w*|regul\w*|smb|mikrobolus\w*|max ?iob|limit\w*|porown\w*|lepsz\w* (?:okres|tydzien|tygodni\w*)|gorsz\w* (?:okres|tydzien|tygodni\w*))\b/;

function normalize(text: string): string {
  return text.toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

/** The message, or a short follow-up ("a 5,0?", "a wieczorem?") after a user message or an answer about a simulation. */
export function mayNeedSimulation(text: string, earlier: Array<{ role?: unknown; content?: unknown; metadata?: unknown }> = []): boolean {
  const message = normalize(text);
  if (SIMULATION_TOPIC.test(message)) return true;
  if (message.length > 60) return false;
  const lastUser = [...earlier].reverse().find((entry) => String(entry.role ?? '').toUpperCase() === 'USER' && normalize(String(entry.content ?? '')) !== message);
  const lastAnswer = [...earlier].reverse().find((entry) => String(entry.role ?? '').toUpperCase() === 'ASSISTANT');
  const answerCard = (lastAnswer?.metadata as { metric_card?: { kind?: unknown } } | null | undefined)?.metric_card?.kind;
  return answerCard === 'SETTING_REPLAY' || (typeof lastUser?.content === 'string' && SIMULATION_TOPIC.test(normalize(lastUser.content)));
}

/**
 * In a pattern or change conversation (Wzorce) a replay only for a value the caregiver names next to its setting ("ICR
 * 7,5", "baza 0,1", "0,15 j/h"): the first question "Co jeszcze zmieniło się…" and later "po 6.11", "o 18" opened the
 * tools and the model laid out tables of carb ratios nobody asked about (role reviews 2026-11-12, B4). Dates and times
 * are removed before looking for a number; the chat never proposes values itself.
 */
const SETTING_WITH_VALUE = /(?:\b(?:icr|isf|przelicznik\w*|wspolczynnik\w*|baz[aeyi]|baze|bazie|bazal\w*|cel\w*|target\w*|dia|czas dzialania)\b\D{0,14}\d+(?:[.,]\d+)?)|(?:\d+(?:[.,]\d+)?\s*(?:j\/h|u\/h|g\/j|g\/u|mg\/dl(?:\/j)?))/;

export function namesSettingValue(text: string, previousUserText: string | null = null): boolean {
  if (SETTING_WITH_VALUE.test(withoutDatesAndTimes(text))) return true;
  // "a 7,0?" right after "a gdyby ICR 7,5?": the same setting, another value.
  const short = withoutDatesAndTimes(text);
  return previousUserText !== null && short.length <= 25 && /\d+[.,]\d+|\b\d+\b/.test(short) && SETTING_WITH_VALUE.test(withoutDatesAndTimes(previousUserText));
}

function withoutDatesAndTimes(text: string): string {
  return normalize(text)
    // dates (6.11, 6.11.2026, 31/10) and times (18:00, o 18, od 18 do 21, 18-21)
    .replace(/\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?(?![.,]?\d)/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\b(?:o|od|do|po|przed|okolo|ok\.?|miedzy|godz\.?|godzin\w*)\s+\d{1,2}\b(?![.,]\d)/g, ' ')
    .replace(/\b\d{1,2}\s*[-–]\s*\d{1,2}\b/g, ' ');
}
