import type { OpenAiResponsesTransport } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { WBT_DOSE_BOUNDS, WBT_POLICY_VERSION, WBT_STANDARD_FACTOR, roundDownWbtUnits, standardWbtDose } from './wbt-policy';
import { patientAge, patientAgeInstructionPl } from '@shared/primitives/patient-age';
import { CURRENT_READING_MAX_AGE_MINUTES } from '@shared/primitives/glucose-rules';

export const MEAL_WBT_SUGGESTION_JOB_TYPE = 'meal.wbt_suggestion';

/** Below this glucose (mg/dL) no WBT insulin is proposed, whatever the model says. */
const NO_INSULIN_BELOW_MGDL = WBT_DOSE_BOUNDS.no_insulin_below_mgdl;
/** A reading older than this (minutes) is not a current glucose: no WBT insulin is proposed on it (as in the chat). */
const MAX_GLUCOSE_AGE_MINUTES = CURRENT_READING_MAX_AGE_MINUTES;
/** One WBT call at most this long (the SDK would wait up to ten minutes and hold the worker's lane). */
const WBT_SUGGESTION_TIMEOUT_MS = 60_000;

export interface WbtSuggestionContext {
  meal: {
    meal_record_id: string;
    description: string | null;
    started_at: string;
    local_time: string | null;
    carbs_g: number | null;
    protein_g: number | null;
    fat_g: number | null;
    fat_protein_units: number | null;
    meal_bolus_units: number | null;
  };
  /** ICR active now, when the WBT insulin is given: the loop converts WBT carbs with it, not with the meal's ICR. */
  icr_g_per_u: number | null;
  current: { as_of: string | null; glucose_mgdl: number | null; trend: string | null; iob_u: number | null; cob_g: number | null; minutes_after_meal: number };
  /** WBT insulin already given for this meal (WBT carbs in the loop / late boluses). */
  already_given: { wbt_carbs_logged_g: number; late_bolus_units: number; wbt_insulin_units: number | null };
  /** "Rok urodzenia" of the patient: the prompt states the age (absent or null = not set). */
  patient_birth_year?: number | null;
}

export interface WbtAiAnswer {
  dose_units: number;
  rationale: string;
}

export interface WbtSuggestionResponder {
  readonly providerName: string;
  suggest(input: Record<string, unknown>): Promise<WbtAiAnswer>;
}

export interface WbtSuggestionDeps {
  getSuggestion(suggestionId: string): Promise<{ patient_id: string; meal_record_id: string; status: string } | null>;
  loadContext(patientId: string, mealRecordId: string, nowIso: string): Promise<WbtSuggestionContext>;
  completeSuggestion(suggestionId: string, status: 'DONE' | 'FAILED', result: Record<string, unknown> | null): Promise<void>;
  responder: WbtSuggestionResponder;
  isRetryableError(error: unknown): boolean;
}

const units = roundDownWbtUnits;
const formatUnits = (value: number) => String(Math.round(value * 100) / 100).replace('.', ',');

/**
 * Proposes the WBT insulin for one meal from the standard WBT x (10 g / ICR) x 30%: the model writes the rationale and
 * adjusts for the current glucose; the server keeps the dose in safe bounds. Decision support only.
 */
export async function runWbtSuggestionJob(deps: WbtSuggestionDeps, payload: Record<string, unknown>, nowIso: string): Promise<'DONE' | 'FAILED' | 'ALREADY_DONE'> {
  const suggestionId = String(payload.suggestion_id ?? '');
  if (!suggestionId) throw new Error('INVALID_WBT_SUGGESTION_PAYLOAD');
  const suggestion = await deps.getSuggestion(suggestionId);
  if (!suggestion || suggestion.status !== 'PENDING') return 'ALREADY_DONE';

  try {
    const context = await deps.loadContext(suggestion.patient_id, suggestion.meal_record_id, nowIso);
    const result = await buildSuggestion(deps.responder, context, nowIso);
    await deps.completeSuggestion(suggestionId, 'DONE', result);
    return 'DONE';
  } catch (error) {
    if (deps.isRetryableError(error)) throw error;
    await deps.completeSuggestion(suggestionId, 'FAILED', { error: error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN' });
    return 'FAILED';
  }
}

export async function buildSuggestion(responder: WbtSuggestionResponder, context: WbtSuggestionContext, nowIso: string): Promise<Record<string, unknown>> {
  const fpu = context.meal.fat_protein_units;
  if (fpu === null || fpu <= 0) throw new Error('WBT_MACROS_UNKNOWN');
  if (!context.icr_g_per_u) throw new Error('WBT_ICR_UNKNOWN');
  const standard = standardWbtDose(fpu, context.icr_g_per_u);
  const asOf = context.current.as_of ? Date.parse(context.current.as_of) : Number.NaN;
  const ageMinutes = Number.isFinite(asOf) ? Math.max(0, Math.round((Date.parse(nowIso) - asOf) / 60_000)) : null;
  const current = { ...context.current, glucose_age_minutes: ageMinutes };
  // WBT insulin already given for this meal (WBT carbs / ICR + late boluses) counts toward the ceiling.
  const alreadyGiven = Math.max(0, context.already_given.wbt_insulin_units ?? 0);

  // No earlier meals: the standard rule, adjusted to the current state.
  const answer = await responder.suggest({
    policy: {
      version: WBT_POLICY_VERSION,
      standard_formula: `WBT x (10 g / ICR) x ${WBT_STANDARD_FACTOR * 100}%`,
      no_insulin_below_mgdl: NO_INSULIN_BELOW_MGDL,
    },
    meal: context.meal,
    icr_g_per_u: context.icr_g_per_u,
    standard_dose: standard,
    current,
    already_given: context.already_given,
    patient: { birth_year: context.patient_birth_year ?? null },
  });

  // Safety bounds: nothing when low, never above 2x the standard dose. Each change of the model's dose is kept in
  // server_adjustment (server-corrections.v1), so the review sees how often the bounds act.
  // The ceiling is the whole meal's WBT insulin: what was already given is taken off it.
  const ceiling = Math.max(0, WBT_DOSE_BOUNDS.max_standard_multiple * standard.dose_units - alreadyGiven);
  const modelDose = Number.isFinite(answer.dose_units) ? answer.dose_units : null;
  let adjustment: 'NOT_A_NUMBER' | 'BELOW_ZERO' | 'ABOVE_MAX' | 'LOW_GLUCOSE' | 'STALE_GLUCOSE' | null = modelDose === null ? 'NOT_A_NUMBER' : modelDose < 0 ? 'BELOW_ZERO' : modelDose > ceiling ? 'ABOVE_MAX' : null;
  let dose = modelDose === null ? Math.min(standard.dose_units, ceiling) : Math.min(Math.max(modelDose, 0), ceiling);
  let rationale = answer.rationale.trim();
  const glucose = context.current.glucose_mgdl;
  if ((glucose === null || ageMinutes === null || ageMinutes > MAX_GLUCOSE_AGE_MINUTES) && dose > 0) {
    dose = 0;
    adjustment = 'STALE_GLUCOSE';
    rationale = `${glucose === null || ageMinutes === null ? 'Brak aktualnej glikemii' : `Ostatni odczyt glikemii jest sprzed ${ageMinutes} min`}: sprawdź glikemię przed insuliną na WBT. ${rationale}`;
  } else if (glucose !== null && glucose < NO_INSULIN_BELOW_MGDL && dose > 0) {
    dose = 0;
    adjustment = 'LOW_GLUCOSE';
    rationale = `Glikemia ${glucose} mg/dL jest za niska na dodatkową insulinę teraz. ${rationale}`;
  } else if (adjustment === 'ABOVE_MAX' || adjustment === 'NOT_A_NUMBER') {
    // The model's own number would contradict the dose shown: the server's sentence comes first.
    const limit = formatUnits(units(ceiling));
    rationale = `${adjustment === 'ABOVE_MAX' ? `Dawkę ograniczono do ${limit} j` : `Dawka: ${formatUnits(units(dose))} j (dawka standardowa)`}${alreadyGiven > 0 ? ` (maks. 2× dawka standardowa minus ${formatUnits(alreadyGiven)} j już podane na WBT)` : adjustment === 'ABOVE_MAX' ? ' (maks. 2× dawka standardowa)' : ''}. ${rationale}`;
  }
  dose = units(dose);

  return {
    policy_version: WBT_POLICY_VERSION,
    provider: responder.providerName,
    generated_at: nowIso,
    basis: 'STANDARD',
    dose_units: dose,
    carbs_equivalent_g: Math.round(dose * context.icr_g_per_u),
    rationale,
    standard: { ...standard, factor: WBT_STANDARD_FACTOR },
    icr_g_per_u: context.icr_g_per_u,
    meal: context.meal,
    current,
    already_given: context.already_given,
    // Still read by the app's WBT screen (always empty: no earlier meals are used).
    history_cases_used: 0,
    history_cases: [],
    server_adjustment: adjustment ? { reason: adjustment, model_dose_units: modelDose } : null,
  };
}

/** Offline responder (AI_PROVIDER=fake): the standard dose. */
export class FakeWbtSuggestionResponder implements WbtSuggestionResponder {
  readonly providerName = 'fake';

  async suggest(input: Record<string, unknown>): Promise<WbtAiAnswer> {
    const standard = input.standard_dose as { dose_units: number };
    return { dose_units: standard.dose_units, rationale: 'Wersja testowa: dawka standardowa (30% insuliny na 1 WW na każde WBT).' };
  }
}

const SYSTEM_INSTRUCTIONS = [
  'Pomagasz opiekunowi osoby z cukrzycą typu 1 (pompa z pętlą) zdecydować o insulinie na WBT (wymienniki białkowo-tłuszczowe) około 2,5 h po posiłku.',
  'Dostajesz posiłek (makro, WBT, bolus posiłkowy), ICR obowiązujący teraz (w chwili podania insuliny na WBT), aktualny stan (glikemia mg/dL, jej wiek w minutach, trend, IOB, COB), insulinę na WBT już podaną do tego posiłku i dawkę standardową (standard_dose). Wyjdź od standard_dose.',
  'Uwzględnij aktualny stan: glikemia niska lub spadająca, duże IOB albo COB oznaczają mniej insuliny lub 0; glikemia wysoka i rosnąca może uzasadniać trochę więcej. Odejmij insulinę na WBT już podaną. Poniżej policy.no_insulin_below_mgdl proponuj 0.',
  'dose_units: liczba jednostek, zaokrąglona w dół do 0,05 j. rationale: 2-4 krótkie zdania po polsku, konkretnie (liczby z danych), bez wstępów i bez ostrzeżeń ogólnych. Pętla może podać insulinę jako węglowodany: nie przeliczaj tego w tekście, serwer dopisze.',
  'To wsparcie decyzji: decyzję podejmuje opiekun.',
].join('\n');

const WBT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dose_units', 'rationale'],
  properties: {
    dose_units: { type: 'number' },
    rationale: { type: 'string' },
  },
} as const;

/** WBT dose on OpenAI (Responses API) through the guarded client (cost guard + budget ledger). */
export class OpenAiWbtSuggestionResponder implements WbtSuggestionResponder {
  constructor(private readonly client: OpenAiResponsesTransport, private readonly model: string, readonly providerName = 'openai') {}

  async suggest(input: Record<string, unknown>): Promise<WbtAiAnswer> {
    const response = await this.client.responses.create({
      model: this.model,
      instructions: `${SYSTEM_INSTRUCTIONS}\n${patientAgeInstructionPl(patientAge((input.patient as { birth_year?: number | null } | undefined)?.birth_year, new Date()))}`,
      input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(input) }] }],
      text: { format: { type: 'json_schema', name: 'wbt_dose', strict: true, schema: WBT_SCHEMA } },
    }, { timeout: WBT_SUGGESTION_TIMEOUT_MS });
    return parseWbtAnswer(response);
  }
}

function parseWbtAnswer(response: Record<string, unknown>): WbtAiAnswer {
  // A cut-off reply may still parse (shortened JSON): never use it.
  if (response.status === 'incomplete') throw new Error('The model reply was cut off (incomplete)');
  const output = Array.isArray(response.output) ? (response.output as Array<Record<string, unknown>>) : [];
  const text = typeof response.output_text === 'string' && response.output_text
    ? response.output_text
    : output.filter((item) => item.type === 'message')
      .flatMap((item) => (Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : []))
      .filter((part) => part.type === 'output_text')
      .map((part) => String(part.text ?? ''))
      .join('');
  let parsed: Partial<WbtAiAnswer>;
  try {
    parsed = JSON.parse(text) as Partial<WbtAiAnswer>;
  } catch {
    throw new Error('WBT_SUGGESTION_INVALID_RESPONSE');
  }
  if (typeof parsed.dose_units !== 'number' || typeof parsed.rationale !== 'string') throw new Error('WBT_SUGGESTION_INVALID_RESPONSE');
  return {
    dose_units: parsed.dose_units,
    rationale: parsed.rationale.slice(0, 1200),
  };
}
