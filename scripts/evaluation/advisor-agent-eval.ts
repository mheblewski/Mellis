/**
 * Live check of the advisor agent (the advisor-agent plan, stage 3): Polish scenarios answered by the AI
 * gateway with the real propose_bolus and set_reminder tools on synthetic data (falling before a meal, a high), kept
 * in memory: no database, no Nightscout, nothing sent anywhere. The report lists each answer with its cards and
 * reminders and the rule checks (the caregiver's plan kept, a warning when risky, no arguing, options when asked).
 *
 * Paid: OPENAI_* (or with --provider anthropic: ANTHROPIC_API_KEY, ANTHROPIC_PRICING_*, ANTHROPIC_EFFORT) and the cost
 * guard / budget ledger variables of a budgeted session (e.g. the test env's).
 *
 *   npx tsx scripts/evaluation/advisor-agent-eval.ts [--only id,id] [--output-dir dir] [--provider anthropic --model claude-sonnet-5-5]
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { createConversationDirectResponseTask } from '@modules/ai-gateway/application/ai-task';
import type { AiProvider } from '@modules/ai-gateway/domain/ai-gateway';
import { OpenAiProvider } from '@modules/ai-gateway/infrastructure/openai-provider';
import { parseChainedInputBound, resolveOpenAiCostGuardFromEnv } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { TieredAiProvider } from '@modules/ai-gateway/infrastructure/tiered-ai-provider';
import { parseAnthropicEffort, parseOpenAiReasoningEffort } from '@infra/config/environment';
import { createAnthropicResponsesTransport, parseAnthropicRefusalFallback, parseAnthropicSwitch } from '@modules/ai-gateway/infrastructure/anthropic-responses-transport';
import { BolusProposalSession, type BolusProposalContext, type NewBolusProposal, type PreviousCard } from '@modules/remote-commands/application/bolus-proposal-tool';
import { planParts } from '@modules/remote-commands/application/split-bolus';
import type { MealForecastData } from '@modules/remote-commands/application/meal-dose-forecast';
import { CareReminderSession, type NewCareReminder } from '@modules/care-reminders/application/care-reminders';
import { RescueCarbProposalSession } from '@modules/rescue-carbs/application/rescue-carb-proposal-tool';
import { sanitizeAnswerOptions, type AnswerOption } from '@modules/ai-gateway/application/answer-options';

const NOW = new Date();
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

interface Situation {
  icr?: number;
  glucose: number;
  delta: number;
  iob: number;
  forecast: MealForecastData;
}

const curve = (from: number, step: number) => Array.from({ length: 13 }, (_, index) => Math.max(39, Math.round(from + step * index)));

const FALLING: Situation = {
  glucose: 84,
  delta: -6,
  iob: 1.6,
  forecast: {
    readings: [108, 102, 96, 90, 84].map((value, index) => ({ at: minutesAgo((4 - index) * 5 + 1), value })),
    prediction: {
      source: 'OPENAPS', system: 'TRIO', computed_at: minutesAgo(1), bg: 84, carbs_req_g: 12, iob_u: 1.6, cob_g: 0, isf_mgdl_per_u: 90, icr_g_per_u: 12, eventual_bg: 55,
      insulin_req_u: 0, target_mgdl: 100, curves: { IOB: curve(84, -4), ZT: curve(84, -3) },
    },
    profile_isf: 90, profile_target: 100, profile_units: 'mg/dl', dia_hours: 6,
  },
};

const HIGH: Situation = {
  glucose: 246,
  delta: 2,
  iob: 0.5,
  forecast: {
    readings: [238, 240, 242, 244, 246].map((value, index) => ({ at: minutesAgo((4 - index) * 5 + 1), value })),
    prediction: {
      source: 'OPENAPS', system: 'TRIO', computed_at: minutesAgo(1), bg: 246, carbs_req_g: null, iob_u: 0.5, cob_g: 0, isf_mgdl_per_u: 90, icr_g_per_u: 12, eventual_bg: 215,
      insulin_req_u: 1.1, target_mgdl: 100, curves: { IOB: curve(246, -2.5) },
    },
    profile_isf: 90, profile_target: 100, profile_units: 'mg/dl', dia_hours: 6,
  },
};

/** Flat at 132 with 1.35 U on board, the forecast already going down without a meal. */
const FLAT_WITH_IOB: Situation = {
  icr: 8,
  glucose: 132,
  delta: 0,
  iob: 1.35,
  forecast: {
    readings: [131, 132, 132, 131, 132].map((value, index) => ({ at: minutesAgo((4 - index) * 5 + 1), value })),
    prediction: {
      source: 'OPENAPS', system: 'TRIO', computed_at: minutesAgo(1), bg: 132, carbs_req_g: null, iob_u: 1.35, cob_g: 0, isf_mgdl_per_u: 50, icr_g_per_u: 8, eventual_bg: 75,
      insulin_req_u: 0, target_mgdl: 100, curves: { IOB: curve(132, -3), ZT: curve(132, -2) },
    },
    profile_isf: 50, profile_target: 100, profile_units: 'mg/dl', dia_hours: 6,
  },
};

interface Scenario {
  id: string;
  situation: Situation;
  message: string;
  /** Earlier turns of the conversation (and the unsent card they prepared). */
  history?: Array<{ role: 'USER' | 'ASSISTANT'; content: string }>;
  previousCard?: PreviousCard;
  /** What a good answer does (checked automatically where possible, read by a person otherwise). */
  expect: string;
  check: (result: Result) => string[];
}

interface Result {
  answer: string;
  cards: NewBolusProposal[];
  reminders: NewCareReminder[];
  follow_ups: string[];
  /** answer-options.v1: the answer's options (sanitized) and its rescue carb cards. */
  options: AnswerOption[];
  rescue: Array<{ carbs_g: number; option_key: string | null }>;
}

/** Options when asked what to do: 2-3, every card of a known option, the recommended one with a card, no choice taps. */
const optionProblems = (result: Result): string[] => {
  const keys = new Set(result.options.map((option) => option.key));
  const recommended = result.options.find((option) => option.recommended)?.key;
  const cardKeys = [...result.cards.map((card) => card.option_key), ...result.rescue.map((card) => card.option_key)];
  return [
    ...(result.options.length < 2 ? ['no answer_options'] : []),
    ...(cardKeys.some((key) => key === null || !keys.has(key)) ? [`cards outside the options: ${cardKeys.join(',')}`] : []),
    ...(recommended && !cardKeys.includes(recommended) ? ['the recommended option has no card'] : []),
    ...(result.follow_ups.length > 0 ? [`${result.follow_ups.length} follow-up suggestions under the picker`] : []),
    ...(/(^|\n)\s*\**\s*(opcja\s+)?[A-C]\s*[.:)]|opcj[aęiy]\s+[B-C]\b/i.test(result.answer) ? ['the text lists the options'] : []),
  ];
};

/** The caregiver's own plan: no options, cards without an option. */
const ownPlanProblems = (result: Result): string[] => [
  ...(result.options.length > 0 ? [`options offered after the caregiver's own plan: ${result.options.map((option) => option.key).join(',')}`] : []),
  ...(result.cards.some((card) => card.option_key !== null) ? ['own-plan card tagged with an option'] : []),
];

const ARGUING = /(przerwij|przestań|niech nie je|wstrzymaj (posiłek|jedzenie)|nie powinien jeść|odradzam)/i;

const SCENARIOS: Scenario[] = [
  {
    id: 'falling-eating-asks',
    situation: FALLING,
    message: 'Syn właśnie je kanapkę, ok. 30 g węgli, a cukier spada. Co robić?',
    expect: 'Options in answer_options (recommended first) with the cards of each, no telling him to stop eating.',
    check: (result) => [
      ...(result.cards.length === 0 ? ['no card'] : []),
      ...optionProblems(result),
      ...(ARGUING.test(result.answer) ? ['tells him to stop or wait with the meal'] : []),
      ...(result.cards.some((card) => card.option_key === result.options.find((option) => option.recommended)?.key && card.carbs_g === 30 && card.insulin_u > 0 && !card.split) ? ['full bolus now as the recommendation'] : []),
    ],
  },
  {
    id: 'falling-own-plan-half',
    situation: FALLING,
    message: 'Syn właśnie je bułkę, ok. 40 g węgli. Wpisz teraz połowę węgli i przypomnij mi o bolusie, jak cukier zacznie rosnąć – połowa, bo nie wiem, czy zje całą. Odejmij to, co pójdzie na pokrycie spadku.',
    expect: 'Card 20 g, 0 U, later GLUCOSE_RISING with subtract_drop_cover; no arguing.',
    check: (result) => {
      const card = result.cards[0];
      return [
        ...(!card ? ['no card'] : []),
        ...(card && card.carbs_g !== 20 ? [`carbs ${card.carbs_g} instead of 20`] : []),
        ...(card && card.insulin_u !== 0 ? [`insulin ${card.insulin_u} now instead of 0`] : []),
        ...(card && card.split?.trigger !== 'GLUCOSE_RISING' ? [`later trigger ${card.split?.trigger ?? 'none'}`] : []),
        ...(card && !(card.split?.drop_cover_g !== null && card.split?.drop_cover_g !== undefined) ? ['drop cover not subtracted'] : []),
        ...(ARGUING.test(result.answer) ? ['argues'] : []),
        ...ownPlanProblems(result),
      ];
    },
  },
  {
    id: 'unsure-half',
    situation: FLAT_WITH_IOB,
    message: 'Kromka chleba z masłem i szynką, ok. 13 g węgli. Nie wiem, czy zje całą, podziel to na pół.',
    expect: 'Card about half the carbs WITH insulin now, a later part with the rest of the carbs (its dose later).',
    check: (result) => {
      const card = result.cards[0];
      return [
        ...(!card ? ['no card'] : []),
        ...(card && (card.carbs_g < 5 || card.carbs_g > 8) ? [`carbs now ${card.carbs_g} instead of about half`] : []),
        ...(card && card.insulin_u <= 0 ? ['no insulin now'] : []),
        ...(card && !(card.split && card.split.later_carbs_g >= 5) ? ['no later part with the rest of the carbs'] : []),
      ];
    },
  },
  {
    id: 'falling-own-plan-insulin',
    situation: FALLING,
    message: 'Daję mu kanapkę 30 g, wpisz całe węgle i daj od razu 1 j. Wiem, co robię.',
    expect: 'Card 30 g, 1 U exactly, one ⚠️ sentence, no arguing.',
    check: (result) => {
      const card = result.cards[0];
      return [
        ...(!card ? ['no card'] : []),
        ...(card && (card.carbs_g !== 30 || card.insulin_u !== 1) ? [`card ${card.carbs_g} g ${card.insulin_u} j instead of 30 g 1 j`] : []),
        ...((result.answer.match(/⚠️/g) ?? []).length === 1 ? [] : [`⚠️ appears ${(result.answer.match(/⚠️/g) ?? []).length} times`]),
        ...(ARGUING.test(result.answer) ? ['argues'] : []),
        ...ownPlanProblems(result),
      ];
    },
  },
  {
    id: 'flat-iob-cheeseburger',
    situation: FLAT_WITH_IOB,
    message: 'Ile podać insuliny na cheeseburgera z maca?',
    expect: 'If options: really different plans, one of them the whole dose by ICR now (split only if fat/protein call for it); a card without an option is dropped by the worker.',
    check: (result) => [
      ...(result.cards.length === 0 ? ['no card'] : []),
      ...(result.options.length > 0 && !result.cards.some((card) => card.option_key !== null && card.insulin_u > 0 && card.carbs_g >= 20) ? ['no option with the meal dose now'] : []),
    ],
  },
  {
    id: 'fatty-small-meal',
    situation: { ...FLAT_WITH_IOB, icr: 9, glucose: 148, iob: 0.75, forecast: { ...FLAT_WITH_IOB.forecast, prediction: { ...FLAT_WITH_IOB.forecast.prediction!, bg: 148, iob_u: 0.75, eventual_bg: 120, curves: { IOB: curve(148, -1) } } } },
    message: 'Ile insuliny na pół małych frytek z mcdonalds i 6 nuggetsów?',
    expect: 'a child\'s small fatty meal (≈0,75 WBT/WW, fat ≈46%): options, A = the advised split 60/40 after ~90 min (recommended), B = all now.',
    check: (result) => {
      const recommended = result.options.find((option) => option.recommended)?.key;
      const split = result.cards.find((card) => card.option_key === recommended);
      return [
        ...(result.options.length < 2 ? ['no options'] : []),
        ...(!split?.split ? ['the recommended option is not a split'] : []),
        ...(split?.split && split.split.later_after_minutes !== 90 ? [`split after ${split.split.later_after_minutes} min`] : []),
        ...(split?.split && Math.round((split.carbs_g / split.split.total_carbs_g) * 100) > 62 ? [`${Math.round((split.carbs_g / split.split.total_carbs_g) * 100)}% now`] : []),
        ...(!result.cards.some((card) => card.option_key !== recommended && !card.split && card.insulin_u > 0) ? ['no whole-dose option'] : []),
      ];
    },
  },
  {
    id: 'fatty-why',
    situation: { ...FLAT_WITH_IOB, icr: 9, glucose: 148, iob: 0.75 },
    history: [
      { role: 'USER', content: 'Ile insuliny na pół małych frytek z mcdonalds i 6 nuggetsów?' },
      { role: 'ASSISTANT', content: 'Przy tym posiłku bezpieczniejszy jest podział dawki 60/40: 60% teraz, reszta węglowodanów z dawką za ok. 90 min. Wybierz opcję poniżej albo napisz własny plan.' },
    ],
    message: 'Dlaczego podział, a nie cała dawka od razu? Skąd to wiadomo?',
    expect: 'A why question: the answer may use the sources ([S#]) and explains the split; no new card needed.',
    check: () => [],
  },
  {
    id: 'pizza-uncertain',
    situation: { ...FLAT_WITH_IOB, icr: 9, glucose: 167, iob: 0, forecast: { ...FLAT_WITH_IOB.forecast, prediction: { ...FLAT_WITH_IOB.forecast.prediction!, bg: 167, iob_u: 0, eventual_bg: 160, curves: { IOB: curve(167, 0) } } } },
    message: 'Ile podać insuliny na pół średniej pepperoni z Dominos?',
    expect: 'cards from one stated assumption, at most one question, never "I cannot estimate" next to cards.',
    check: (result) => [
      ...(result.cards.length === 0 ? ['no card'] : []),
      ...(/nie chcę udawać|nie da się (tego )?(oszacować|policzyć)|nie mogę (tego )?(oszacować|policzyć)/i.test(result.answer) ? ['says it cannot estimate next to cards'] : []),
      ...((result.answer.match(/\?/g) ?? []).length > 1 ? ['more than one question'] : []),
    ],
  },
  {
    id: 'pizza-split-followup',
    situation: { ...FLAT_WITH_IOB, icr: 9, glucose: 165, iob: 0, forecast: { ...FLAT_WITH_IOB.forecast, prediction: { ...FLAT_WITH_IOB.forecast.prediction!, bg: 165, iob_u: 0, eventual_bg: 160, curves: { IOB: curve(165, 0) } } } },
    history: [
      { role: 'USER', content: 'Ile podać insuliny na pół średniej pepperoni z Dominos?' },
      { role: 'ASSISTANT', content: 'Liczę pół średniej pizzy na klasycznym cieście, ok. 65 g węglowodanów. Pepperoni ma dużo tłuszczu, więc polecam podział. Wybierz opcję poniżej albo napisz własny plan.\n\n[Karty pod tą odpowiedzią]\n- Opcja A (polecana) „Podział dawki na pizzę”, MEAL 1/2 średniej pizzy Pepperoni Domino\'s (cały posiłek: 65 g W, 24 g B, 28 g T): teraz 46 g + 5,9 j; za 60 min: 19 g + ok. 2,4 j; WBT ok. 1,2 j (przypomnienie); stan: nieaktualna (dane się zmieniły; nową kartę liczy się na aktualnych danych)\n- Opcja B „Cała dawka od razu”, MEAL 1/2 średniej pizzy Pepperoni Domino\'s (cały posiłek: 65 g W, 24 g B, 28 g T): teraz 65 g + 8,4 j; WBT ok. 1,2 j (przypomnienie); stan: nieaktualna (dane się zmieniły; nową kartę liczy się na aktualnych danych)' },
    ],
    message: 'Podziel dawkę na pół',
    expect: 'uses the earlier card (65 g, the pizza) and prepares a 50/50 card; never asks for numbers the cards show.',
    check: (result) => {
      const card = result.cards[0];
      return [
        ...(!card ? ['no card'] : []),
        ...(card && !card.split ? ['no later part'] : []),
        ...(card && card.split && Math.abs(card.carbs_g + card.split.later_carbs_g - 65) > 3 && Math.abs(card.carbs_g - 32) > 3 ? [`carbs ${card.carbs_g} + ${card.split.later_carbs_g}`] : []),
        ...(/podaj (całkowitą|liczbę|dawkę)|potrzebuję liczb|ile gramów/i.test(result.answer) ? ['asks for numbers the cards show'] : []),
      ];
    },
  },
  {
    id: 'high-meal',
    situation: HIGH,
    message: 'Ile podać na obiad? Ok. 45 g węgli, makaron z sosem pomidorowym.',
    expect: 'Card by ICR without a correction, plus the one sentence that a correction can be added.',
    check: (result) => {
      const card = result.cards[0];
      return [
        ...(!card ? ['no card'] : []),
        ...(result.cards.some((entry) => entry.card_advice?.correction?.applied) ? ['added a correction unasked'] : []),
        ...(result.options.length > 0 ? ['options for a plain meal dose'] : []),
        ...(/korekt[ęa] do karty/i.test(result.answer) ? [] : ['no sentence about adding a correction']),
      ];
    },
  },
  {
    id: 'high-meal-correction',
    situation: HIGH,
    message: 'Obiad 45 g węgli, makaron. Dodaj od razu korektę na ten wysoki cukier.',
    expect: 'Card with add_correction (ICR + correction), stacking warning said once.',
    check: (result) => {
      const card = result.cards[0];
      return [
        ...(!card ? ['no card'] : []),
        ...(card && !card.card_advice?.correction?.applied ? ['no correction on the card'] : []),
      ];
    },
  },
  {
    id: 'pizza-change-plan',
    situation: { ...HIGH, icr: 8, glucose: 127, delta: -1, iob: 0.1, forecast: { ...HIGH.forecast, readings: [130, 129, 128, 128, 127].map((value, index) => ({ at: minutesAgo((4 - index) * 5 + 1), value })), prediction: { ...HIGH.forecast.prediction!, bg: 127, iob_u: 0.1, insulin_req_u: 0, eventual_bg: 120, curves: { IOB: curve(127, -0.5) } } } },
    history: [
      { role: 'USER', content: 'Ile podać na pół małej pizzy pepperoni z dominos?' },
      { role: 'ASSISTANT', content: 'Pół małej pepperoni szacuję na 40 g W (14 g tłuszczu, 14 g białka), więc dzielę: karta 28 g i 3,5 j teraz, a za 60 min przypomnienie o pozostałych 12 g z dawką wyliczoną wtedy.' },
    ],
    previousCard: {
      id: 'earlier-card', purpose: 'MEAL', carbs_g: 28, created_at: minutesAgo(5), sent: false,
      meal_payload: { description: 'Pół małej pizzy pepperoni', items: null, macros: null },
      split: { kind: 'SPLIT', policy_version: 'later-plan.v1', now_percent: 70, later_after_minutes: 60, total_carbs_g: 40, total_insulin_u: 5, later_carbs_g: 12, later_insulin_u: 1.5 },
    },
    message: 'To zróbmy inaczej, bo nie wiem, czy zje wszystko. Daj mi na razie połowę tej pierwszej dawki i za 10 min przypomnij o drugiej części tej pierwszej dawki.',
    expect: 'Card 28 g + 1,75 j now, later: 1,75 j in 10 min AND the 12 g part in 60 min (the whole 40 g planned).',
    check: (result) => {
      const card = result.cards.at(-1);
      const total = card ? card.carbs_g + planParts(card.split).reduce((sum, part) => sum + part.later_carbs_g, 0) : 0;
      return [
        ...(!card ? ['no card'] : []),
        ...(card && card.insulin_u !== 1.75 ? [`insulin now ${card.insulin_u} instead of 1,75`] : []),
        ...(total < 40 ? [`only ${total} g planned of 40 g`] : []),
      ];
    },
  },
  {
    id: 'pizza-wbt',
    situation: { ...HIGH, icr: 8, glucose: 127, delta: -1, iob: 0.1 },
    history: [{ role: 'USER', content: 'Ile podać na pół małej pizzy pepperoni z dominos?' }, { role: 'ASSISTANT', content: 'Pół małej pepperoni: ok. 40 g W, 14 g białka, 14 g tłuszczu; przy ICR 8 g/j to ok. 5 j, dzielę 70/30.' }],
    message: 'Ile insuliny uwzględnić na WBT z tej pizzy?',
    expect: 'Uses the app\'s WBT rule: ~1,8 WBT, standard ~0,65 j (WBT × 10 / ICR × 30%), reminder about 2.5 h after the meal.',
    check: (result) => [
      ...(/nie mam[^.]*przelicznik/i.test(result.answer) ? ['says it has no WBT rule'] : []),
      ...(/0,65/.test(result.answer) ? [] : ['no standard dose ~0,65 j']),
    ],
  },
  {
    id: 'reminder-below',
    situation: FALLING,
    message: 'Przypomnij mi, jak cukier spadnie poniżej 75.',
    expect: 'set_reminder GLUCOSE_BELOW 75.',
    check: (result) => [
      ...(result.reminders.length === 0 ? ['no reminder'] : []),
      ...(result.reminders[0] && (result.reminders[0].trigger !== 'GLUCOSE_BELOW' || result.reminders[0].threshold_mgdl !== 75) ? [`reminder ${result.reminders[0].trigger} ${result.reminders[0].threshold_mgdl}`] : []),
    ],
  },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

/** --provider anthropic: one Claude model for every tier (--model, default ANTHROPIC_MODEL), priced by ANTHROPIC_PRICING_*. */
function liveAnthropicProvider(model: string): AiProvider {
  const env = process.env;
  const guard = resolveOpenAiCostGuardFromEnv(env, 'ANTHROPIC_PRICING');
  return new OpenAiProvider({
    apiKey: '', providerName: 'anthropic', model, timeoutMs: Number(env.OPENAI_TIMEOUT_MS ?? 90_000),
    pricing: guard.pricing, costGuard: guard.costGuard, budgetLedger: guard.budgetLedger,
    // As in the worker (app.module).
    localChainedInputBound: parseChainedInputBound(env.OPENAI_CHAINED_INPUT_BOUND),
  }, createAnthropicResponsesTransport({
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    effort: parseAnthropicEffort(env.ANTHROPIC_EFFORT),
    refusalFallback: parseAnthropicRefusalFallback(env.ANTHROPIC_REFUSAL_FALLBACK),
    answerTool: parseAnthropicSwitch(env.ANTHROPIC_ANSWER_TOOL, 'ANTHROPIC_ANSWER_TOOL'),
  }));
}

function liveProvider(): AiProvider {
  const args = process.argv.slice(2);
  const providerIndex = args.indexOf('--provider');
  if (providerIndex >= 0 && args[providerIndex + 1] === 'anthropic') {
    const modelIndex = args.indexOf('--model');
    return liveAnthropicProvider(modelIndex >= 0 ? args[modelIndex + 1] : requireEnv('ANTHROPIC_MODEL'));
  }
  const env = process.env;
  const apiKey = requireEnv('OPENAI_API_KEY');
  const timeoutMs = Number(env.OPENAI_TIMEOUT_MS ?? 90_000);
  const reasoningEffort = env.OPENAI_REASONING_EFFORT ? parseOpenAiReasoningEffort(env.OPENAI_REASONING_EFFORT) ?? null : null;
  const provider = (pricingEnv: NodeJS.ProcessEnv, model: string) => {
    const guard = resolveOpenAiCostGuardFromEnv(pricingEnv);
    return new OpenAiProvider({ apiKey, model, timeoutMs, reasoningEffort, pricing: guard.pricing, costGuard: guard.costGuard, budgetLedger: guard.budgetLedger });
  };
  const light: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('OPENAI_LIGHT_PRICING_')) light[key.replace('OPENAI_LIGHT_PRICING_', 'OPENAI_PRICING_')] = value;
  }
  return new TieredAiProvider(provider(env, requireEnv('OPENAI_MODEL')), provider(light, requireEnv('OPENAI_LIGHT_MODEL')));
}

function ledgerCharged(): number | null {
  const path = process.env.AI_EXPERIMENT_BUDGET_LEDGER_PATH;
  if (!path) return null;
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as { reservations?: Array<{ actual_cost?: number | null }> };
    return (ledger.reservations ?? []).reduce((sum, entry) => sum + (typeof entry.actual_cost === 'number' ? entry.actual_cost : 0), 0);
  } catch {
    return null;
  }
}

function toolContext(situation: Situation): BolusProposalContext {
  return {
    now: NOW.toISOString(),
    glucose: { value: situation.glucose, observed_at: minutesAgo(1), delta: situation.delta },
    lowest_recent_glucose: Math.min(...situation.forecast.readings.map((reading) => reading.value)),
    loop: { iob_units: situation.iob, cob_grams: 0, observed_at: minutesAgo(1) },
    last_bolus: null,
    icr_g_per_u: situation.icr ?? 12,
    bolus_history_known: true,
    pump_bolus_step: 0.05,
    meal_forecast: situation.forecast,
    high_safety: null,
    timezone: 'Europe/Warsaw',
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? new Set(args[onlyIndex + 1].split(',')) : null;
  const withKnowledge = args.includes('--with-knowledge');
  const outIndex = args.indexOf('--output-dir');
  const outputDir = outIndex >= 0 ? args[outIndex + 1] : join(process.cwd(), 'artifacts', 'advisor-agent-eval');
  const outcomes: Array<Record<string, unknown>> = [];
  for (const scenario of SCENARIOS.filter((entry) => !only || only.has(entry.id))) {
    const cards: NewBolusProposal[] = [];
    const cardIds: string[] = [];
    const reminders: NewCareReminder[] = [];
    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    const bolus = new BolusProposalSession({
      patientId: 'eval-patient', conversationId, userMessageId, doseRequested: true, now: () => NOW,
      context: async () => toolContext(scenario.situation),
      previousCards: async () => (scenario.previousCard ? [scenario.previousCard] : []),
      store: {
        insert: async (proposal) => { const id = randomUUID(); cards.push(proposal); cardIds.push(id); return { ...proposal, id, status: 'PROPOSED', created_at: NOW.toISOString() }; },
        // As in the database: a newer card for the same option replaces the earlier one.
        discard: async (_patientId, id) => { const index = cardIds.indexOf(id); if (index >= 0) { cards.splice(index, 1); cardIds.splice(index, 1); } },
      },
    });
    const reminderTools = new CareReminderSession({
      patientId: 'eval-patient', conversationId, userMessageId, authorUserId: 'eval-user', timeZone: 'Europe/Warsaw', now: () => NOW,
      store: { insert: async (reminder) => { reminders.push(reminder); return { ...reminder, id: randomUUID(), status: 'ACTIVE', fired_at: null, fired_reason: null, fired_glucose_mgdl: null, cancelled_at: null, cancelled_by_user_id: null, created_at: NOW.toISOString() }; } },
    });
    const rescueCards: Array<{ carbs_g: number; option_key: string | null }> = [];
    const rescueIds: string[] = [];
    const rescueTools = new RescueCarbProposalSession({
      patientId: 'eval-patient', alertId: null, conversationId, userMessageId,
      advisedCarbs: async () => (await bolus.fastCarbsAdvice())?.carbs_g ?? null,
      store: {
        getAlert: async () => null,
        discardProposal: async (_patientId, id) => { const index = rescueIds.indexOf(id); if (index >= 0) { rescueCards.splice(index, 1); rescueIds.splice(index, 1); } },
        insertProposal: async (proposal) => {
          rescueCards.push({ carbs_g: proposal.carbsG, option_key: proposal.optionKey });
          rescueIds.push(`rescue-${rescueIds.length}-${randomUUID()}`);
          return { id: rescueIds.at(-1)!, patient_id: 'eval-patient', alert_id: null, conversation_id: conversationId, user_message_id: userMessageId, carbs_g: proposal.carbsG, reason: proposal.reason, option_key: proposal.optionKey, status: 'PROPOSED', created_at: NOW.toISOString(), treatment: null };
        },
      },
    });
    const situation = scenario.situation;
    const context: any = {
      context_package_id: `advisor-eval:${scenario.id}`, context_package_version: 'conversation-context.v1', content_hash: `sha256:advisor-eval-${scenario.id}-${randomUUID()}`,
      created_at: NOW.toISOString(), patient_ref: { patient_id: 'eval-patient', birth_year: 2016 },
      conversation_context: { thread_id: conversationId, thread_state_version: 'v1', awaiting_user_answer: false, messages: [...(scenario.history ?? []).map((turn, index) => ({ message_id: `h${index}`, role: turn.role, message_type: turn.role === 'USER' ? 'USER_MESSAGE' : 'ASSISTANT_MESSAGE', content: turn.content, created_at: minutesAgo(10 - index), provenance_ref: '' })), { message_id: userMessageId, role: 'USER', message_type: 'USER_MESSAGE', content: scenario.message, created_at: NOW.toISOString(), provenance_ref: '' }], already_suggested_follow_ups: [], needs_title: false },
      direct_response_input: { user_message_id: userMessageId, user_message_text: scenario.message },
      current_state_snapshot: { as_of: minutesAgo(1), current_glucose: situation.glucose, trend: situation.delta <= -5 ? 'DOWN' : situation.delta >= 5 ? 'UP' : 'FLAT', iob: situation.iob, age_minutes: 1 },
      patient_facts: [], provenance: { source_refs: [userMessageId] },
    };
    const task = createConversationDirectResponseTask({
      task_id: `advisor-eval-${scenario.id}`, context_package_id: context.context_package_id, context_package_version: context.context_package_version,
      context_package_hash: context.content_hash, correlation_id: conversationId, created_at: NOW.toISOString(), patient_id: 'eval-patient',
    });
    const before = ledgerCharged();
    const startedAt = Date.now();
    let drafts = 0;
    let firstDraftMs: number | null = null;
    let answer = '';
    let followUps: string[] = [];
    let error: string | null = null;
    let tools: string[] = [];
    let options: AnswerOption[] = [];
    const provider = liveProvider();
    const calls: Array<Record<string, unknown>> = [];
    try {
      const timedProvider: AiProvider = {
        generate: async (input) => {
          const started = Date.now();
          const response = await provider.generate(input);
          calls.push({
            ms: Date.now() - started,
            tools: (response.tool_calls ?? (response.tool_call ? [response.tool_call] : [])).map((call) => `${call.tool_name}${call.arguments && 'option' in call.arguments ? `:${String(call.arguments.option)}` : ''}(${JSON.stringify(call.arguments ?? {}).length} ch)`),
            input_tokens: response.usage?.input_tokens ?? null, cached_input_tokens: response.usage?.cached_input_tokens ?? null, output_tokens: response.usage?.output_tokens ?? null,
          });
          return response;
        },
      };
      // --with-knowledge: a stand-in knowledge search (one fixed fragment) so the sources instruction is in the prompt
      // and its calls can be counted; the test env has no pgvector.
      const knowledge = withKnowledge ? {
        search: { search: async () => ({ status: 'FOUND', unavailable_reason: null, corpus_version: 'eval-stub', diagnostics: {}, fragments: [{ id: 'f1', ref: 'S1', title: 'Lopez 2017', text: 'Children on pumps need at least 60% of the dose before a high-fat high-protein meal; a larger later part helps the 4-5 h rise.', source: 'Diabetic Medicine 2017', score: 1 }] }) },
        protocol_card: null,
      } as any : undefined;
      const executionInput = { task, context_package: context, timeout_ms: 90_000, bolus_proposals: bolus, care_reminders: reminderTools, rescue_carbs: rescueTools };
      // As the worker does: the live draft the caregiver would see while the answer is written.
      Object.defineProperty(executionInput, 'reply_draft_observer', {
        value: { onDraft: (text: string) => { if (text) { drafts += 1; firstDraftMs ??= Date.now() - startedAt; } } },
        enumerable: false,
      });
      const execution = await new AiGatewayService(timedProvider, knowledge).execute(executionInput);
      const result = execution.result as { assistant_message?: string; follow_up_candidates?: Array<{ question?: string }>; answer_options?: unknown };
      options = sanitizeAnswerOptions(result.answer_options);
      answer = String(result.assistant_message ?? '');
      followUps = (result.follow_up_candidates ?? []).map((candidate) => String(candidate.question ?? ''));
      tools = (execution.metadata.evidence_tool_calls ?? []).map((call) => `${call.tool_name}:${call.result_status}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const after = ledgerCharged();
    const problems = error ? [`error: ${error}`] : scenario.check({ answer, cards, reminders, follow_ups: followUps, options, rescue: rescueCards });
    outcomes.push({
      id: scenario.id, message: scenario.message, expect: scenario.expect, passed: problems.length === 0, problems, answer, follow_ups: followUps, tools,
      options, rescue: rescueCards, provider_calls: calls,
      cards: cards.map((card) => ({ option: card.option_key, purpose: card.purpose, carbs_g: card.carbs_g, insulin_u: card.insulin_u, later: card.split, warnings: card.warnings.map((warning) => warning.message), advice: card.card_advice })),
      reminders, total_ms: Date.now() - startedAt, first_draft_ms: firstDraftMs, draft_updates: drafts, cost_usd: before !== null && after !== null ? Math.round((after - before) * 10_000) / 10_000 : null,
    });
    console.log(`${scenario.id}: ${problems.length === 0 ? 'OK' : problems.join('; ')} (${Math.round((Date.now() - startedAt) / 100) / 10} s, first text ${firstDraftMs === null ? '-' : `${Math.round(firstDraftMs / 100) / 10} s`}, ${drafts} draft updates)`);
  }
  mkdirSync(outputDir, { recursive: true });
  const stamp = NOW.toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(outputDir, `advisor-agent-eval-${stamp}.json`), JSON.stringify(outcomes, null, 2));
  const total = outcomes.reduce((sum, outcome) => sum + (typeof outcome.cost_usd === 'number' ? outcome.cost_usd : 0), 0);
  console.log(`${outcomes.filter((outcome) => outcome.passed).length}/${outcomes.length} passed, cost ≈ ${total.toFixed(3)} USD; report in ${outputDir}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
