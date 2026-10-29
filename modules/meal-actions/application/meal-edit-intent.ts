/**
 * Which caregiver messages ask to change the meals module (conversation-meal-actions.v1). Such a message is answered
 * directly with the meal tools on the main model, instead of as an analysis of the patient's data. Pure.
 */

import { readBooleanFlag } from '@infra/config/environment';

/** AI_ENABLE_MEAL_ACTIONS: the main chat may read and prepare meal changes (true/1, shared boolean rules). Off by default. */
export function isMealActionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBooleanFlag(env, 'AI_ENABLE_MEAL_ACTIONS');
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const MEAL_WORD = '(?:posil\\w*|obiad\\w*|sniadan\\w*|kolacj\\w*|przekask\\w*|podwieczork\\w*|drugie sniadanie|deser\\w*|kanapk\\w*|wpis\\w*|makr\\w*|weglowodan\\w*|wegli|tluszcz\\w*|bialk\\w*|opis\\w*|skladnik\\w*|porcj\\w*|dokladk\\w*)';

const PATTERNS: RegExp[] = [
  // "zamiast ostatniego posiłku zjadł…", "zjadł jednak…", "zjadła tylko połowę"
  new RegExp(`\\bzamiast\\b.{0,60}(?:${MEAL_WORD}|zjad\\w*|jadl\\w*|wpisan\\w*)`),
  /\b(?:zjadl|zjadla|zjedli|zjadlem|zjadlam|jadl|jadla)\w*\b.{0,30}\b(?:jednak|tylko|wiecej|mniej|polowe|pol\b|caly|cala|cale|calosc|inaczej|dodatkowo|jeszcze)\b/,
  /\bnie (?:zjadl|zjadla|dojadl|dojadla|dokonczyl|dokonczyla)\w*/,
  // "zmień / popraw / usuń obiad", "edytuj makro"
  new RegExp(`\\b(?:zmien|zmienic|popraw|poprawic|edytuj|edytowac|zaktualizuj|aktualizuj|usun|usunac|skasuj|wykasuj|wyrzuc|dopisz|dopisac|dodaj|dodac|zapisz|zapisac|wpisz|wpisac|uzupelnij|uzupelnic|zamien|zamienic|przenies)\\b.{0,50}${MEAL_WORD}`),
  new RegExp(`${MEAL_WORD}.{0,30}\\b(?:zmien|popraw|edytuj|usun|skasuj|zamien|do poprawy|jest zle|jest bledn\\w*|zle wpisan\\w*|bledn\\w*)\\b`),
  // "to były węgle korekcyjne", "to wpisane o 15 to było na hipo", "to była dokładka", "to WBT do obiadu"
  /\bto (?:byl|byla|bylo|byly|jest)\b.{0,30}\b(?:korekc\w*|na hipo|leczenie hipo|hipo\b|wbt|dokladk\w*|osobny posilek|nowy posilek|duplikat\w*|pomylk\w*|blad\w*|prebolus\w*|bolus przed)/,
  /^to\b.{0,10}\bwbt do\b/,
  // "nie przypominaj o WBT", "włącz przypomnienie o WBT"
  /\b(?:nie przypominaj|przypomnij|wlacz|wylacz|wylaczyc|wlaczyc)\b.{0,30}\b(?:wbt|przypomnien\w*)/,
  /\bprzypomnien\w* o wbt\b/,
];

/**
 * Dose, settings and analysis questions stay analyses of the patient's data, even when they name a meal ("ile insuliny
 * na dokładkę?", "jak zmienić przelicznik na obiad?", "dlaczego po obiedzie rośnie?").
 */
const NOT_AN_EDIT = /^(?:a )?(?:co to (?:jest|sa|znaczy)|czym (?:jest|sa)|co oznacza|jak dziala)\b|\b(?:ile|jak duz\w*)\b.{0,30}\b(?:insulin\w*|jednost\w*|bolus\w*|podac|dac|wbt)\b|\bdawk\w*|\bprzelicznik\w*|\bwspolczynnik\w*|\bicr\b|\bisf\b|\bdlaczego\b|\bczemu\b|\bprzeanaliz\w*|\banaliz\w*|\bczy\b.{0,40}\b(?:podni\w*|wplyn\w*|zaszkodzi\w*|spowodowal\w*)/;

/**
 * The patient's glucose now or what to do about it: never a reply to a meal question. ("na hipo", "korekta" and sugars
 * stay out: they answer what an entry was for.)
 */
const GLUCOSE_NOW = /\b(?:spada\w*|spadl\w*|spadek|rosnie|rosl\w*|glukoz\w*|glikem\w*|co (?:mam |teraz |robic|robimy)\w*)/;

/** True when the message asks to change a meal, its values, what a loop entry was for, or a WBT reminder. */
export function isMealEditRequest(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized || normalized.length > 600 || NOT_AN_EDIT.test(normalized)) return false;
  return PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Short replies after an answer that was working on a meal ("około 50 g", "ten z 13:10") continue that work. */
const MEAL_FOLLOW_UP_MAX_CHARS = 160;

/**
 * True when the caregiver message continues an answer that used the meal tools: the previous assistant message is
 * marked meal_assistant and the reply is short (an answer to its question, a correction of its card).
 */
export function continuesMealAssistant(messages: Array<Record<string, unknown>>, userText: string, beforeMessageId?: string | null): boolean {
  const normalized = normalize(userText);
  // A dose, analysis or glucose-now question ("a teraz spada do 60, co robić?") needs the patient's data, not the meal tools.
  if (normalized.length > MEAL_FOLLOW_UP_MAX_CHARS || NOT_AN_EDIT.test(normalized) || GLUCOSE_NOW.test(normalized)) return false;
  const upTo = beforeMessageId ? messages.findIndex((message) => String(message.id) === beforeMessageId) : messages.length;
  const earlier = messages.slice(0, upTo < 0 ? messages.length : upTo);
  const lastAssistant = [...earlier].reverse().find((message) => String(message.role ?? '').toUpperCase() === 'ASSISTANT');
  const metadata = (lastAssistant?.metadata ?? null) as Record<string, unknown> | null;
  return metadata?.meal_assistant === true;
}
