import { readBooleanFlag } from '@infra/config/environment';
import type { AiRuntimeToolDefinition } from '@modules/ai-gateway/domain/ai-gateway';
import { readOptionKey, type AnswerOption, type AnswerOptionKey } from '@modules/ai-gateway/application/answer-options';
import { sanitizeMealItems, sumMealItems, type MealItem } from '@modules/meal-candidates/application/meal-items';
import { evaluateRemoteCommand, formatUnits, pumpBolusStep, REMOTE_COMMAND_POLICY, roundDownToStep, type RemoteCommandContext, type RemoteCommandEvaluation } from './remote-command-policy';
import type { RemoteCommandMealPayload } from './remote-command-record';
import { computeFastCarbsFirst, computeMealDoseAdjustment, readMealDoseAdjustment, type FastCarbsFirst, type MealDoseAdjustment, type MealForecastData } from './meal-dose-forecast';
import { CARD_ADVICE_POLICY, computeCardForecastChart, computeCorrectionDose, computePlanRisk, planRiskFromChart, planSituation, type CardForecastChart, correctionWarnings, riskWarning, type CardWarning, type CorrectionEstimate, type PlanRisk, type PlanSituation, type RiskLevel } from './card-advice';
import { detectHighDespiteInsulin, type HighGlucoseSafetyInputs } from './high-glucose-safety';
import { computeLaterPlans, LATER_PLAN_POLICY, MAX_LATER_PARTS, parseLaterRequest, planParts, planTrigger, readSplitPlan, type LaterRequest, type PlannedBolusSummary, type SplitPlan } from './split-bolus';
import { computeSplitAdvice, isFattyMeal, mealFatProteinShare } from './split-advice';
import { fatProteinUnitsOf, shouldRemindAboutWbt, standardWbtDose, WBT_REMINDER_DELAY_MINUTES } from '@modules/meal-wbt/application/wbt-policy';
import { calculatorUnavailableWarning, DOSE_CALCULATOR_POLICY, doseExceedsFormula, icrBasisCalculation, referenceWhy, safeDoseCalculation, type DoseCalculation } from './dose-calculator';
import { loopSystemNames } from '@modules/loop-system/domain/loop-system';

/**
 * propose_bolus: the chat's way to offer carbs and a dose the caregiver can give with one tap (remote-bolus-trio-plan.md
 * W7). Since bolus-proposals.v4 (the advisor-agent plan) the card carries the
 * caregiver's own plan: the carbs and insulin the model passes are the card's, a later part is the plan the caregiver
 * asked for. The server computes the dose only when asked (insulin_u null: carbs / ICR, lowered for a drop or with a
 * correction when the model says so) and returns advice (fast carbs first, the dose lowered for a drop, a correction)
 * and the risk of exactly this card (card-advice.v1) as warnings. Only amounts that cannot be sent block. Nothing is
 * sent: the card's button opens the confirmation, then Face ID.
 */

export const PROPOSE_BOLUS_TOOL_NAME = 'propose_bolus';
export const BOLUS_PROPOSAL_POLICY_VERSION = 'bolus-proposals.v8';
/** A plan may need more than one card (e.g. a rescue card's partner: the meal's carbs now, the bolus later). */
export const MAX_PROPOSE_BOLUS_CALLS_PER_ANSWER = 6;
/** The card's button turns into "Przelicz" after this. */
const BOLUS_PROPOSAL_VALID_MINUTES = 15;
/** Cards are computed for the most common step; the phone rounds down to its own pump step again. */
const CARD_BOLUS_STEP = 0.05;

export type BolusProposalPurpose = 'MEAL' | 'CORRECTION' | 'PRE_BOLUS';

/** AI_ENABLE_BOLUS_PROPOSALS: the chat may prepare bolus cards (still only for caregivers with remote commands on). */
export function isBolusProposalsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBooleanFlag(env, 'AI_ENABLE_BOLUS_PROPOSALS');
}

export const PROPOSE_BOLUS_TOOL_DEFINITION: AiRuntimeToolDefinition = {
  name: PROPOSE_BOLUS_TOOL_NAME,
  description: 'Prepares a card the caregiver can give from the app: carbohydrates and insulin sent to the patient\'s loop (Trio or Loop) after the caregiver confirms and passes Face ID, plus an optional later part with its reminder. Nothing is sent by this tool. The card carries exactly the numbers passed; with insulin_u null the server computes the dose (carbs / ICR, or the correction for CORRECTION). Returns PROPOSED with the card, the advice computed from the data and the warnings of this exact plan; NEEDS_DOSE when the server cannot compute a dose (ask the caregiver or pass insulin_u); NO_DOSE_NEEDED for a correction the insulin on board already covers; BLOCKED only for amounts that cannot be sent.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      purpose: { type: 'string', enum: ['MEAL', 'CORRECTION', 'PRE_BOLUS'], description: 'MEAL: carbs of a meal (with its dose now, or 0 U now and the dose later). CORRECTION: insulin for a high without carbs, or correction carbs without insulin. PRE_BOLUS: insulin before a meal whose carbs are entered later.' },
      carbs_g: { type: ['integer', 'null'], description: 'Carbohydrates to enter in the loop now, whole grams; null or 0 without carbs.' },
      insulin_u: { type: ['number', 'null'], description: 'The dose now exactly as the caregiver\'s plan says (0 for carbs only, e.g. a deferred bolus); null: the server computes it (MEAL: carbs / ICR, lowered by the loop-style calculator (IOB, glucose, trend) and for a falling glucose, 0 U while carbs come first; see add_correction; CORRECTION: (glucose − target) / ISF − IOB).' },
      standard_plan: { type: 'boolean', description: 'MEAL with insulin_u null: the dose for all carbs by ICR, not lowered or deferred for a low. Only when the caregiver asks for the whole dose now ("całą dawkę teraz") or for the standard option of an answer with options the caregiver asked for.' },
      reduce_for_drop: { type: 'boolean', description: 'Kept for compatibility: with insulin_u null the server always lowers the dose for a falling glucose. Pass true when the plan uses the lowered dose.' },
      add_correction: { type: 'boolean', description: 'MEAL with insulin_u null: add the correction for a high to the dose. Only when the caregiver asked for a correction. False otherwise.' },
      eating_now: { type: 'boolean', description: 'The patient is already eating (the risk forecast starts the carbs now instead of in 10 min).' },
      meal_description: { type: ['string', 'null'], description: 'MEAL: short Polish name of the meal as the caregiver described it ("Naleśniki z serem ×2"); else null.' },
      items: {
        type: ['array', 'null'],
        description: 'MEAL: the meal\'s items as computed (search_food: DIABCALC, else ESTIMATE); null when not computed item by item.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            grams: { type: ['number', 'null'] },
            carbs_g: { type: 'number' },
            protein_g: { type: 'number' },
            fat_g: { type: 'number' },
            source: { type: 'string', enum: ['DIABCALC', 'ESTIMATE'] },
          },
          required: ['name', 'grams', 'carbs_g', 'protein_g', 'fat_g', 'source'],
        },
      },
      use_advised_split: { type: 'string', enum: ['NO', 'ADVISED', 'STRONGER'], description: 'MEAL with items: ADVISED makes this card the server\'s split (carbs_g = the whole meal; the server sets the parts now and later and their doses); STRONGER one level more later (a similar meal of this patient dipped early and rose late); NO: no split, or the caregiver\'s own later plan.' },
      option: { type: ['string', 'null'], enum: ['A', 'B', 'C', null], description: 'The option of your answer this card belongs to (answer_options key); null when the answer offers no options (the caregiver\'s own plan).' },
      reason: { type: 'string', description: 'One short Polish sentence for the card: what it is for and, when it follows the caregiver\'s own plan or differs from carbs / ICR, why.' },
      later: {
        type: ['array', 'null'],
        maxItems: 3,
        description: 'MEAL only: what comes after this card, as the caregiver planned it, in order (up to 3 parts, e.g. half the dose in 10 min and the rest of the carbs in 60 min); a reminder goes to every caregiver for each part and its dose is computed then. null: nothing later.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            trigger: { type: 'string', enum: ['AFTER_MINUTES', 'GLUCOSE_STOPPED_FALLING', 'GLUCOSE_RISING', 'GLUCOSE_ABOVE'], description: 'When the reminder comes: after_minutes after the meal, or when glucose has stopped falling, starts rising or goes above threshold_mgdl.' },
            after_minutes: { type: ['integer', 'null'], description: `AFTER_MINUTES: minutes after the meal start (0-${LATER_PLAN_POLICY.max_after_minutes}). Glucose triggers: checked from then on (null: GLUCOSE_RISING at once, the others ${LATER_PLAN_POLICY.default_glucose_check_after_minutes}).` },
            threshold_mgdl: { type: ['integer', 'null'], description: 'GLUCOSE_ABOVE only, mg/dL.' },
            carbs_g: { type: 'integer', description: 'Carbs sent with the later part (a split meal\'s rest); 0: only insulin later for carbs already sent.' },
            dose_carbs_g: { type: ['integer', 'null'], description: 'The carbs the later dose is for when not the later carbs (carbs_g > 0) or this card\'s carbs (carbs_g 0); null otherwise.' },
            insulin_u: { type: ['number', 'null'], description: 'A later dose the caregiver named; null: computed when due.' },
            subtract_drop_cover: { type: 'boolean', description: 'Take off the grams that covered a drop (advice reduce_for_drop.covered_carbs_g) when the caregiver asks to subtract what covered the low.' },
            wait_minutes: { type: ['integer', 'null'], description: `Glucose triggers: how long to wait for the condition before reminding anyway (null: ${LATER_PLAN_POLICY.default_wait_minutes}). GLUCOSE_RISING: how long it is watched; never rising, it lapses without a push (null: ${LATER_PLAN_POLICY.default_rising_wait_minutes}).` },
          },
          required: ['trigger', 'after_minutes', 'threshold_mgdl', 'carbs_g', 'dose_carbs_g', 'insulin_u', 'subtract_drop_cover', 'wait_minutes'],
        },
      },
    },
    required: ['purpose', 'carbs_g', 'insulin_u', 'reduce_for_drop', 'add_correction', 'eating_now', 'meal_description', 'items', 'use_advised_split', 'option', 'reason', 'later'],
  },
};

/**
 * When to split a meal bolus (split-bolus.v1, research summary 2026-10-20 in the split-bolus plan): what
 * the chat recommends; the caregiver's own split is taken as it is.
 */
const SPLIT_BOLUS_INSTRUCTIONS = [
  'SPLIT BOLUS (split-advice.v1): a meal with much fat or protein for its carbs absorbs slowly; the whole dose up front risks a low in the first 1–2 h and leaves a late rise. The server decides it from the proportion, not from grams, so a child\'s small fatty portion counts: WBT per carb exchange = ((4·protein + 9·fat) / 100) / (carbs / 10), fat share = 9·fat / (4·carbs + 4·protein + 9·fat). From 0,5 WBT/WW or 35% fat: 70% now, the rest of the carbs with their dose after ~60 min; from 0,8 or 40%: 60% now, the rest after ~90 min. Never less than 60% now.',
  'For a meal of known items, compute the proportion yourself to decide; when a split is advised, prepare ONE card: propose_bolus with carbs_g = the whole meal, its items, use_advised_split ADVISED (the server makes the parts and doses exactly). If a similar meal of this patient dropped below 70 in the first 2 h and rose late afterwards, use STRONGER (one level more later; it also splits a meal just below the threshold) and say so in the why sentence. The whole dose now is not a second card: the caregiver switches to it on the card. If propose_bolus answers that no split is advised, prepare the card without a split. Only the carb dose is split: insulin for fat or protein is the separate WBT reminder later.',
].join('\n');

export const BOLUS_PROPOSAL_INSTRUCTIONS = [
  'BOLUS CARDS: in this reply you can prepare cards the caregiver gives from the app: carbs and insulin to the loop (Trio or Loop), each sent only after the caregiver checks it and confirms it with Face ID. You advise; the caregiver decides.',
  'Whenever your answer suggests carbs to enter or a dose to give now, call propose_bolus with exactly those numbers: the card is the only way to give them from the app. For a meal described in words or shown in a photo, compute the carbohydrates first (search_food) and pass the items.',
  'THE CAREGIVER\'S OWN PLAN COMES FIRST. When the caregiver says what to do ("wpisz połowę węgli", "daj 2 j", "bez bolusa teraz", "przypomnij o bolusie, jak zacznie rosnąć"), prepare exactly that card and later part. Do not argue, do not swap in your own plan and do not repeat your recommendation. When the result has a warning marked [!!], say it once, in one plain sentence starting with "⚠️", and still prepare the card; the other warnings are on the card: do not repeat them.',
  'What the caregiver reports is a fact, not a request for advice: "właśnie je", "już je", "zaczął jeść" means the meal is happening now (eating_now true). Plan from there; never tell them to stop eating or to wait with the meal.',
  'WHEN THE CAREGIVER ASKS WHAT TO DO and gives no plan of their own: prepare ONE card, the best plan for now, with option null and answer_options empty. The card is the decision: never two cards to choose from. The best plan, by the advice in the results: with fast_carbs_first, fast carbs now (the rescue card, when that tool is available; with carbs_g null it takes the advised grams) and the meal\'s carbs with insulin_u 0 and later {trigger GLUCOSE_STOPPED_FALLING, carbs_g 0}; when SPLIT BOLUS advises a split, the advised split; else the dose by ICR (insulin_u null, which the server lowers for a falling glucose). If the card comes back with risk level LOW or VERY_LOW and basis WITH_DOSE or DOSE_TOTAL, change the plan (the dose later or a stronger split) and prepare the card again: the new card replaces it. situation in a result is what the loop expects without the card, not a risk of the card: never a ⚠️ sentence; mention it only in the why sentence when it explains the plan. The caregiver changes the plan on the card or in the chat, so never list alternatives in the text.',
  'OPTIONS ONLY WHEN ASKED: answer_options only when the caregiver asks for possibilities ("jakie mam opcje", "co mogę zrobić", "a inaczej?", "podaj warianty"). Then offer 2–3 really different plans, each with no forecast below 70 (no option is required to be the dose for all carbs), and prepare the cards of EVERY option in ONE turn, each card with option set to its key (A, B, C); the best option is A. The app shows the options as a picker with A chosen, the cards of the chosen option under it, and a "Własny plan" row, so never offer "own plan" as an option. Two variants of the same idea are one option, and so are two options whose cards came out the same (during a low insulin_u null gives 0 U now): offer only the different ones, and one card without options when only one is left. Every card of an answer with options has its option. Never an option with insulin for a high the caregiver did not ask for. answer_options: the recommended option is ALWAYS key A, listed first (recommended true, the others false), title = the plan in a few words (at most 40 characters, e.g. "Najpierw 3 g, bolus później"), detail = an empty string. note = the one thing worth knowing about this option that its cards do not show, at most 100 characters; empty when there is nothing to add. Never put a forecast number in title, detail or note. An option with nothing to send now (wait and check) has no cards. THE TEXT never lists or describes the options and never repeats the cards\' numbers; it says in 1–2 short sentences why A is the best now and ends with "Wybierz opcję poniżej albo napisz własny plan." With answer_options, follow_up_candidates is an empty array. These text rules win over any other rule asking to write the dose or a **Propozycja:** line in the text.',
  'Without answer_options the cards have option null.',
  'propose_bolus returns advice from the data: fast_carbs_first (a low now or soon), reduce_for_drop (the meal dose lowered because part of the meal covers a drop), correction (the dose a correction would be), the risk of the card as prepared and situation (the loop\'s own forecast without the card, when it shows a low the card\'s carbs ease). Use it to choose the plan; never compute doses yourself. With reduce_for_drop, the meal card with reduce_for_drop true.',
  'HIGH GLUCOSE: the loop corrects a high itself (Trio: SMB and temp basal; Loop: automatic boluses or temp basal). Add insulin for a high only when the caregiver asks for a correction: for a meal set add_correction true; for a correction alone use purpose CORRECTION with insulin_u null (the server computes it) or the caregiver\'s own number. When you prepare a meal card at glucose above target and the caregiver did not ask for a correction, add exactly one sentence naming the patient\'s loop (Trio: "Trio koryguje wysoki poziom samo; jeśli chcesz dodać korektę do karty, napisz."; Loop: "Loop koryguje wysoki poziom sam; jeśli chcesz dodać korektę do karty, napisz.").',
  'EARLIER CARDS: an earlier answer\'s cards are listed under its text as [Karty pod tą odpowiedzią] (option, amounts now and later, WBT, state). Use these numbers and the meal named there: never ask the caregiver for numbers a card already shows. A change that names no option is about the option that was sent, else the recommended one. A card marked nieaktualna is recomputed: prepare the new card on the current data with the same meal (pass its items again).',
  'AN UNCERTAIN PORTION (size, dough, brand unknown): prepare the cards from one stated assumption (one short sentence, e.g. "liczę średnią pizzę na cienkim cieście, ok. 65 g") and ask at most one question, only when its answer would change the dose by more than about 20%. Never say you cannot estimate while you prepare cards.',
  'NOT SURE THE MEAL WILL BE EATEN ("nie wiem, czy zje", "podziel na pół", "pół na pół"): split the meal and its insulin together: this card = the part eaten first (half of the carbs unless they say otherwise) WITH its dose by ICR now (insulin_u null), and one later part = the rest of the carbs (later.carbs_g, AFTER_MINUTES about 20-30 min, i.e. when it is eaten) with its dose computed then; the caregiver skips that part if the rest is not eaten. Never carbs now without their insulin for this: insulin now is 0 only when the caregiver asks to give the bolus later, or a low is now or close by the card\'s data (then say why in one sentence; the caregiver can still ask for the half-now plan).',
  'CHANGING AN EARLIER PLAN: when the caregiver changes part of a card you prepared (half now, later, less), keep every part they did not change: the new card with its later parts must still cover the whole meal (e.g. 70/30 then "half of the first part now": now half the dose with the first part\'s carbs, the other half later, and the 30% part still later). Say what happens with each part. Only grams the caregiver says to drop are dropped, and you say which.',
  'WBT (fat and protein): the app\'s rule is 1 WBT = 100 kcal from protein and fat; the standard dose = WBT × 10 / ICR × 30%; the WBT reminder comes automatically about 2.5 h after the meal when WBT ≥ 1.5, fat ≥ 18 g or protein ≥ 20 g, and its screen proposes the dose then. A meal card\'s result has wbt with these numbers; for a WBT question without a card call estimate_wbt with the meal\'s protein and fat. Quote the numbers; never say the app has no WBT rule or that the profile is missing.',
  'LATER PART: `later` plans what comes after the card (a list, up to 3 parts), sent only when a caregiver gives it: the rest of the carbs with their dose (carbs_g > 0, a split), or only the dose for this card\'s carbs (carbs_g 0, a deferred bolus; dose_carbs_g when the dose is for other grams). The reminder comes after a time or on a glucose condition; a glucose condition is waited for wait_minutes (default 180) and then the reminder comes anyway. subtract_drop_cover when the caregiver asks to take off what covered the low. later.insulin_u only when the caregiver named that dose.',
  'SHORT TEXT WITH A CARD (wins over other rules asking for more): the whole answer is at most 3 short sentences in one paragraph: the portion assumption when there is one ("liczę ok. 31 g na cheeseburgera"), why this plan (what it protects against, e.g. the fat that raises glucose later or the drop now), and at most one more sentence (a [!!] warning, or the loop\'s correction sentence for a high). No bold, no glucose or IOB numbers, no list of macros, no "przygotowałam kartę", no advice to watch the CGM. A later part is named only by its time or condition; the card\'s grams and units are not repeated: the card shows them big.',
  'After PROPOSED without answer_options: Never write that insulin was given or sent, and never write "Wybierz opcję". After NEEDS_DOSE, ask for the dose in one sentence. After NO_DOSE_NEEDED, say why (the breakdown) and that the caregiver can still name a dose.',
  'A question how much to give for a food, with no time in the past, is about a portion eaten now. A meal of the same food logged earlier is a previous portion, not this one: compute the dose for the new portion (with the insulin still active from the earlier one). Only when that meal started within the last 30 minutes, ask in one sentence whether this is the same portion before preparing a card.',
  'Do not prepare a card for doses in the past, for questions about what would have happened, or when the caregiver only asks about settings.',
  SPLIT_BOLUS_INSTRUCTIONS,
].join('\n');

/**
 * Added when search_knowledge is available. Since split-advice.v1 the server decides splits and the
 * advice: sources explain, they no longer decide (a search before every fatty-meal card cost a round of 4-6 s).
 */
export const BOLUS_SOURCES_INSTRUCTION = 'Sources are not needed to decide a card: the server computes the split (SPLIT BOLUS) and the advice, and you never search to second-guess them. Call search_knowledge once only when the caregiver asks why, or when the situation is outside the card rules (exercise around the meal, illness, a meal with almost no carbs but much protein or fat, a late meal over the night), and cite what you used ([S#]). A plain meal, a fatty meal with the advised split or the caregiver\'s own plan needs no search.';

/** What the card says about the plan without changing it (bolus_proposals.card_advice, card-advice.v1). */
/**
 * rest-later.v1 (owner 2026-11-10): a meal card that gives less than carbs / ICR now (or 0 j) offers a reminder for the
 * rest, its time chosen by hand, and "Gdy przestanie spadać" while glucose falls. The rest is the card's later part:
 * its dose is worked out again when it is due (calculator, insulin on board). Both cards, chat and planned meal.
 */
export interface RestOffer {
  /** Carbs / ICR − the dose now, an estimate (the part computes its own when due). */
  rest_u: number;
  /** The grams the rest is for (dose_carbs_g of the part). */
  rest_carbs_g: number;
  /** Glucose falls (or carbs come first): "Gdy przestanie spadać" is offered and preselected. */
  falling: boolean;
  /** What the card has now: null = no reminder. */
  current: { trigger: 'AFTER_MINUTES' | 'GLUCOSE_STOPPED_FALLING'; minutes: number | null } | null;
}

export type RestChoice = { trigger: 'AFTER_MINUTES'; minutes: number } | { trigger: 'GLUCOSE_STOPPED_FALLING' } | null;

export const REST_LATER_POLICY = { min_minutes: 5, max_minutes: 240, stopped_falling_wait_minutes: 180 } as const;

/** The POST body's `rest` (absent or null: no reminder); anything malformed is refused. */
export function parseRestChoice(raw: unknown): RestChoice | { problem: string } {
  if (raw === undefined || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.trigger === 'GLUCOSE_STOPPED_FALLING') return { trigger: 'GLUCOSE_STOPPED_FALLING' };
  if (value.trigger === 'AFTER_MINUTES' && typeof value.minutes === 'number' && Number.isInteger(value.minutes)
    && value.minutes >= REST_LATER_POLICY.min_minutes && value.minutes <= REST_LATER_POLICY.max_minutes) {
    return { trigger: 'AFTER_MINUTES', minutes: value.minutes };
  }
  return { problem: `rest must be null, { trigger: 'GLUCOSE_STOPPED_FALLING' } or { trigger: 'AFTER_MINUTES', minutes: ${REST_LATER_POLICY.min_minutes}-${REST_LATER_POLICY.max_minutes} }` };
}

/** later-time.v1: the times a later dose may be moved to (minutes after the meal). */
/** Up to 2 h: later the fat and protein reminder (WBT, 2,5 h) takes over (owner 2026-11-10). */
export const LATER_TIME_POLICY = { min_minutes: 15, max_minutes: 120 } as const;

export function laterTimeMinutes(raw: unknown): number | null {
  const minutes = typeof raw === 'number' ? raw : NaN;
  return Number.isInteger(minutes) && minutes >= LATER_TIME_POLICY.min_minutes && minutes <= LATER_TIME_POLICY.max_minutes ? minutes : null;
}

/**
 * later-time.v1 (owner 2026-11-10: "skąd to 90 min? chciałbym móc to zmienić"): the card's arguments with its first
 * later dose at `minutes` after the meal. An advised split keeps its parts and moves the later one; the caregiver's own
 * later part (or a rest's reminder) gets that time. Null: the card has no later dose to move.
 */
export function laterTimeArgs(proposal: Pick<BolusProposalRecord, 'card_advice'>, minutes: number): Record<string, unknown> | null {
  const base = readCardAdvice(proposal.card_advice)?.card_args;
  if (!base) return null;
  if (base.use_advised_split === 'ADVISED' || base.use_advised_split === 'STRONGER') return { ...base, split_after_minutes: minutes };
  const later = Array.isArray(base.later) ? base.later as Array<Record<string, unknown>> : [];
  if (later.length === 0) return null;
  return { ...base, later: later.map((part, index) => (index === 0 ? { ...part, trigger: 'AFTER_MINUTES', after_minutes: minutes, threshold_mgdl: null, wait_minutes: null } : part)) };
}

/** The card's arguments with the rest as its one later part (or none): the dose now stays as it is. */
export function restLaterArgs(proposal: Pick<BolusProposalRecord, 'insulin_u' | 'card_advice'>, rest: RestChoice): Record<string, unknown> | null {
  const advice = readCardAdvice(proposal.card_advice);
  const offer = advice?.rest_offer;
  const base = advice?.card_args;
  if (!offer || !base) return null;
  const later = rest === null ? null : [{
    trigger: rest.trigger,
    after_minutes: rest.trigger === 'AFTER_MINUTES' ? rest.minutes : null,
    threshold_mgdl: null,
    carbs_g: 0,
    // The whole card's carbs, less the insulin the card actually gave (scenario M18: a dose raised by hand on the card
    // leaves a smaller rest, never the rest of the lower dose the card first showed).
    dose_carbs_g: null,
    insulin_u: null,
    subtract_drop_cover: false,
    wait_minutes: rest.trigger === 'GLUCOSE_STOPPED_FALLING' ? REST_LATER_POLICY.stopped_falling_wait_minutes : null,
  }];
  return { ...base, insulin_u: proposal.insulin_u, later, standard_plan: false, use_advised_split: 'NO' };
}

export interface CardAdvice {
  policy_version: string;
  /** rest-later.v1: the rest's reminder this card offers; absent: none (a full dose, a split meal, older cards). */
  rest_offer?: RestOffer | null;
  risk: PlanRisk | null;
  /** The loop's own low without the card when the card brings carbs (card-advice.v2): a line, not a warning; absent on older cards. */
  situation?: PlanSituation | null;
  /** The correction for the high: on the card (applied) or only offered. */
  correction: { dose_u: number; breakdown: string; applied: boolean } | null;
  fast_carbs_first: { carbs_g: number | null; level: FastCarbsFirst['level']; message: string; glucose_mgdl?: number; minutes_to_low?: number | null } | null;
  /** The dose lowered for a drop: on the card (applied) or only offered. */
  reduce_for_drop: { dose_u: number; covered_carbs_g: number; summary: string; applied: boolean } | null;
  /** The glucose with the card's whole plan, behind the card's chart button (card-forecast.v1; absent on older cards). */
  forecast_chart?: CardForecastChart | null;
  /** The loop-style calculator for the card's carbs (dose-calculator.v1; absent on older cards). */
  dose_calculation?: DoseCalculation | null;
  /** Other plans for the same meal, computed by the same path (card-variants.v1; absent on older cards). */
  variants?: CardVariant[];
  /** The arguments of the server's own plan this card (or the card it was switched from) first had: "Plan polecany"
   * goes back to it (absent: an own plan or an older card). */
  plan_args?: Record<string, unknown>;
  /** The arguments this MEAL card was made from: "Reszta" computes it again from them with its later part (rest-later.v1). */
  card_args?: Record<string, unknown>;
}

/**
 * card-variants.v1 (bolus card A, 2026-11-08): the plans the card offers as buttons under "Podaj", so the caregiver
 * changes the plan without writing in the chat. Each is computed like a card (the same doses, split and risk) but not
 * stored; choosing one computes it again on current data and replaces the card.
 */
/** RECOMMENDED: back to the plan the card first had (only on a card made from a variant). */
export type CardVariantKind = 'RECOMMENDED' | 'MORE_LATER' | 'ALL_NOW' | 'SPLIT' | 'HALF_NOW' | 'FULL_BOLUS_NOW' | 'BOLUS_LATER' | 'ICR_DOSE' | 'CALCULATOR_DOSE';
export const CARD_VARIANT_KINDS: readonly CardVariantKind[] = ['RECOMMENDED', 'MORE_LATER', 'ALL_NOW', 'SPLIT', 'HALF_NOW', 'FULL_BOLUS_NOW', 'BOLUS_LATER', 'ICR_DOSE', 'CALCULATOR_DOSE'];

export interface CardVariant {
  kind: CardVariantKind;
  /** The button: "Więcej później", "Całość teraz", "Podziel", "Połowa bolusa teraz", "Cały bolus teraz", "Bolus później". */
  label: string;
  carbs_now_g: number;
  insulin_now_u: number;
  later: Array<{ trigger: string; after_minutes: number | null; carbs_g: number; insulin_u: number | null }>;
  risk: { min_mgdl: number; level: RiskLevel; basis: PlanRisk['basis'] } | null;
  /** The plan leads to a low or carries a strong warning: the app asks before it replaces the card (ack_text). */
  needs_ack: boolean;
  ack_text: string | null;
  /** The propose_bolus arguments that make it (server only: the app never sends them). */
  args: Record<string, unknown>;
}

// Review 2026-11-10: "dawka" everywhere (the word of the card's big number), the dose on every dose button.
const VARIANT_LABELS: Record<CardVariantKind, string> = {
  RECOMMENDED: 'Plan karty',
  MORE_LATER: 'Więcej później',
  ALL_NOW: 'Bez podziału',
  SPLIT: 'Podziel na dwie',
  HALF_NOW: 'Połowa dawki teraz',
  FULL_BOLUS_NOW: 'Cała dawka teraz',
  BOLUS_LATER: 'Dawka później',
  ICR_DOSE: 'Z przelicznika',
  CALCULATOR_DOSE: 'Z kalkulatora',
};

/**
 * Where a meal card's dose comes from (dose-basis.v1, owner 2026-11-10): ICR = carbs / ICR (the default), CALCULATOR =
 * carbs / ICR lowered by the calculator (insulin on board, trend, forecast). Glucose low or a low near (carbs first)
 * keeps the calculator's 0 j either way; the whole dose stays one button away. Each caregiver chooses it in Settings.
 */
export type DoseBasis = 'ICR' | 'CALCULATOR';
export function isDoseBasis(value: unknown): value is DoseBasis {
  return value === 'ICR' || value === 'CALCULATOR';
}

/** The two dose buttons carry the dose: "Z przelicznika · 1,3 j", "Z kalkulatora · 0,3 j". */
function variantLabel(kind: CardVariantKind, insulinNow: number): string {
  return kind === 'ICR_DOSE' || kind === 'CALCULATOR_DOSE' || kind === 'FULL_BOLUS_NOW' || kind === 'HALF_NOW' || kind === 'ALL_NOW'
    ? `${VARIANT_LABELS[kind]} · ${formatUnits(insulinNow)} j`
    : VARIANT_LABELS[kind];
}

/** "Bolus później": the carbs now, their dose this many minutes later (a meal that may not be eaten whole). */
const BOLUS_LATER_MINUTES = 20;

/** The variants a card offers in its situation (owner 2026-11-08); only for the server's own plan, not a caregiver's. */
function variantSpecs(input: {
  args: Record<string, unknown>;
  splitMode: 'NO' | 'ADVISED' | 'STRONGER';
  ownPlan: boolean;
  deferredForLow: boolean;
  insulin: number;
  icrDose: number | null;
  step: number;
  carbs: number;
  mealCarbs: number | null;
  splitAdvised: boolean;
  /** The calculator lowered the dose below carbs / ICR (insulin on board, a drop, the forecast). */
  lowered?: boolean;
  /** The card follows carbs / ICR while the calculator would give less: it offers the calculator's dose. */
  calculatorLower?: boolean;
}): Array<{ kind: CardVariantKind; args: Record<string, unknown> }> {
  if (input.ownPlan) return [];
  const specs = situationVariantSpecs(input);
  // Owner 2026-11-10: the dose's source is one tap away on every meal card. A card the calculator lowered offers
  // carbs / ICR (the 11:12 card offered 0,3 j for 11 g, of 1,3 j, with no way to give it all), a card by ICR offers
  // the calculator's lower dose. Same carbs and split, only the dose's source changes; a low on the way asks first.
  if (input.lowered && !input.deferredForLow) specs.unshift({ kind: 'ICR_DOSE', args: { ...input.args, dose_basis: 'ICR' } });
  if (input.calculatorLower) specs.unshift({ kind: 'CALCULATOR_DOSE', args: { ...input.args, dose_basis: 'CALCULATOR' } });
  return specs;
}

function situationVariantSpecs(input: Parameters<typeof variantSpecs>[0]): Array<{ kind: CardVariantKind; args: Record<string, unknown> }> {
  const base = { ...input.args, insulin_u: null, later: null, standard_plan: false, use_advised_split: 'NO', option: input.args.option ?? null };
  const whole = input.mealCarbs ?? input.carbs;
  if (input.splitMode === 'ADVISED') {
    return [
      { kind: 'MORE_LATER', args: { ...base, use_advised_split: 'STRONGER', carbs_g: whole } },
      { kind: 'ALL_NOW', args: { ...base, carbs_g: whole } },
    ];
  }
  if (input.splitMode === 'STRONGER') return [{ kind: 'ALL_NOW', args: { ...base, carbs_g: whole } }];
  if (input.deferredForLow && input.icrDose !== null && input.icrDose > 0) {
    const half = roundDownToStep(input.icrDose / 2, input.step);
    const stoppedFalling = { trigger: 'GLUCOSE_STOPPED_FALLING', after_minutes: null, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null };
    return [
      ...(half > 0 ? [{ kind: 'HALF_NOW' as const, args: { ...base, insulin_u: half, later: [stoppedFalling] } }] : []),
      { kind: 'FULL_BOLUS_NOW', args: { ...base, standard_plan: true } },
    ];
  }
  if (input.insulin > 0) {
    const later = { trigger: 'AFTER_MINUTES', after_minutes: BOLUS_LATER_MINUTES, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null };
    return [
      ...(input.splitAdvised && input.mealCarbs !== null && Math.abs(input.mealCarbs - input.carbs) <= 2 ? [{ kind: 'SPLIT' as const, args: { ...base, use_advised_split: 'ADVISED', carbs_g: input.mealCarbs } }] : []),
      { kind: 'BOLUS_LATER', args: { ...base, insulin_u: 0, later: [later] } },
    ];
  }
  return [];
}

type PlanShape = Pick<CardVariant, 'carbs_now_g' | 'insulin_now_u' | 'later'>;

/** A plan's later parts as a variant shows them. */
function laterShape(split: SplitPlan | null): CardVariant['later'] {
  return planParts(split).map((part) => ({ trigger: planTrigger(part), after_minutes: part.later_after_minutes ?? null, carbs_g: part.later_carbs_g, insulin_u: part.fixed_insulin_u ?? part.later_insulin_u ?? null }));
}

/** Two plans give the same now and the same later parts (amounts, trigger and time). */
function samePlan(left: PlanShape, right: PlanShape): boolean {
  return left.carbs_now_g === right.carbs_now_g
    && left.insulin_now_u === right.insulin_now_u
    && left.later.length === right.later.length
    && left.later.every((part, index) => {
      const other = right.later[index];
      return part.trigger === other.trigger && part.after_minutes === other.after_minutes && part.carbs_g === other.carbs_g && part.insulin_u === other.insulin_u;
    });
}

export function readCardAdvice(raw: unknown): CardAdvice | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return typeof value.policy_version === 'string' ? (value as unknown as CardAdvice) : null;
}

export interface BolusProposalRecord {
  id: string;
  patient_id: string;
  /** Null for a planned meal's card (meal_plan_entry_id), which has no conversation. */
  conversation_id: string | null;
  user_message_id: string | null;
  /** The planned meal's page card (migration 112); null for the chat's cards. */
  meal_plan_entry_id?: string | null;
  purpose: BolusProposalPurpose;
  carbs_g: number;
  insulin_u: number;
  icr_g_per_u: number | null;
  icr_insulin_u: number | null;
  meal_payload: RemoteCommandMealPayload | null;
  reason: string | null;
  warnings: RemoteCommandEvaluation['warnings'];
  /** The later part: carbs_g / insulin_u are the part given now. */
  split: SplitPlan | null;
  /** The dose lowered for a falling glucose (part of the carbs covers the drop), when the plan uses it; null otherwise. */
  dose_adjustment: MealDoseAdjustment | null;
  card_advice: CardAdvice | null;
  /** The answer's option the card belongs to (answer-options.v1); null without options. */
  option_key: AnswerOptionKey | null;
  status: 'PROPOSED' | 'DISCARDED';
  expires_at: string;
  created_at: string;
}

export type NewBolusProposal = Omit<BolusProposalRecord, 'id' | 'status' | 'created_at'>;

export interface BolusProposalStore {
  insert(proposal: NewBolusProposal): Promise<BolusProposalRecord>;
  /** Takes back a card of this answer that a newer one for the same option and purpose replaces (absent: both stay). */
  discard?(patientId: string, proposalId: string): Promise<void>;
}

/** The port the AI gateway calls; one session per answer. */
export interface BolusProposalTools {
  /** The caregiver asks how much to give (the answer then uses the main model). */
  readonly dose_requested: boolean;
  propose(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** estimate_wbt: the app's WBT rule with the ICR valid now (absent: the tool is not offered). */
  estimateWbt?(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** dose-one-turn.v1: what the cards' advice will say about a low, before any card is prepared. */
  situationNow?(): Promise<Record<string, unknown>>;
}

export const ESTIMATE_WBT_TOOL_NAME = 'estimate_wbt';

export const ESTIMATE_WBT_TOOL_DEFINITION: AiRuntimeToolDefinition = {
  name: ESTIMATE_WBT_TOOL_NAME,
  description: 'The app\'s WBT (fat-protein units) rule for a meal: WBT from its protein and fat, the standard insulin dose with the ICR valid now (WBT × 10 / ICR × 30%), and whether and when the WBT reminder comes. Use it for every WBT question; never compute WBT doses yourself.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      protein_g: { type: 'number', description: 'Protein of the meal (or the part eaten), grams.' },
      fat_g: { type: 'number', description: 'Fat of the meal (or the part eaten), grams.' },
    },
    required: ['protein_g', 'fat_g'],
  },
};

/** "ile podać", "jaką dawkę", "policz bolus", "ile insuliny/jednostek" … */
const DOSE_REQUEST = /(?:^|[^\p{L}])(?:ile|jak[aąi]e?|jakiej)(?=[^\p{L}])[^.?!]{0,40}(?:poda|dawk|bolus|insulin|jednost)|(?:^|[^\p{L}])(?:policz|przygotuj|zaproponuj|podaj)(?=[^\p{L}])[^.?!]{0,30}(?:bolus|dawk|insulin)/iu;

export function isDoseRequest(text: string): boolean {
  return DOSE_REQUEST.test(text);
}

export type BolusProposalContext = Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'> & {
  /** The readings, Trio's forecast and the profile's ISF, target and DIA the advice and the risk are computed from. */
  meal_forecast?: MealForecastData | null;
  /** A high despite insulin (high-glucose-safety.v1). */
  high_safety?: HighGlucoseSafetyInputs | null;
  /** The patient's time zone (night). */
  timezone?: string | null;
  /** A remote bolus sent in the last 30 min (it may not be in Nightscout yet); absent: not checked. */
  recent_remote_bolus?: RemoteCommandContext['recent_remote_bolus'];
};

export interface PreviousCard {
  id: string;
  purpose: BolusProposalPurpose;
  carbs_g: number;
  split: SplitPlan | null;
  meal_payload: RemoteCommandMealPayload | null;
  created_at: string;
  /** A command went out from it. */
  sent: boolean;
  /** When it went and what it gave (null: not sent or unknown). */
  sent_at?: string | null;
  sent_carbs_g?: number | null;
  sent_insulin_u?: number | null;
}

/** A meal's description to compare: case and the apostrophe's form do not matter. */
function mealName(description: unknown): string {
  return typeof description === 'string' ? description.trim().toLowerCase().replace(/[\u2018\u2019]/g, "'") : '';
}

/** WBT of a meal card's items (wbt-policy.v1): units, the standard dose, and whether the reminder comes. */
function wbtAdvice(totals: { protein_g: number; fat_g: number } | null, icr: number | null): Record<string, unknown> | null {
  if (!totals) return null;
  const units = fatProteinUnitsOf(totals.protein_g, totals.fat_g);
  if (units === null || units <= 0) return null;
  const reminder = shouldRemindAboutWbt({ protein_g: totals.protein_g, fat_g: totals.fat_g });
  return {
    units,
    protein_g: totals.protein_g,
    fat_g: totals.fat_g,
    standard_dose_u: icr ? standardWbtDose(units, icr).dose_units : null,
    reminder: reminder ? `automatic, about ${WBT_REMINDER_DELAY_MINUTES / 60} h after the meal (the WBT screen proposes the dose then)` : 'none (below the thresholds)',
    note: 'The app\'s WBT rule: 1 WBT = 100 kcal from protein and fat; standard dose = WBT × 10 / ICR × 30%. standard_dose_u uses the ICR valid now; the WBT screen computes it again with the ICR at the time of the WBT dose, so say "przy obecnym ICR". Quote these numbers when the caregiver asks about WBT.',
  };
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export interface BolusProposalSessionDeps {
  patientId: string;
  /** Null for a planned meal's card (mealPlanEntryId), made without a conversation or the model. */
  conversationId: string | null;
  userMessageId: string | null;
  mealPlanEntryId?: string | null;
  /** The asking caregiver's choice in Settings (dose-basis.v1); absent: the calculator, as before. */
  doseBasis?: DoseBasis;
  store: BolusProposalStore;
  context: (now: Date) => Promise<BolusProposalContext>;
  /** The conversation's earlier cards (a new card for the same meal must not lose part of an unsent one). */
  previousCards?: () => Promise<PreviousCard[]>;
  /** The asking phone's own send limits (it refuses a card above them); absent: not known (older apps). */
  phoneLimits?: { max_bolus_u: number; max_carbs_g: number } | null;
  doseRequested: boolean;
  now?: () => Date;
  /** The card is made from a variant: it offers "Plan polecany" with these arguments (the first card's plan). */
  backTo?: { args: Record<string, unknown> } | null;
}

/** One answer's propose_bolus calls. */
export class BolusProposalSession implements BolusProposalTools {
  readonly proposed: BolusProposalRecord[] = [];
  readonly dose_requested: boolean;
  used = false;
  /** A propose call threw (no card could be prepared): a dose in the text then gets the no-card note. */
  failed = false;
  private readonly now: () => Date;
  private previousCards?: Promise<PreviousCard[]>;

  constructor(private readonly deps: BolusProposalSessionDeps) {
    this.now = deps.now ?? (() => new Date());
    this.dose_requested = deps.doseRequested;
  }

  /**
   * The fast carbs the data advise now (fast_carbs_first, the same advice a meal card returns); null when no low is
   * near or the data are missing. A rescue card prepared in the same turn as the meal card takes its grams from here.
   */
  async fastCarbsAdvice(): Promise<FastCarbsFirst | null> {
    const now = this.now();
    const context = await this.deps.context(now);
    return computeFastCarbsFirst({ now, icr_g_per_u: context.icr_g_per_u, data: context.meal_forecast ?? null });
  }

  /** dose-one-turn.v1: what the cards' advice will say about a low, before any card is prepared. */
  async situationNow(): Promise<Record<string, unknown>> {
    const now = this.now();
    const context = await this.deps.context(now);
    const fastCarbs = computeFastCarbsFirst({ now, icr_g_per_u: context.icr_g_per_u, data: context.meal_forecast ?? null });
    return {
      glucose_mgdl: context.glucose?.value ?? null,
      delta_per_5_min: context.glucose?.delta ?? null,
      iob_u: context.loop?.iob_units ?? null,
      icr_g_per_u: context.icr_g_per_u,
      fast_carbs_first: fastCarbs ? { carbs_g: fastCarbs.carbs_g, level: fastCarbs.level, message: fastCarbs.message } : null,
    };
  }

  async propose(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.used = true;
    try {
      return await this.prepare(args, { dry: false });
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  /** The card's data, loaded once for a card and its variants (a few seconds apart at most). */
  private contextCache: { at: number; value: Promise<BolusProposalContext> } | null = null;

  private loadContext(now: Date): Promise<BolusProposalContext> {
    if (this.contextCache && Math.abs(now.getTime() - this.contextCache.at) < 10_000) return this.contextCache.value;
    const value = this.deps.context(now);
    this.contextCache = { at: now.getTime(), value };
    value.catch(() => { if (this.contextCache?.value === value) this.contextCache = null; });
    return value;
  }

  /**
   * dry: computed like a card but not stored (a variant), and without variants of its own. The result's `plan` has
   * what the variant button needs.
   */
  private async prepare(args: Record<string, unknown>, mode: { dry: boolean }): Promise<Record<string, unknown>> {
    const purpose = args.purpose;
    if (purpose !== 'MEAL' && purpose !== 'CORRECTION' && purpose !== 'PRE_BOLUS') return invalid('purpose must be MEAL, CORRECTION or PRE_BOLUS');
    let carbs = args.carbs_g === null || args.carbs_g === undefined ? 0 : Number(args.carbs_g);
    if (!Number.isInteger(carbs) || carbs < 0 || carbs > REMOTE_COMMAND_POLICY.max_carbs_g) return invalid('carbs_g must be whole grams, 0-300');
    const requestedInsulin = args.insulin_u === null || args.insulin_u === undefined ? null : Number(args.insulin_u);
    if (requestedInsulin !== null && (!Number.isFinite(requestedInsulin) || requestedInsulin < 0 || requestedInsulin > REMOTE_COMMAND_POLICY.max_insulin_u)) return invalid('insulin_u must be 0-30 units or null');
    if (purpose === 'MEAL' && carbs === 0) return invalid('a MEAL card needs carbs_g (insulin alone: PRE_BOLUS or CORRECTION)');
    if (purpose === 'PRE_BOLUS' && (requestedInsulin === null || requestedInsulin === 0)) return invalid('PRE_BOLUS needs insulin_u');
    if (purpose === 'PRE_BOLUS' && carbs > 0) return invalid('PRE_BOLUS is insulin before a meal whose carbs come later: carbs_g 0 (carbs now: a MEAL card)');
    // Correction carbs go without insulin, insulin for a high without carbs: both at once skips the meal checks.
    if (purpose === 'CORRECTION' && carbs > 0 && requestedInsulin !== null && requestedInsulin > 0) return invalid('CORRECTION is insulin without carbs, or correction carbs without insulin (carbs with a dose: a MEAL card)');
    const reduceForDrop = args.reduce_for_drop === true;
    // The card's arguments carry the basis, so a variant and "Plan polecany" keep it (dose-basis.v1).
    const doseBasis: DoseBasis = isDoseBasis(args.dose_basis) ? args.dose_basis : this.deps.doseBasis ?? 'CALCULATOR';
    if (purpose === 'MEAL') args = { ...args, dose_basis: doseBasis };
    let calculatorLower = false;
    const addCorrection = args.add_correction === true;
    const eatingNow = args.eating_now === true;

    let items: MealItem[] | null = null;
    if (Array.isArray(args.items) && args.items.length > 0) {
      const sanitized = sanitizeMealItems(args.items);
      if ('problem' in sanitized) return invalid(`items: ${sanitized.problem}`);
      items = sanitized.items;
    }
    const rawLater = args.later === null || args.later === undefined ? [] : Array.isArray(args.later) ? args.later : [args.later];
    if (rawLater.length > MAX_LATER_PARTS) return invalid(`later has at most ${MAX_LATER_PARTS} parts`);
    const laterRequests: LaterRequest[] = [];
    for (const raw of rawLater) {
      const parsed = parseLaterRequest(raw);
      if (parsed && 'problem' in parsed) return invalid(parsed.problem);
      if (parsed) laterRequests.push(parsed);
    }
    if (laterRequests.length > 0 && purpose !== 'MEAL') return invalid('only a MEAL card has later parts: call again with later null (use a reminder for anything else)');
    // A new card for the same meal without its items (the caregiver changed only the split or the dose) keeps the
    // earlier card's items: without them the card loses its WBT reminder and the fatty meal's slower forecast.
    let itemsFromEarlierCard = false;
    // The carbs this plan gives (now and later parts): the items may describe more ("pół teraz" with the whole meal).
    const plannedCarbs = carbs + laterRequests.reduce((sum, part) => sum + part.carbs_g, 0);
    if (purpose === 'MEAL' && !items) {
      const earlier = await this.earlierMealCard(this.now(), args.meal_description);
      const earlierItems = earlier?.meal_payload?.items ?? null;
      // Only the same amount: for a different amount the earlier protein and fat would be wrong.
      if (earlierItems && earlierItems.length > 0 && Math.abs(sumMealItems(earlierItems).carbs_g - plannedCarbs) <= 2) {
        items = earlierItems;
        itemsFromEarlierCard = true;
      }
    }

    // split-advice.v1: the server's split from the meal's fat and protein relative to its carbs; with use_advised_split
    // the card is exactly that split (the model never picks the percentages).
    const splitMode = args.use_advised_split === 'ADVISED' || args.use_advised_split === 'STRONGER' ? args.use_advised_split : 'NO';
    const mealTotals = items ? sumMealItems(items) : null;
    // Protein and fat of the part of the items this plan gives: items for more carbs than planned are scaled down, so
    // half the meal's carbs is never read with the whole meal's fat (split advice and the fatty-meal forecast read the
    // proportions). WBT stays the items' whole: a meal given in two cards must not lose its WBT reminder.
    const plannedShare = mealTotals && mealTotals.carbs_g > plannedCarbs + 2 && plannedCarbs > 0 ? plannedCarbs / mealTotals.carbs_g : 1;
    const plannedTotals = mealTotals ? { carbs_g: Math.min(mealTotals.carbs_g, plannedCarbs), protein_g: round1(mealTotals.protein_g * plannedShare), fat_g: round1(mealTotals.fat_g * plannedShare) } : null;
    const macrosForAdvice = purpose === 'MEAL' && plannedTotals && carbs > 0 ? { carbs_g: plannedCarbs, protein_g: plannedTotals.protein_g, fat_g: plannedTotals.fat_g } : null;
    const fatProteinShare = macrosForAdvice ? mealFatProteinShare(macrosForAdvice) : null;
    const splitAdvice = macrosForAdvice ? computeSplitAdvice(macrosForAdvice, splitMode === 'STRONGER') : null;
    if (splitMode !== 'NO') {
      if (!macrosForAdvice || !mealTotals) return invalid('use_advised_split needs a MEAL card with its items (protein and fat), carbs_g the whole meal');
      // The split is of the whole meal: carbs_g only the "now" part would leave the rest unplanned.
      if (Math.abs(mealTotals.carbs_g - carbs) > 2) return invalid(`use_advised_split splits the whole meal: carbs_g must be the items' ${mealTotals.carbs_g} g (it is ${carbs} g)`);
      if (!splitAdvice) return invalid(`no split is advised for this meal (${fatProteinShare?.wbt_per_ww ?? '?'} WBT per carb exchange, fat ${fatProteinShare?.fat_energy_percent ?? '?'}% of the energy): prepare one card with use_advised_split NO`);
      if (laterRequests.length > 0) return invalid('use_advised_split sets the later part itself: pass later null');
      if (requestedInsulin !== null) return invalid('use_advised_split computes the doses: pass insulin_u null');
      carbs = splitAdvice.now_carbs_g;
      // later-time.v1 (owner 2026-11-10): the caregiver's own time for the advised later part ("Zmień" on the card).
      const afterOverride = laterTimeMinutes(args.split_after_minutes);
      const advised = parseLaterRequest({ trigger: 'AFTER_MINUTES', after_minutes: afterOverride ?? splitAdvice.after_minutes, threshold_mgdl: null, carbs_g: splitAdvice.later_carbs_g, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null });
      if (!advised || 'problem' in advised) return invalid('the advised split could not be planned');
      laterRequests.push(advised);
    }

    const now = this.now();
    const loaded = await this.loadContext(now);
    // A bolus given minutes ago (Nightscout, or a remote one not there yet) is warned about on the card and to the model.
    const context = { ...loaded, in_flight_command_id: null, recent_remote_bolus: loaded.recent_remote_bolus ?? null };
    const data = context.meal_forecast ?? null;
    // The pump's step when Trio reports it; otherwise 0.05 (the phone rounds down to its own step before sending).
    const step = pumpBolusStep(context.pump_bolus_step) ?? CARD_BOLUS_STEP;
    const icrDose = carbs > 0 && context.icr_g_per_u ? roundDownToStep(carbs / context.icr_g_per_u, step) : null;

    // Advice from the data: offered to the model, applied only where the model (the caregiver's plan) asks for it.
    const correction = purpose !== 'PRE_BOLUS' ? computeCorrectionDose({ now, data, step }) : null;
    const correctionOk: CorrectionEstimate | null = correction && !('missing' in correction) ? correction : null;
    const fastCarbs = purpose === 'MEAL' ? computeFastCarbsFirst({ now, icr_g_per_u: context.icr_g_per_u, data }) : null;
    const dropAdjustment = purpose === 'MEAL' && icrDose !== null
      ? computeMealDoseAdjustment({ now, carbs_g: carbs, dose_u: icrDose, icr_g_per_u: context.icr_g_per_u, step, data })
      : null;
    const highSafety = context.high_safety ? detectHighDespiteInsulin({ now, ...context.high_safety }) : null;
    // dose-calculator.v1 (owner 2026-10-29): the loop-style calculator, lowering only, is the MEAL dose without any
    // flag; for a dose passed in insulin_u (MEAL, CORRECTION) it is the formula the dose is held against.
    // A calculator that throws is logged and said on the card (review M4); the card keeps carbs / ICR.
    const calculated = purpose !== 'PRE_BOLUS' || carbs > 0 ? safeDoseCalculation({ iob_floor: true, now, carbs_g: carbs, icr_g_per_u: context.icr_g_per_u, step, data }, { where: 'bolus-proposal-tool', patient_id: this.deps.patientId }) : { calculation: null, failed: false };
    const calculation: DoseCalculation | null = calculated.calculation;

    let insulin: number;
    let appliedAdjustment: MealDoseAdjustment | null = null;
    let correctionApplied = false;
    if (requestedInsulin !== null) {
      insulin = roundDownToStep(requestedInsulin, step);
    } else if (purpose === 'CORRECTION') {
      if (carbs > 0) {
        insulin = 0;
      } else if (!correctionOk) {
        return { tool: PROPOSE_BOLUS_TOOL_NAME, status: 'NEEDS_DOSE', reason: (correction as { missing: string }).missing, note: 'Ask the caregiver for the dose in one sentence, or prepare the card with their insulin_u.' };
      } else if (correctionOk.dose_u <= 0) {
        return { tool: PROPOSE_BOLUS_TOOL_NAME, status: 'NO_DOSE_NEEDED', breakdown: correctionOk.breakdown, note: 'The insulin on board already covers the high by the formula: say the breakdown in one sentence; the caregiver may still name a dose (then call again with insulin_u).' };
      } else {
        insulin = correctionOk.dose_u;
        correctionApplied = true;
      }
    } else {
      // MEAL: carbs / ICR, lowered for a drop or with a correction only when the plan asks for it.
      if (icrDose === null) {
        return { tool: PROPOSE_BOLUS_TOOL_NAME, status: 'NEEDS_DOSE', reason: 'Brak przelicznika węglowodanów (ICR) z profilu w Nightscout.', note: 'Ask the caregiver for the dose in one sentence, or prepare the card with their insulin_u.' };
      }
      // reduce_for_drop is no longer needed for the lowering (it stays in the schema for older prompts).
      void reduceForDrop;
      ({ insulin, calculatorLower, appliedAdjustment, correctionApplied } = mealDoseChoice({
        icr_dose_u: icrDose, calculation, drop_adjustment: dropAdjustment, correction: correctionOk,
        standard_plan: args.standard_plan === true, dose_basis: doseBasis, add_correction: Boolean(addCorrection), step,
      }));
    }

    // Carbs first (glucose below 70 or a low near) took the dose to 0 U: the meal's insulin comes when glucose stops
    // falling (deferred-bolus.v1), computed then, unless the plan already has a later part.
    let deferredForLow = false;
    if (purpose === 'MEAL' && requestedInsulin === null && calculation?.carbs_first && insulin === 0 && carbs > 0 && laterRequests.length === 0) {
      const deferred = parseLaterRequest({ trigger: 'GLUCOSE_STOPPED_FALLING', after_minutes: null, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null });
      if (deferred && !('problem' in deferred)) {
        laterRequests.push(deferred);
        deferredForLow = true;
      }
    }

    // Carbs now without insulin now, and no later part dosing them (only each part's own carbs): their insulin would be
    // nowhere in the plan. The first later part doses them too (carbs now, the bolus later).
    let laterCoversCardCarbs: number | null = null;
    if (purpose === 'MEAL' && carbs > 0 && insulin === 0 && laterRequests.length > 0) {
      const dosesCardCarbs = laterRequests.some((request) => request.insulin_u !== null || request.carbs_g <= 0 || (request.dose_carbs_g !== null && request.dose_carbs_g > request.carbs_g));
      if (!dosesCardCarbs) {
        const [first, ...rest] = laterRequests;
        laterRequests.splice(0, laterRequests.length, { ...first, dose_carbs_g: first.carbs_g + carbs }, ...rest);
        laterCoversCardCarbs = carbs;
      }
    }

    let split: SplitPlan | null = null;
    if (laterRequests.length > 0) {
      const later = computeLaterPlans({ card_carbs_g: carbs, card_insulin_u: insulin, requests: laterRequests, icr_g_per_u: context.icr_g_per_u, drop_cover_g: dropAdjustment?.covered_carbs_g ?? null, step });
      if ('problem' in later) return invalid(later.problem);
      split = later.plan;
    }

    // The chart behind the card's chart button: the dose now, every later part at its (earliest) time, WBT as a marker.
    const wbtTotals = purpose === 'MEAL' ? mealTotals : null;
    const wbtUnits = wbtTotals ? fatProteinUnitsOf(wbtTotals.protein_g, wbtTotals.fat_g) : null;
    const wbtMarker = wbtTotals && wbtUnits && wbtUnits > 0 && shouldRemindAboutWbt({ protein_g: wbtTotals.protein_g, fat_g: wbtTotals.fat_g }) && context.icr_g_per_u
      ? { at_minutes: WBT_REMINDER_DELAY_MINUTES, insulin_u: standardWbtDose(wbtUnits, context.icr_g_per_u).dose_units }
      : null;
    const forecastChart = computeCardForecastChart({
      now,
      data,
      carbs_g: carbs,
      insulin_u: insulin,
      icr_g_per_u: context.icr_g_per_u,
      meal_in_minutes: eatingNow ? 0 : null,
      fatty_meal: macrosForAdvice ? isFattyMeal(macrosForAdvice) : false,
      later: split ? planParts(split).map((part) => ({
        at_minutes: part.later_after_minutes,
        carbs_g: part.later_carbs_g,
        insulin_u: part.fixed_insulin_u ?? part.later_insulin_u,
        trigger: planTrigger(part),
        threshold_mgdl: part.threshold_mgdl ?? null,
        wait_minutes: part.wait_minutes ?? null,
      })) : [],
      wbt: wbtMarker,
    });
    // The card's "prognoza min." is the lowest point of the chart's line with the whole plan (the chart and the number
    // agree); without a chart, the dose now alone.
    const risk = planRiskFromChart(forecastChart) ?? computePlanRisk({ now, data, carbs_g: carbs, insulin_u: insulin, icr_g_per_u: context.icr_g_per_u, meal_in_minutes: eatingNow ? 0 : null, fatty_meal: macrosForAdvice ? isFattyMeal(macrosForAdvice) : false });
    const extraWarnings: CardWarning[] = [];
    // A new card for the same meal must not lose part of an earlier unsent plan (e.g. its later carbs) on the way.
    const shorter = purpose === 'MEAL' ? await this.planShorterThanBefore(now, args.meal_description, carbs, split) : null;
    if (shorter) extraWarnings.push(shorter.warning);
    // A card for a meal another answer's card already gave: sending this one too gives it again.
    const sentBefore = purpose === 'MEAL' ? await this.sentMealCard(now, args.meal_description) : null;
    if (sentBefore) extraWarnings.push(sentBefore.warning);
    const overPhoneLimit = this.phoneLimitWarning(insulin, carbs, split);
    if (overPhoneLimit) extraWarnings.push(overPhoneLimit);
    // dose-calculator.v1 (change 3): a dose passed in insulin_u (the model's or the caregiver's through it) dangerously
    // above the formula is a warning acknowledged when the card is sent (CARD_ONLY_WARNINGS), with the formula.
    const aboveFormula = requestedInsulin !== null ? doseAboveFormulaWarning(insulin, calculation, purpose, carbs) : null;
    if (aboveFormula) extraWarnings.push(aboveFormula);
    if (calculated.failed && insulin > 0) extraWarnings.push(calculatorUnavailableWarning());
    if (highSafety) {
      extraWarnings.push({ code: 'HIGH_DESPITE_INSULIN', key: `HIGH_DESPITE_INSULIN:${highSafety.kind}:${now.toISOString().slice(0, 15)}`, severity: 'DANGER', message: highSafety.message });
    }
    const forecastLow = riskWarning(risk, { carbs_g: carbs, insulin_u: insulin });
    if (forecastLow) extraWarnings.push(forecastLow);
    // Insulin now while a low is on its way: the advice stays on the card (a carbs-only card needs no such line).
    if (fastCarbs && insulin > 0) {
      extraWarnings.push({ code: 'FAST_CARBS_FIRST', key: `FAST_CARBS_FIRST:${fastCarbs.level}:${fastCarbs.glucose_mgdl}:${fastCarbs.carbs_g}`, severity: 'WARNING', message: fastCarbs.message });
    }
    if (correctionApplied || (purpose === 'CORRECTION' && insulin > 0)) {
      extraWarnings.push(...correctionWarnings({ now, data }));
    }
    // rest-later.v1: less than carbs / ICR now (or 0 j), and no later part with food of its own: the rest's reminder.
    const parts = split ? planParts(split) : [];
    const restOnly = parts.length === 0 || (parts.length === 1 && parts[0].later_carbs_g === 0);
    const icrPerU = context.icr_g_per_u;
    const restCarbs = icrPerU ? Math.max(1, Math.round(carbs - insulin * icrPerU)) : 0;
    const restOffer: RestOffer | null = purpose === 'MEAL' && carbs > 0 && icrDose !== null && icrPerU && insulin < icrDose - step / 2 && restOnly
      ? {
        // One number for the rest, the later part's own estimate when there is one (owner 2026-11-10: 2,7 vs 2,6 j).
        rest_u: parts.length === 1 ? (parts[0].fixed_insulin_u ?? parts[0].later_insulin_u) : roundDownToStep(restCarbs / icrPerU, step),
        rest_carbs_g: restCarbs,
        falling: Boolean(calculation?.carbs_first) || (calculation?.breakdown?.trend_mgdl ?? 0) <= -DOSE_CALCULATOR_POLICY.trend_said_mgdl,
        current: parts.length === 1 ? restReminderNow(parts[0]) : null,
      }
      : null;
    // The caregiver's (or the model's) own dose or later parts: their plan, not the server's (no variants).
    const ownPlan = requestedInsulin !== null || (laterRequests.length > 0 && splitMode === 'NO' && !deferredForLow) || args.standard_plan === true;
    const advice: CardAdvice = {
      policy_version: 'card-advice.v2',
      ...(restOffer ? { rest_offer: restOffer } : {}),
      risk,
      situation: planSituation(risk, { carbs_g: carbs, insulin_u: insulin }),
      forecast_chart: forecastChart,
      correction: correctionOk && correctionOk.dose_u > 0 ? { dose_u: correctionOk.dose_u, breakdown: correctionOk.breakdown, applied: correctionApplied } : null,
      fast_carbs_first: fastCarbs ? { carbs_g: fastCarbs.carbs_g, level: fastCarbs.level, message: fastCarbs.message, glucose_mgdl: fastCarbs.glucose_mgdl, minutes_to_low: fastCarbs.minutes_to_low } : null,
      reduce_for_drop: dropAdjustment ? { dose_u: dropAdjustment.dose_u, covered_carbs_g: dropAdjustment.covered_carbs_g, summary: dropAdjustment.summary, applied: appliedAdjustment !== null } : null,
      dose_calculation: calculation && calculatorLower ? icrBasisCalculation(calculation, loopSystemNames(context.loop_system ?? 'TRIO').nominative) : calculation,
      ...(purpose === 'MEAL' ? { card_args: args } : {}),
    };
    const wbt = purpose === 'MEAL' ? wbtAdvice(mealTotals, context.icr_g_per_u) : null;
    const itemsBeyondPlan = plannedShare < 1 && mealTotals
      ? { items_note: `The items add up to ${mealTotals.carbs_g} g of carbs but this plan gives ${plannedCarbs} g: the split advice and the fatty-meal forecast used the items' proportions for ${plannedCarbs} g; WBT counts the whole items. If the whole meal is eaten now, its rest needs a later part or a card.` }
      : {};
    // A dose passed in insulin_u may be the caregiver's or the model's own sum: above the ICR dose it keeps the warning.
    const overIcr = icrDose !== null && icrDose > 0 && (insulin - icrDose) / icrDose > REMOTE_COMMAND_POLICY.icr_difference_ratio;
    const loweredByCalculator = requestedInsulin === null && calculation !== null && icrDose !== null && insulin < icrDose;
    if (!mode.dry && purpose === 'MEAL') {
      const specs = variantSpecs({
        args,
        splitMode,
        ownPlan,
        deferredForLow,
        insulin,
        icrDose,
        step,
        carbs,
        mealCarbs: mealTotals?.carbs_g ?? null,
        splitAdvised: splitAdvice !== null,
        lowered: loweredByCalculator,
        calculatorLower,
      });
      const variants: CardVariant[] = [];
      // This card's own plan: a button that would give exactly it again changes nothing (owner 2026-11-08: "Więcej
      // później" on a meal already split at the strongest level did nothing), so it is not offered.
      const current: PlanShape = { carbs_now_g: carbs, insulin_now_u: insulin, later: laterShape(split) };
      const back = this.deps.backTo ? await this.variantOf('RECOMMENDED', this.deps.backTo.args) : null;
      if (back && !samePlan(back, current)) variants.push(back);
      for (const spec of specs) {
        const computed = await this.variantOf(spec.kind, spec.args);
        // Owner 2026-11-10 (scenario D24): a plan with more insulin than this card while the forecast goes below 54
        // asks before it replaces the card, whatever the forecast is based on.
        const variant = computed && !computed.needs_ack && computed.insulin_now_u > insulin + 1e-9 && computed.risk && computed.risk.min_mgdl < CARD_ADVICE_POLICY.risk_very_low_mgdl
          ? { ...computed, needs_ack: true, ack_text: computed.ack_text ?? `Prognoza schodzi do ok. ${computed.risk.min_mgdl}. Ta dawka może pogłębić spadek.` }
          : computed;
        // The way back (or another button) already offers this plan: no second button for it.
        if (variant && !samePlan(variant, current) && !variants.some((other) => samePlan(variant, other))) variants.push(variant);
      }
      if (variants.length > 0) advice.variants = variants;
      // The plan "Plan polecany" returns to: the first card's, kept through every switch.
      if (this.deps.backTo) advice.plan_args = this.deps.backTo.args;
      else if (specs.length > 0) advice.plan_args = args;
    }
    const result = await this.store({ purpose, carbs, insulin, step, context, args, items, split, adjustment: appliedAdjustment, advice, extraWarnings, deliberateDose: appliedAdjustment !== null || correctionApplied || loweredByCalculator || (requestedInsulin !== null && !overIcr), dry: mode.dry });
    if (result.status !== 'PROPOSED') return result;
    return {
      ...result,
      ...(calculation && purpose === 'MEAL' ? {
        dose_calculation: {
          default_u: calculation.default_u,
          from_icr_u: calculation.icr_dose_u,
          calculator_u: calculation.calculator_u,
          limited_by: calculation.limited_by,
          summary: calculation.summary,
          note: requestedInsulin === null && calculatorLower
            ? `The card's dose is carbs / ICR (the caregiver's setting); the calculator would give ${calculation.default_u} U. Say nothing about it unless asked: the card shows both.`
            : requestedInsulin === null
            ? 'The card\'s dose is this default: carbs / ICR lowered by the loop-style calculator (never raised). Quote the summary line when the dose is lower than carbs / ICR.'
            : 'The card holds the dose passed; this is what the server\'s calculator would propose.',
        },
      } : {}),
      ...(deferredForLow ? { deferred_for_low: 'Carbs come first (low now or near): the card gives the carbs with 0 U now and the meal\'s dose later, when glucose stops falling. Say so in one sentence.' } : {}),
      ...(aboveFormula ? { dose_above_formula: `${aboveFormula.message} Say it once, in one sentence starting with "⚠️".` } : {}),
      ...(wbt ? { wbt } : {}),
      ...(itemsFromEarlierCard ? { items_note: 'No items were passed: the card keeps the items of the earlier card for this meal (its WBT reminder too).' } : itemsBeyondPlan),
      ...(shorter ? { earlier_plan: shorter.note } : {}),
      ...(sentBefore ? { already_sent: sentBefore.note } : {}),
      ...(overPhoneLimit ? { phone_limit: { ...this.deps.phoneLimits, note: 'This card (or a later part) is above the limits set on the caregiver\'s phone, which will refuse to send it: say so, and that the limit is changed in the app\'s remote control settings, or offer the dose split into parts within the limit.' } } : {}),
      // split-advice.v1: whether this meal should be split, and exactly how (use_advised_split makes the card that).
      ...(fatProteinShare ? {
        split_advice: splitAdvice
          ? { advised: true, level: splitAdvice.level, now_percent: splitAdvice.now_percent, after_minutes: splitAdvice.after_minutes, now_carbs_g: splitAdvice.now_carbs_g, later_carbs_g: splitAdvice.later_carbs_g, wbt_per_ww: splitAdvice.wbt_per_ww, fat_energy_percent: splitAdvice.fat_energy_percent, reason: splitAdvice.reason, on_this_card: splitMode !== 'NO' }
          : { advised: false, wbt_per_ww: fatProteinShare.wbt_per_ww, fat_energy_percent: fatProteinShare.fat_energy_percent },
      } : {}),
    };
  }

  /** estimate_wbt: WBT units, the standard dose with the ICR valid now and the reminder (wbt-policy.v1). */
  async estimateWbt(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const protein = Number(args.protein_g);
    const fat = Number(args.fat_g);
    if (!Number.isFinite(protein) || !Number.isFinite(fat) || protein < 0 || fat < 0 || protein > 300 || fat > 300) {
      return { tool: ESTIMATE_WBT_TOOL_NAME, status: 'INVALID', problem: 'protein_g and fat_g must be grams 0-300' };
    }
    const context = await this.deps.context(this.now());
    const advice = wbtAdvice({ protein_g: protein, fat_g: fat }, context.icr_g_per_u);
    return { tool: ESTIMATE_WBT_TOOL_NAME, status: advice ? 'OK' : 'NO_WBT', icr_g_per_u: context.icr_g_per_u, ...(advice ? { wbt: advice } : {}) };
  }

  /** The newest unsent MEAL card of this conversation (last 3 h) with the same meal description (null: none). */
  private async earlierMealCard(now: Date, description: unknown): Promise<PreviousCard | null> {
    if (!this.deps.previousCards) return null;
    const name = mealName(description);
    let cards: PreviousCard[];
    try {
      this.previousCards ??= this.deps.previousCards();
      cards = await this.previousCards;
    } catch {
      return null;
    }
    const recent = cards
      .filter((card) => card.purpose === 'MEAL' && !card.sent && now.getTime() - Date.parse(card.created_at) <= 3 * 3_600_000)
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
    // Without a name only one meal of the conversation can be meant: with cards of two meals, none is.
    if (!name) {
      const names = new Set(recent.map((card) => mealName(card.meal_payload?.description)));
      return names.size === 1 ? recent[0] ?? null : null;
    }
    return recent.find((card) => mealName(card.meal_payload?.description) === name) ?? null;
  }

  /** The newest unsent card of this conversation for the same meal covered more carbs than this one (now + later). */
  /** One variant computed like a card (not stored); null when it cannot be prepared (e.g. no split at that level). */
  private async variantOf(kind: CardVariantKind, args: Record<string, unknown>): Promise<CardVariant | null> {
    const result = await this.prepare(args, { dry: true }).catch(() => null);
    const plan = result?.status === 'PROPOSED' ? result.plan as { carbs_g: number; insulin_u: number; split: SplitPlan | null; risk: PlanRisk | null; warnings: CardWarning[] } | undefined : undefined;
    if (!plan) return null;
    const risk = plan.risk && plan.risk.level !== 'NONE' ? plan.risk : null;
    // The loop's forecast without food on a plan with carbs is no reason to ask (review 2026-11-10: grey, not red).
    // Insulin on a carbs-first card (half or the whole dose while a low is near) always asks.
    const loopOnly = plan.risk?.basis === 'LOOP_WITHOUT_DOSE' && plan.carbs_g > 0 && kind !== 'HALF_NOW' && kind !== 'FULL_BOLUS_NOW';
    const strong = plan.warnings.find((warning) => warning.severity === 'DANGER') ?? (loopOnly ? undefined : plan.warnings.find((warning) => warning.code === 'FORECAST_LOW')) ?? null;
    return {
      kind,
      label: variantLabel(kind, plan.insulin_u),
      carbs_now_g: plan.carbs_g,
      insulin_now_u: plan.insulin_u,
      later: laterShape(plan.split),
      risk: plan.risk ? { min_mgdl: plan.risk.min_mgdl, level: plan.risk.level, basis: plan.risk.basis } : null,
      needs_ack: strong !== null || (risk !== null && risk.basis !== 'LOOP_WITHOUT_DOSE'),
      ack_text: strong?.message ?? null,
      args,
    };
  }

  /** A warning when the card now or any later part is above the asking phone's limits (null: within them or unknown). */
  private phoneLimitWarning(insulin: number, carbs: number, split: SplitPlan | null): CardWarning | null {
    const limits = this.deps.phoneLimits;
    if (!limits) return null;
    const over: string[] = [];
    if (insulin > limits.max_bolus_u) over.push(`${formatUnits(insulin)} j to więcej niż limit bolusa na tym telefonie (${formatUnits(limits.max_bolus_u)} j)`);
    if (carbs > limits.max_carbs_g) over.push(`${carbs} g to więcej niż limit węglowodanów na tym telefonie (${limits.max_carbs_g} g)`);
    const laterOver = planParts(split).filter((part) => part.later_insulin_u > limits.max_bolus_u || part.later_carbs_g > limits.max_carbs_g);
    if (laterOver.length > 0) over.push(`późniejsza część przekracza limit telefonu (${formatUnits(limits.max_bolus_u)} j / ${limits.max_carbs_g} g)`);
    if (over.length === 0) return null;
    return {
      code: 'PHONE_LIMIT',
      key: `PHONE_LIMIT:${insulin}:${carbs}:${limits.max_bolus_u}:${limits.max_carbs_g}`,
      severity: 'WARNING',
      message: `${over.join('; ')}: telefon jej nie wyśle. Zmień dawkę albo limit w ustawieniach zdalnego sterowania.`,
    };
  }

  /** The newest card of this conversation (last 3 h) for the same meal that was sent. */
  private async sentMealCard(now: Date, description: unknown): Promise<{ warning: CardWarning; note: Record<string, unknown> } | null> {
    if (!this.deps.previousCards) return null;
    let cards: PreviousCard[];
    try {
      this.previousCards ??= this.deps.previousCards();
      cards = await this.previousCards;
    } catch {
      return null;
    }
    const name = mealName(description);
    const sent = cards
      .filter((card) => card.purpose === 'MEAL' && card.sent && now.getTime() - Date.parse(card.sent_at ?? card.created_at) <= 3 * 3_600_000)
      .sort((left, right) => Date.parse(right.sent_at ?? right.created_at) - Date.parse(left.sent_at ?? left.created_at));
    const names = new Set(sent.map((card) => mealName(card.meal_payload?.description)));
    // Without a name only a conversation with one meal sent can mean it.
    const card = name ? sent.find((entry) => mealName(entry.meal_payload?.description) === name) : names.size === 1 ? sent[0] : undefined;
    if (!card) return null;
    const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(card.sent_at ?? card.created_at)) / 60_000));
    const carbs = card.sent_carbs_g ?? card.carbs_g;
    const insulin = card.sent_insulin_u ?? null;
    return {
      warning: {
        code: 'ALREADY_SENT_FOR_MEAL',
        key: `ALREADY_SENT_FOR_MEAL:${card.id}`,
        severity: 'DANGER',
        message: `Na ten posiłek wysłano już kartę ${minutes} min temu (${carbs} g${insulin !== null ? `, ${String(insulin).replace('.', ',')} j` : ''}). Ta karta podałaby to jeszcze raz.`,
      },
      note: {
        sent_card: { carbs_g: carbs, insulin_u: insulin, minutes_ago: minutes },
        note: 'A card for this meal was already sent from an earlier answer: say so. Prepare a new one only for what is still missing (more carbs, a later part), never the same meal again.',
      },
    };
  }

  private async planShorterThanBefore(now: Date, description: unknown, carbs: number, split: SplitPlan | null): Promise<{ warning: CardWarning; note: Record<string, unknown> } | null> {
    const earlier = await this.earlierMealCard(now, description);
    if (!earlier) return null;
    const total = (card: { carbs_g: number; split: SplitPlan | null }) => card.carbs_g + planParts(card.split).reduce((sum, part) => sum + part.later_carbs_g, 0);
    const before = total(earlier);
    const after = total({ carbs_g: carbs, split });
    if (after + 1 > before) return null;
    const missing = before - after;
    const laterBefore = planParts(earlier.split).filter((part) => part.later_carbs_g > 0).map((part) => `${part.later_carbs_g} g za ${part.later_after_minutes} min`);
    return {
      warning: {
        code: 'PLAN_SHORTER',
        key: `PLAN_SHORTER:${earlier.id}:${after}`,
        severity: 'WARNING',
        message: `Poprzednia karta na ten posiłek obejmowała ${before} g (${earlier.carbs_g} g teraz${laterBefore.length > 0 ? `, ${laterBefore.join(', ')}` : ''}); ta obejmuje ${after} g, więc ${missing} g nie ma w planie.`,
      },
      note: {
        earlier_card_carbs_g: before,
        this_card_carbs_g: after,
        missing_carbs_g: missing,
        note: 'This card leaves out part of the earlier plan for the same meal. Unless the caregiver dropped it on purpose, call propose_bolus again with every part (later can hold several parts); otherwise say plainly which grams are no longer planned.',
      },
    };
  }

  /** Checks the card's amounts and stores it (or answers BLOCKED for amounts that cannot be sent). */
  private async store(input: {
    purpose: BolusProposalPurpose;
    carbs: number;
    insulin: number;
    step: number;
    context: RemoteCommandContext & BolusProposalContext;
    args: Record<string, unknown>;
    items: MealItem[] | null;
    split: SplitPlan | null;
    adjustment: MealDoseAdjustment | null;
    advice: CardAdvice;
    extraWarnings: CardWarning[];
    /** The dose is not carbs / ICR on purpose (the caregiver's, lowered for a drop, with a correction). */
    deliberateDose: boolean;
    /** A variant: computed, not stored. */
    dry?: boolean;
  }): Promise<Record<string, unknown>> {
    const { purpose, step, context, args, items, split, adjustment, advice } = input;
    const now = new Date(context.now);
    const evaluation = evaluateRemoteCommand({ carbs_g: input.carbs, insulin_u: input.insulin, bolus_step: step, context });
    // A command waiting for Trio is checked when the card is used (with live data), not here.
    const blocks = evaluation.blocks.filter((block) => block.code !== 'COMMAND_IN_FLIGHT');
    if (blocks.length > 0) {
      return { tool: PROPOSE_BOLUS_TOOL_NAME, status: 'BLOCKED', reasons: blocks.map((block) => block.message) };
    }
    // So is the bolus history (the confirmation shows its own warnings from live data). A dose chosen on purpose says
    // why on the card instead of "differs from ICR".
    const warnings: CardWarning[] = [
      ...input.extraWarnings,
      ...evaluation.warnings.filter((warning) => warning.code !== 'INSULIN_HISTORY_UNAVAILABLE' && !(input.deliberateDose && warning.code === 'DOSE_DIFFERS_FROM_ICR')),
    ];

    if (input.dry) {
      return { tool: PROPOSE_BOLUS_TOOL_NAME, status: 'PROPOSED', plan: { carbs_g: input.carbs, insulin_u: input.insulin, split, risk: advice.risk, warnings } };
    }
    const totals = items ? sumMealItems(items) : null;
    const description = typeof args.meal_description === 'string' && args.meal_description.trim() ? args.meal_description.trim().slice(0, 300) : null;
    const record = await this.deps.store.insert({
      patient_id: this.deps.patientId,
      conversation_id: this.deps.conversationId,
      user_message_id: this.deps.userMessageId,
      meal_plan_entry_id: this.deps.mealPlanEntryId ?? null,
      purpose,
      carbs_g: input.carbs,
      insulin_u: input.insulin,
      icr_g_per_u: context.icr_g_per_u,
      icr_insulin_u: evaluation.icr_insulin_u,
      meal_payload: (input.carbs > 0 || split !== null) && (description || items)
        ? { description, items, macros: totals ? { carbs_g: totals.carbs_g, protein_g: totals.protein_g, fat_g: totals.fat_g } : null }
        : null,
      reason: typeof args.reason === 'string' ? args.reason.trim().slice(0, 300) : null,
      warnings,
      split,
      dose_adjustment: adjustment,
      card_advice: advice,
      option_key: readOptionKey(args.option),
      expires_at: new Date(now.getTime() + BOLUS_PROPOSAL_VALID_MINUTES * 60_000).toISOString(),
    });
    // A new card for an option (or, without options, for the same meal) replaces its earlier card of the same purpose:
    // the plan changed after a result, and two plans must not both stay sendable.
    const replaced = !this.deps.store.discard
      ? undefined
      : this.proposed.find((card) => card.id !== record.id && card.option_key === record.option_key && card.purpose === record.purpose
        && (record.option_key !== null || mealName(card.meal_payload?.description) === mealName(record.meal_payload?.description)));
    if (replaced) {
      await this.deps.store.discard!(this.deps.patientId, replaced.id);
      this.proposed.splice(this.proposed.indexOf(replaced), 1);
    }
    this.proposed.push(record);
    return {
      tool: PROPOSE_BOLUS_TOOL_NAME,
      status: 'PROPOSED',
      ...(replaced ? { note_replaced: record.option_key !== null || mealName(record.meal_payload?.description)
        ? `This card replaces ${record.option_key !== null ? `option ${record.option_key}'s` : 'the'} earlier ${record.purpose} card.`
        : `This card replaces the earlier ${record.purpose} card: neither had a meal_description. For two different meals, call again for each with its meal_description.` } : {}),
      card: {
        option: record.option_key,
        carbs_g: record.carbs_g,
        insulin_u: record.insulin_u,
        dose_from_icr: evaluation.icr_insulin_u,
        icr_g_per_u: context.icr_g_per_u,
        warnings: warnings.map((warning) => `${warning.severity === 'DANGER' ? '[!!] ' : ''}${warning.message}`),
        risk: advice.risk ? { forecast_min_mgdl: advice.risk.min_mgdl, in_minutes: advice.risk.min_in_minutes, level: advice.risk.level, without_card_min_mgdl: advice.risk.baseline_min_mgdl, basis: advice.risk.basis } : null,
        situation: advice.situation?.text ?? null,
        ...(split ? {
          later: planParts(split).map((part) => ({
            kind: part.kind,
            trigger: part.trigger,
            after_minutes: part.later_after_minutes,
            threshold_mgdl: part.threshold_mgdl ?? null,
            carbs_g: part.later_carbs_g,
            insulin_u_estimate: part.later_insulin_u,
            wait_minutes: part.wait_minutes ?? null,
            note: part.fixed_insulin_u !== null && part.fixed_insulin_u !== undefined
              ? `This later dose is fixed at ${part.fixed_insulin_u} U as the caregiver named it (not recomputed): say so.`
              : 'This later dose is computed by the app (not by Trio) when the reminder comes (ICR then, minus what the loop added and what this card gave for the same carbs): say so.',
          })),
          whole_plan: { carbs_g: split.total_carbs_g, insulin_u_estimate: split.total_insulin_u },
          ...(split.kind === 'SPLIT' && (split.dose_carbs_g ?? 0) > split.later_carbs_g ? { card_carbs_dosed_later: `The first later dose is for ${split.dose_carbs_g} g: its own ${split.later_carbs_g} g and the carbs now, which have no insulin now. Say so.` } : {}),
        } : {}),
      },
      advice: {
        ...(advice.fast_carbs_first ? { fast_carbs_first: { carbs_g: advice.fast_carbs_first.carbs_g, level: advice.fast_carbs_first.level, message: advice.fast_carbs_first.message } } : {}),
        ...(advice.reduce_for_drop ? { reduce_for_drop: { dose_u: advice.reduce_for_drop.dose_u, covered_carbs_g: advice.reduce_for_drop.covered_carbs_g, summary: advice.reduce_for_drop.summary, on_this_card: advice.reduce_for_drop.applied } } : {}),
        ...(advice.correction ? { correction: { dose_u: advice.correction.dose_u, breakdown: advice.correction.breakdown, on_this_card: advice.correction.applied } } : {}),
        note: 'Advice from the data: use it for the options you offer; the card holds the plan as passed.',
      },
    };
  }
}

const PROPOSAL_LINE = /\*\*Propozycja:\*\*([^\n]*)/i;
/** "brak", "nie podawaj", "bez bolusa", "poczekaj": the answer proposes no dose. */
const NO_DOSE = /^\s*(?:brak|nic|nie\b|bez\b|wstrzymaj|poczekaj|zaczekaj|odłóż)/iu;
/** A number of units that is the dose, not the insulin already working ("0,69 j IOB"). */
const UNITS = /\d+(?:[.,]\d+)?\s*(?:j\.?|jedn\p{L}*)(?![\p{L}])(?!\s*(?:IOB|insuliny aktywnej|aktywnej|na pokładzie))/giu;
const CLAIMED_GIVEN = /(?:^|[^\p{L}])(?:poda(?:łem|łam|no)|wysła(?:łem|łam|no)) (?:bolus|insulin|dawk)/iu;

/** Whether the answer's "Propozycja:" line proposes a dose to give. */
export function proposesDose(text: string): boolean {
  const line = PROPOSAL_LINE.exec(text)?.[1];
  if (!line || NO_DOSE.test(line)) return false;
  return [...line.matchAll(UNITS)].length > 0;
}

/**
 * The answer's text and its card must agree: a dose in the text without a card says it cannot be given from here; a
 * claim that insulin was given is corrected (only the caregiver gives it, from the card). An answer that tried to
 * prepare a card (propose_bolus was called and refused) or proposes no dose explains itself and gets no note.
 */
export function finalizeBolusAnswer(text: string, session: Pick<BolusProposalSession, 'used' | 'proposed'> & { dose_requested?: boolean; failed?: boolean } | null): { text: string; corrected: boolean; kind?: 'BOLUS_GIVEN_CLAIM' | 'BOLUS_DOSE_WITHOUT_CARD' } {
  if (!session) return { text, corrected: false };
  if (CLAIMED_GIVEN.test(text)) {
    return { text: `${text.trimEnd()}\n\nNic nie zostało podane: dawkę podaje opiekun przyciskiem na karcie bolusa, po potwierdzeniu Face ID.`, corrected: true, kind: 'BOLUS_GIVEN_CLAIM' };
  }
  if (session.proposed.length === 0 && (!session.used || session.failed) && proposesDose(text)) {
    const note = session.dose_requested || session.failed
      ? 'Karta bolusa nie powstała przy tej odpowiedzi, więc tej dawki nie da się podać stąd. Możesz podać ją z zakładki Bolus.'
      : 'Tej dawki nie da się podać z tej odpowiedzi. Napisz „przygotuj bolus”, a pojawi się karta z przyciskiem podania.';
    return { text: `${text.trimEnd()}\n\n${note}`, corrected: true, kind: 'BOLUS_DOSE_WITHOUT_CARD' };
  }
  return { text, corrected: false };
}

type CardForDuplicates = Pick<BolusProposalRecord, 'id' | 'purpose' | 'carbs_g' | 'insulin_u' | 'meal_payload' | 'split'>;

/** JSON with sorted keys: a card read back from jsonb has its keys in another order than the one just built. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** What sending the card does: purpose, meal, carbs and dose now, every later part (the option tag left out). */
function sendablePlan(card: CardForDuplicates): string {
  return canonicalJson({
    purpose: card.purpose,
    meal: mealName(card.meal_payload?.description),
    macros: card.meal_payload?.macros ?? null,
    carbs_g: Number(card.carbs_g),
    insulin_u: Number(card.insulin_u),
    split: card.split ?? null,
  });
}

/**
 * Cards of an answer without an option picker that are exact copies of a newer one: the same purpose, meal, macros,
 * carbs, dose and later parts, any option tag (without a picker the tags mean nothing), so the same plan never stands
 * twice as sendable (2026-10-23 16:10: one card tagged B and the same card untagged). Cards that differ in anything
 * sendable all stay. Cards come in creation order; the newest copy stays.
 */
export function duplicateCardsWithoutPicker<T extends CardForDuplicates>(cards: readonly T[]): T[] {
  const newest = new Map<string, T>();
  for (const card of cards) newest.set(sendablePlan(card), card);
  const kept = new Set([...newest.values()].map((card) => card.id));
  return cards.filter((card) => !kept.has(card.id));
}

/**
 * Which cards of a finished answer stay (answer-options.v1). With a picker (options of which at least one has cards):
 * all options' cards stay, those without an option (or of an option the answer lost) go. Without one: only one
 * option's cards stay (the recommended one, or A, or the first tagged), and exact copies of a card go.
 */
export function settleAnswerCards<B extends CardForDuplicates & { option_key: string | null }, R extends { option_key: string | null }>(
  options: readonly AnswerOption[],
  bolusCards: readonly B[],
  rescueCards: readonly R[],
): { options: AnswerOption[]; discardBolus: B[]; discardRescue: R[]; keptOption: string | null; duplicates: B[] } {
  const keys = new Set<string | null>([...bolusCards.map((card) => card.option_key), ...rescueCards.map((card) => card.option_key)]);
  if (options.length > 0 && options.some((option) => keys.has(option.key))) {
    const known = new Set<string>(options.map((option) => option.key));
    const orphan = (card: { option_key: string | null }) => card.option_key === null || !known.has(card.option_key);
    return { options: [...options], discardBolus: bolusCards.filter(orphan), discardRescue: rescueCards.filter(orphan), keptOption: null, duplicates: [] };
  }
  const tagged = [...keys].filter((key): key is string => key !== null).sort();
  const keptOption = tagged.length > 1
    ? options.find((option) => option.recommended && keys.has(option.key))?.key ?? (keys.has('A') ? 'A' : tagged[0])
    : null;
  const otherOption = (card: { option_key: string | null }) => keptOption !== null && card.option_key !== null && card.option_key !== keptOption;
  const duplicates = duplicateCardsWithoutPicker(bolusCards.filter((card) => !otherOption(card)));
  return {
    options: [],
    discardBolus: [...bolusCards.filter(otherOption), ...duplicates],
    discardRescue: rescueCards.filter(otherOption),
    keptOption,
    duplicates,
  };
}

function invalid(problem: string): Record<string, unknown> {
  return { tool: PROPOSE_BOLUS_TOOL_NAME, status: 'INVALID', problem };
}

/** A card as the app shows it under the answer. */
export interface BolusProposalView {
  id: string;
  purpose: BolusProposalPurpose;
  carbs_g: number;
  insulin_u: number;
  icr_g_per_u: number | null;
  icr_insulin_u: number | null;
  meal_description: string | null;
  meal: RemoteCommandMealPayload | null;
  reason: string | null;
  warnings: RemoteCommandEvaluation['warnings'];
  /** The meal divided into a part now (carbs_g, insulin_u) and a planned part; null for one bolus. */
  split: SplitPlan | null;
  /** The planned second part once the first part's meal was saved. */
  planned_bolus: PlannedBolusSummary | null;
  /** Why the dose is lower than carbs / ICR (a falling glucose); null: carbs / ICR. */
  dose_adjustment: { summary: string; reduced_by_u: number; covered_carbs_g: number; forecast_low_mgdl: number; target_mgdl: number } | null;
  /** The forecast low of exactly this card (card-advice.v1); null without a fresh reading, and (card-advice.v2) when the
   * low is the loop's own without the card: then situation says it as a plain line. */
  risk: { min_mgdl: number; min_in_minutes: number; level: PlanRisk['level']; baseline_min_mgdl: number; basis: PlanRisk['basis']; loop_name: string | null } | null;
  /** The chart behind the card's chart button (card-forecast.v1); null on older cards or without a fresh reading. */
  forecast_chart: CardForecastChart | null;
  /** What the loop expects without the card, as a plain line (card-advice.v2); null when there is nothing to say. */
  situation: { text: string; min_mgdl: number; min_in_minutes: number; loop_name: string | null } | null;
  fast_carbs_first: { carbs_g: number | null; level: FastCarbsFirst['level']; glucose_mgdl: number | null; minutes_to_low: number | null } | null;
  /** The buttons under "Podaj" (card-variants.v1), without their arguments; empty on older cards and own plans. */
  variants: Array<Omit<CardVariant, 'args'>>;
  /** rest-later.v1: the rest's reminder the card offers; null: none. */
  rest_offer: RestOffer | null;
  /** The correction on the card (its breakdown); null when the card has none. */
  correction: { dose_u: number; breakdown: string } | null;
  /** Where a MEAL card's dose comes from (dose-calculator.v1): the line for under the dose; null on older cards. */
  dose_calculation: { summary: string; short_summary: string | null; formula: string | null; default_u: number; icr_dose_u: number | null; calculator_u: number | null; limited_by: string } | null;
  /** The meal's WBT (wbt-policy.v1): units, the standard dose with the card's ICR, and whether the reminder comes on its
   * own about after_minutes after the meal; null without protein and fat. */
  wbt_plan: { units: number; standard_dose_u: number | null; auto: boolean; after_minutes: number } | null;
  /** The answer's option the card belongs to; null: shown whatever option is chosen. */
  option_key: AnswerOptionKey | null;
  /** When the card was computed (the data behind it); with expires_at the app shows how fresh it is. */
  created_at: string;
  expires_at: string;
  /** PROPOSED (can be given), EXPIRED (recalculate), or the state of the command sent from it. */
  state: 'PROPOSED' | 'EXPIRED' | 'SENT';
  command: {
    id: string;
    status: string;
    status_message: string | null;
    carbs_g: number;
    insulin_u: number;
    meal_record_id: string | null;
    sent_by_me: boolean;
    /** A retry of a refused command: the card never offers the whole dose again from it. */
    follows_command_id: string | null;
    /** When the caregiver confirmed it (the card's "Teraz" becomes this time). */
    authorized_at: string | null;
    retry_until: string | null;
    /** SAVED, SAVING (Trio's entries not in Nightscout yet), NOT_FOUND (not matched in time) or NONE (no meal expected). */
    meal_state: 'SAVED' | 'SAVING' | 'NOT_FOUND' | 'NONE';
  } | null;
}

export function toBolusProposalView(
  proposal: BolusProposalRecord,
  command: { id: string; status: string; status_message: string | null; carbs_g: number; insulin_u: number; meal_record_id: string | null; user_id: string; authorized_at?: string; follows_command_id?: string | null } | null,
  viewerUserId: string,
  now: Date,
  plannedBolus: PlannedBolusSummary | null = null,
): BolusProposalView {
  // A failed or expired send leaves the card usable (until it expires itself).
  const sent = command !== null && !['EXPIRED', 'SEND_FAILED'].includes(command.status);
  return {
    id: proposal.id,
    purpose: proposal.purpose,
    carbs_g: proposal.carbs_g,
    insulin_u: proposal.insulin_u,
    icr_g_per_u: proposal.icr_g_per_u,
    icr_insulin_u: proposal.icr_insulin_u,
    meal_description: proposal.meal_payload?.description ?? null,
    meal: proposal.meal_payload,
    reason: proposal.reason,
    // Cards stored before this warning was dropped (2026-10-19) do not show it either.
    warnings: proposal.warnings.filter((warning) => warning.code !== ('INSULIN_WITHOUT_CARBS' as string)),
    split: readSplitPlan(proposal.split),
    planned_bolus: plannedBolus,
    dose_adjustment: adjustmentView(proposal.dose_adjustment),
    forecast_chart: proposal.card_advice?.forecast_chart ?? null,
    situation: proposal.card_advice?.situation ?? null,
    // The fast carbs the data advised when the card was made (a low now or soon): the planned meal's page shows them as
    // the first step of the plan (the chat shows its own rescue card instead).
    fast_carbs_first: proposal.card_advice?.fast_carbs_first
      ? { carbs_g: proposal.card_advice.fast_carbs_first.carbs_g, level: proposal.card_advice.fast_carbs_first.level, glucose_mgdl: proposal.card_advice.fast_carbs_first.glucose_mgdl ?? null, minutes_to_low: proposal.card_advice.fast_carbs_first.minutes_to_low ?? null }
      : null,
    variants: (proposal.card_advice?.variants ?? []).map(({ args: _args, ...variant }) => variant),
    rest_offer: proposal.card_advice?.rest_offer ?? null,
    // A low the loop expects without the card is the situation line, not the card's forecast badge (older apps draw any
    // risk below 70 as the card's own).
    risk: proposal.card_advice?.risk && !proposal.card_advice.situation
      ? { min_mgdl: proposal.card_advice.risk.min_mgdl, min_in_minutes: proposal.card_advice.risk.min_in_minutes, level: proposal.card_advice.risk.level, baseline_min_mgdl: proposal.card_advice.risk.baseline_min_mgdl, basis: proposal.card_advice.risk.basis ?? 'WITH_DOSE', loop_name: proposal.card_advice.risk.loop_name ?? null }
      : null,
    correction: proposal.card_advice?.correction?.applied ? { dose_u: proposal.card_advice.correction.dose_u, breakdown: proposal.card_advice.correction.breakdown } : null,
    dose_calculation: doseCalculationView(proposal),
    wbt_plan: wbtPlanOf(proposal),
    option_key: proposal.option_key,
    created_at: proposal.created_at,
    expires_at: proposal.expires_at,
    state: sent ? 'SENT' : Date.parse(proposal.expires_at) <= now.getTime() ? 'EXPIRED' : 'PROPOSED',
    command: command ? sentCommandView(command, viewerUserId, now) : null,
  };
}

export function wbtPlanOf(proposal: BolusProposalRecord): BolusProposalView['wbt_plan'] {
  const macros = proposal.meal_payload?.macros;
  if (proposal.purpose !== 'MEAL' || !macros) return null;
  const units = fatProteinUnitsOf(macros.protein_g, macros.fat_g);
  if (units === null || units <= 0) return null;
  return {
    units,
    standard_dose_u: proposal.icr_g_per_u ? standardWbtDose(units, proposal.icr_g_per_u).dose_units : null,
    auto: shouldRemindAboutWbt({ protein_g: macros.protein_g, fat_g: macros.fat_g }),
    after_minutes: WBT_REMINDER_DELAY_MINUTES,
  };
}

function adjustmentView(raw: unknown): BolusProposalView['dose_adjustment'] {
  const adjustment = readMealDoseAdjustment(raw);
  return adjustment
    ? { summary: adjustment.summary, reduced_by_u: adjustment.reduced_by_u, covered_carbs_g: adjustment.covered_carbs_g, forecast_low_mgdl: adjustment.forecast_low_mgdl, target_mgdl: adjustment.target_mgdl }
    : null;
}

type SentCommandSource = { id: string; status: string; status_message: string | null; carbs_g: number; insulin_u: number; meal_record_id: string | null; user_id: string; authorized_at?: string; follows_command_id?: string | null; purpose?: 'WBT' | 'MEAL_PART' | 'HYPO_TREATMENT' | null };

/** A sent command as a card shows it (a chat card, the WBT window): status, amounts, retry and meal progress. */
export function sentCommandView(command: SentCommandSource, viewerUserId: string, now: Date): NonNullable<BolusProposalView['command']> {
  return {
    id: command.id,
    status: command.status,
    status_message: command.status_message,
    carbs_g: command.carbs_g,
    insulin_u: command.insulin_u,
    meal_record_id: command.meal_record_id,
    sent_by_me: command.user_id === viewerUserId,
    follows_command_id: command.follows_command_id ?? null,
    authorized_at: command.authorized_at ?? null,
    // Refused by Trio: the card offers the bolus again (alone after PARTIAL) until then.
    retry_until: (command.status === 'PARTIAL' || command.status === 'REJECTED') && command.authorized_at
      && Date.parse(command.authorized_at) + REMOTE_COMMAND_POLICY.retry_window_minutes * 60_000 > now.getTime()
      ? new Date(Date.parse(command.authorized_at) + REMOTE_COMMAND_POLICY.retry_window_minutes * 60_000).toISOString()
      : null,
    meal_state: mealState(command, now),
  };
}

/** Whether the card's command made (or joined) a meal: saved, still being saved from Nightscout, or not found in time. */
function mealState(
  command: { status: string; carbs_g: number; meal_record_id: string | null; authorized_at?: string; follows_command_id?: string | null; purpose?: 'WBT' | 'MEAL_PART' | 'HYPO_TREATMENT' | null },
  now: Date,
): 'SAVED' | 'SAVING' | 'NOT_FOUND' | 'NONE' {
  if (command.meal_record_id) return 'SAVED';
  // Rescue carbs make no meal.
  if (command.purpose === 'HYPO_TREATMENT') return 'NONE';
  // WBT is saved to its meal like a meal's carbs (also insulin alone).
  const makesMeal = command.carbs_g > 0 || !!command.follows_command_id || command.purpose === 'WBT' || command.purpose === 'MEAL_PART';
  if (!makesMeal || (command.status !== 'SUCCEEDED' && command.status !== 'PARTIAL')) return 'NONE';
  const authorizedMs = command.authorized_at ? Date.parse(command.authorized_at) : now.getTime();
  return now.getTime() - authorizedMs <= REMOTE_COMMAND_POLICY.match_window_minutes * 60_000 ? 'SAVING' : 'NOT_FOUND';
}

/**
 * A dose passed in insulin_u (MEAL, CORRECTION) at least max(0,5 U, 25%) above the server's formula (dose-calculator.v1,
 * change 3). Not while carbs come first (FAST_CARBS_FIRST on the card, INSULIN_WHILE_LOW when it is sent) and not for a
 * pre-bolus (its carbs come later: there is no formula without them).
 */
function doseAboveFormulaWarning(insulin: number, calculation: DoseCalculation | null, purpose: BolusProposalPurpose, carbs: number): CardWarning | null {
  // A pre-bolus without carbs has no formula; with carbs (edited) it is held against them (review M1).
  if ((purpose === 'PRE_BOLUS' && !(carbs > 0)) || !calculation || calculation.carbs_first || !doseExceedsFormula(insulin, calculation.reference_u)) return null;
  const reference = calculation.reference_u!;
  const what = referenceWhy(calculation);
  return {
    code: 'DOSE_ABOVE_FORMULA',
    key: `DOSE_ABOVE_FORMULA:${purpose}:${insulin}:${reference}`,
    severity: 'DANGER',
    message: `Dawka ${formatUnits(insulin)} j jest o ${formatUnits(Math.round((insulin - reference) * 100) / 100)} j większa, niż wychodzi z danych (${what}). Większa dawka grozi niedocukrzeniem.`,
  };
}

function doseCalculationView(proposal: BolusProposalRecord): BolusProposalView['dose_calculation'] {
  const calculation = proposal.card_advice?.dose_calculation;
  if (!calculation || proposal.purpose !== 'MEAL' || typeof calculation.summary !== 'string' || !calculation.summary) return null;
  return { summary: calculation.summary, short_summary: calculation.short_summary ?? null, formula: calculation.formula ?? null, default_u: calculation.default_u, icr_dose_u: calculation.icr_dose_u, calculator_u: calculation.calculator_u, limited_by: calculation.limited_by };
}

/** rest-later.v1: the reminder the card's one later part has now ("Po spadku", a time); null for any other trigger. */
function restReminderNow(part: ReturnType<typeof planParts>[number]): RestOffer['current'] {
  const trigger = planTrigger(part);
  if (trigger === 'GLUCOSE_STOPPED_FALLING') return { trigger: 'GLUCOSE_STOPPED_FALLING', minutes: null };
  if (trigger === 'AFTER_MINUTES') return { trigger: 'AFTER_MINUTES', minutes: part.later_after_minutes };
  return null;
}

/**
 * The MEAL card's dose (dose-calculator.v1, dose-basis.v1): carbs / ICR, or min(carbs / ICR, the calculator) when the
 * caregiver chose the calculator; carbs first (a low) keeps the calculator's 0 j whatever the basis. The standard plan of
 * an answer's options is the dose for all carbs by ICR, also with a low near (its risk badge shows it). A correction is
 * added only when the plan asks for it and carbs do not come first.
 */
export function mealDoseChoice(args: {
  icr_dose_u: number;
  calculation: DoseCalculation | null;
  drop_adjustment: MealDoseAdjustment | null;
  correction: CorrectionEstimate | null;
  standard_plan: boolean;
  dose_basis: DoseBasis;
  add_correction: boolean;
  step: number;
}): { insulin: number; calculatorLower: boolean; appliedAdjustment: MealDoseAdjustment | null; correctionApplied: boolean } {
  const { calculation, icr_dose_u: icrDose } = args;
  const carbsFirst = Boolean(calculation?.carbs_first);
  const byICR = args.standard_plan || (args.dose_basis === 'ICR' && !carbsFirst);
  let insulin = calculation && !byICR ? Math.min(icrDose, calculation.default_u) : icrDose;
  // By ICR while the calculator would give less: the card offers the calculator's dose as a variant.
  const calculatorLower = byICR && !args.standard_plan && calculation !== null && !carbsFirst && calculation.default_u < icrDose - 1e-9;
  const appliedAdjustment = !byICR && calculation?.limited_by === 'DROP' && args.drop_adjustment ? args.drop_adjustment : null;
  let correctionApplied = false;
  if (args.add_correction && !carbsFirst && args.correction && args.correction.dose_u > 0) {
    insulin = roundDownToStep(insulin + args.correction.dose_u, args.step);
    correctionApplied = true;
  }
  return { insulin, calculatorLower, appliedAdjustment, correctionApplied };
}
