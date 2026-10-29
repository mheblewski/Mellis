/**
 * Which card and meal tools an answer gets (answer-tool-scope.v1, payload audit 2026-10-26). Their definitions and
 * rules are about 10k input tokens of every chat request; a question that is only an analysis of the past or general
 * knowledge never uses them. Conservative: the tools are left out only when the question is clearly such a question,
 * names no dose, food or "now", has no photo and does not follow an answer with cards. Anything else keeps them.
 */

import { isGeneralKnowledgeQuestion } from '@modules/context/application/investigation-policy';

export const ANSWER_TOOL_SCOPE_VERSION = 'answer-tool-scope.v1';

function normalize(text: string): string {
  return text.toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

/** A look back or an explanation: an analysis, a period, a cause, a pattern. */
const ANALYSIS_ONLY = /\b(?:przeanaliz\w*|analiz\w*|podsumu\w*|podsumowanie|jak (?:wyglada\w*|wygladal\w*|minal\w*|minel\w*|poszl\w*|poszedl)|dlaczego|czemu|skad|co sie stalo|ostatni\w* \d+ dni|ostatni\w* (?:tydzien|tygodni\w*|miesiac\w*)|tydzien|tygodni\w*|miesiac\w*|wczoraj\w*|przedwczoraj|srednia|srednio|tir\b|time in range|statysty\w*|wzorz\w*|wzorc\w*|powtarza\w*|ostatnio)/;

/** A dose, food, a card, a reminder or the moment now: the card tools may be needed. */
const DOSE_OR_NOW = /\b(?:dawk\w*|poda\w*|podaj\w*|dac|daj\w*|dam|insulin\w*|bolus\w*|jednost\w*|korekt\w*|przygotuj\w*|kart\w*|opcj\w*|teraz|zaraz|w tej chwili|za \d+ ?min\w*|przypom\w*|dosladz\w*|sok\w*|spada\w*|niski\w*|wpisz\w*|zapisz\w*|wyslij\w*|trio)\b|\d+ ?(?:g|gram\w*|ww|wbt|j)\b/;

/** Food or a meal: the meal tools (get_meals, propose_meal_change, search_food) may be needed. */
const MEAL = /\b(?:posil\w*|obiad\w*|sniadan\w*|kolacj\w*|przekask\w*|deser\w*|jedzeni\w*|jadl\w*|zjad\w*|zje\w*|jedz\w*|wegl\w*|weglowodan\w*|ww|wbt|bialk\w*|tluszcz\w*|produkt\w*|kalor\w*|porcj\w*)\b/;

export interface AnswerToolScope {
  /** propose_bolus (with estimate_wbt), propose_rescue_carbs, set_reminder and their rules. */
  cards: boolean;
  /** get_meals, propose_meal_change, search_food and their rules. */
  meals: boolean;
}

export function answerToolScope(args: {
  text: string;
  hasPhotos: boolean;
  /** The previous answer of the conversation prepared cards or options: a reply may change or pick them. */
  previousAnswerHadCards: boolean;
  /** A rescue alert's or a WBT conversation, or a meal change: their own tools are always kept. */
  specialConversation: boolean;
}): AnswerToolScope {
  const all = { cards: true, meals: true };
  if (args.hasPhotos || args.previousAnswerHadCards || args.specialConversation) return all;
  const text = normalize(args.text);
  const lookBack = ANALYSIS_ONLY.test(text) || isGeneralKnowledgeQuestion(args.text);
  if (!lookBack) return all;
  return { cards: DOSE_OR_NOW.test(text), meals: MEAL.test(text) || DOSE_OR_NOW.test(text) };
}
