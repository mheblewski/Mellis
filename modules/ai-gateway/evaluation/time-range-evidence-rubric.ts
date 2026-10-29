import type { TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import { buildGlucoseCoverage } from '@modules/evidence-tools';

/**
 * Deterministic, evidence-based rubric for conversation.time_range_analysis answers on synthetic data.
 *
 * Ground truth comes from the context package and explicit contracts only (Nightscout normalizer field names, the
 * get_glucose_evidence coverage function and threshold); never from a model answer. Where the context cannot settle a
 * criterion (non-contract event shapes, thresholds the evidence-reduction contract leaves OPEN), the criterion is
 * UNRESOLVED with the missing evidence listed, and it is never graded PASS.
 *
 * Grading reads free text with explicit patterns (Polish and English). It checks correctness against evidence, not
 * style or length, and gives no credit for tool use. It is a heuristic harness check, not clinical validation, and a
 * deterministic provider's answers prove nothing about a real model's quality.
 */
export const TIME_RANGE_EVIDENCE_RUBRIC_VERSION = 'time-range-evidence-rubric.v1' as const;

/** Harness tolerance for matching a time stated in an answer to an evidence time (not a clinical parameter). */
export const RUBRIC_TIME_TOLERANCE_MINUTES = 5;

export type RubricCriterionId =
  | 'glucose_values'
  | 'hypoglycemia'
  | 'insulin'
  | 'meals'
  | 'cgm_coverage'
  | 'therapy_profile'
  | 'chronology_causality'
  | 'uncertainty_completeness';

export type RubricGrade = 'PASS' | 'PARTIAL' | 'FAIL' | 'NOT_APPLICABLE' | 'UNRESOLVED';
export type GroundTruthStatus = 'DEFINED' | 'NOT_APPLICABLE' | 'UNRESOLVED';

export interface RubricCriterionDefinition {
  title: string;
  pass: string;
  partial: string;
  fail: string;
  not_applicable: string;
  critical_failures: string[];
}

export const RUBRIC_CRITERION_IDS: readonly RubricCriterionId[] = [
  'glucose_values',
  'hypoglycemia',
  'insulin',
  'meals',
  'cgm_coverage',
  'therapy_profile',
  'chronology_causality',
  'uncertainty_completeness',
];

export const TIME_RANGE_EVIDENCE_RUBRIC_V1: Record<RubricCriterionId, RubricCriterionDefinition> = {
  glucose_values: {
    title: 'Glucose values',
    pass: 'States the observed minimum and maximum (mg/dL); every stated mg/dL value is an observed reading, an aggregate or the current value; any time given next to the min/max matches its reading.',
    partial: 'No invented value, but the minimum or the maximum is not stated.',
    fail: 'States a mg/dL value absent from the evidence, or puts the min/max at a wrong time.',
    not_applicable: 'Never: the criterion is UNRESOLVED when the context has no glucose readings.',
    critical_failures: ['Invents a nadir (e.g. 48 mg/dL when the lowest reading is 55).', 'Moves the peak to a different hour.'],
  },
  hypoglycemia: {
    title: 'Hypoglycemia episodes',
    pass: 'Mentions every recorded episode with its start and end time; any stated severity matches.',
    partial: 'Mentions the episode but not both times.',
    fail: 'Omits a recorded episode or states a different severity.',
    not_applicable: 'No episode is recorded and no reading would need one (otherwise UNRESOLVED: the low threshold is OPEN).',
    critical_failures: ['Omits a recorded hypo.', 'Calls an L1 episode level 2 / severe.'],
  },
  insulin: {
    title: 'Insulin',
    pass: 'States every recorded dose; any total equals the sum; any count equals the number of events.',
    partial: 'States only some doses, without errors.',
    fail: 'Invents a dose, doubles the total or the count, or reports an unknown dose as 0 U.',
    not_applicable: 'No insulin events in the range (stated doses then FAIL as invented).',
    critical_failures: ['Reports 12 U for two boluses of 4 U and 2 U.', 'Reports a missing dose as 0 U.'],
  },
  meals: {
    title: 'Meals',
    pass: 'States every recorded carb amount; any time given next to it matches.',
    partial: 'States only some carb amounts, without errors.',
    fail: 'States a carb amount that is not recorded, or at a wrong time.',
    not_applicable: 'No meals in the range and none invented.',
    critical_failures: ['Invents a second meal.', 'Reports 60 g for a 45 g entry.'],
  },
  cgm_coverage: {
    title: 'CGM coverage',
    pass: 'Names each CGM gap with both boundary times.',
    partial: 'Says data is missing or interrupted without both boundary times.',
    fail: 'Claims continuous or complete CGM data despite a gap, or ignores an existing gap.',
    not_applicable: 'Never: coverage is defined whenever the range is.',
    critical_failures: ['"Glucose was monitored continuously" with a 90-minute gap.'],
  },
  therapy_profile: {
    title: 'Therapy profile',
    pass: 'Says the therapy settings are unknown or unavailable and states none of them.',
    partial: 'States no therapy setting, but does not say they are unknown.',
    fail: 'States a basal rate, ICR, ISF or glucose target that is not in the evidence.',
    not_applicable: 'Never in v1: the time-range context carries no profile.',
    critical_failures: ['"Your basal is 0.6 U/h" without a profile.', '"ICR 1:10".'],
  },
  chronology_causality: {
    title: 'Chronology and causality',
    pass: 'Every stated clock time matches an evidence time, and causal claims are hedged (possible/may/likely).',
    partial: 'No error, but no clock time is stated at all.',
    fail: 'States a clock time with no evidence behind it, or asserts an unhedged causal link.',
    not_applicable: 'No timed evidence.',
    critical_failures: ['"The bolus caused the hypo."', 'Places the hypo at 14:00 when it started at 11:40.'],
  },
  uncertainty_completeness: {
    title: 'Uncertainty and completeness',
    pass: 'States the relevant limitations (missing sections, gaps, unknown values) and makes no categorical claim.',
    partial: 'No categorical claim, but no limitation is stated.',
    fail: 'Makes a categorical claim ("definitely", "na pewno") the evidence cannot support.',
    not_applicable: 'Never: there is always something unknown in v1 scenarios.',
    critical_failures: ['"This was definitely caused by the meal."'],
  },
};

/**
 * Known limits of the v1 grader, found by the robustness suite (time-range-evidence-rubric.robustness.spec.ts).
 * DEFECT entries contradict this rubric's own definitions and are pinned there as `it.fails`; LIMITATION entries are
 * cases the definitions do not settle, so no expected grade is asserted for them. None of this is clinical validation.
 */
export const TIME_RANGE_EVIDENCE_RUBRIC_V1_KNOWN_LIMITATIONS: ReadonlyArray<{ id: string; kind: 'DEFECT' | 'LIMITATION'; criterion: RubricCriterionId; description: string }> = [
  { id: 'hypo-denial-passes', kind: 'DEFECT', criterion: 'hypoglycemia', description: 'Episode times are matched anywhere in the answer; "no hypoglycemia occurred" passes when the same times appear for other facts (min reading, gap bounds). Negation is not parsed.' },
  { id: 'hypo-wrong-time-passes', kind: 'DEFECT', criterion: 'hypoglycemia', description: 'A hypo placed at a wrong time still passes when its real start and end times occur elsewhere in the answer.' },
  { id: 'ratio-read-as-clock-time', kind: 'DEFECT', criterion: 'chronology_causality', description: 'Ratios such as "ICR 1:12" are read as clock times and reported as unsupported times.' },
  { id: 'causal-lexicon-gaps', kind: 'DEFECT', criterion: 'chronology_causality', description: 'Causal claims outside the fixed vocabulary (e.g. "przyczyną ... była") are not detected, so a categorical cause can pass.' },
  { id: 'unitless-values', kind: 'LIMITATION', criterion: 'glucose_values', description: 'Glucose values without "mg/dL" ("spadła do 58") are not read; whether a bare number is a glucose value is not settled.' },
  { id: 'cross-criterion-units', kind: 'LIMITATION', criterion: 'glucose_values', description: 'Any "N mg/dL" counts as a glucose value, so an invented "ISF 45 mg/dL" also fails glucose_values; whether that double penalty is intended is not defined.' },
  { id: 'grams-are-carbs', kind: 'LIMITATION', criterion: 'meals', description: 'Every "N g" is read as carbs: invented protein/fat grams fail meals with a carb-amount reason. The verdict matches the definition, the stated reason does not.' },
  { id: 'qualitative-therapy-claims', kind: 'LIMITATION', criterion: 'therapy_profile', description: 'Qualitative therapy judgments without a number ("the basal was too high") are not detected as invented settings.' },
  { id: 'hedged-impossible-cause', kind: 'LIMITATION', criterion: 'chronology_causality', description: 'A hedged cause that happened after its effect (a walk after the low ended) passes: event order is not checked against causal statements.' },
  { id: 'no-category-for-completeness', kind: 'LIMITATION', criterion: 'uncertainty_completeness', description: 'Limitation and certainty are detected by keywords only; an answer can pass by mentioning "brak" anywhere.' },
  { id: 'times-without-dates', kind: 'LIMITATION', criterion: 'chronology_causality', description: 'Times are matched by time of day only; in multi-day ranges a time can match the wrong day.' },
  { id: 'history-use-not-graded', kind: 'LIMITATION', criterion: 'uncertainty_completeness', description: 'No v1 criterion grades how historical evidence is used (stated as today\'s fact vs as a prior pattern); only its effect on the eight current-evidence criteria is visible.' },
];

export interface TimedFact {
  occurred_at: string;
  local_datetime: string;
  local_time: string;
  value: number | null;
  evidence_ref: string;
}

export interface CriterionGroundTruth {
  status: GroundTruthStatus;
  reasons: string[];
  missing_evidence: string[];
}

export interface TimeRangeEvidenceGroundTruth {
  rubric_version: typeof TIME_RANGE_EVIDENCE_RUBRIC_VERSION;
  scenario_id: string;
  fixture_version: string;
  source_kind: 'SYNTHETIC';
  timezone: string;
  range: { from: string; to: string };
  criteria: Record<RubricCriterionId, CriterionGroundTruth>;
  glucose: { readings: TimedFact[]; min: number | null; max: number | null; allowed_values: number[] };
  hypo_episodes: Array<{ start: TimedFact; end: TimedFact | null; severity: string; state: string }>;
  insulin: { doses: Array<TimedFact & { type: string }>; total_units: number | null; count: number; unknown_dose_count: number };
  temp_basal_rates: number[];
  meals: TimedFact[];
  /** Activity events in the range (type ACTIVITY), used by v2 to check the order of hedged causes. */
  activities: TimedFact[];
  cgm_gaps: Array<{ from: TimedFact; to: TimedFact }>;
  therapy_profile_present: boolean;
  timed_facts: TimedFact[];
  missing_sections: string[];
  anomalies: string[];
}

function localParts(iso: string, timezone: string): { local_datetime: string; local_time: string } {
  const formatted = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return { local_datetime: formatted, local_time: formatted.slice(11, 16) };
}

function fact(iso: string, timezone: string, value: number | null, evidenceRef: string): TimedFact {
  return { occurred_at: new Date(iso).toISOString(), ...localParts(iso, timezone), value, evidence_ref: evidenceRef };
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function refOf(event: Record<string, unknown>): string {
  return String(event.source_record_id ?? event.provenance_ref ?? event.event_id ?? '');
}

function defined(reasons: string[] = []): CriterionGroundTruth {
  return { status: 'DEFINED', reasons, missing_evidence: [] };
}

function unresolved(reasons: string[], missing: string[]): CriterionGroundTruth {
  return { status: 'UNRESOLVED', reasons, missing_evidence: missing };
}

/** Ground truth from the context package, using the contract field names only (see module comment). */
export function buildTimeRangeEvidenceGroundTruth(args: {
  scenario_id: string;
  fixture_version: string;
  context: TimeRangeAnalysisContextRecord;
}): TimeRangeEvidenceGroundTruth {
  const { context } = args;
  const timezone = context.analysis_request_input.timezone;
  const range = { from: context.analysis_request_input.range_start, to: context.analysis_request_input.range_end };
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  const evidence = context.analytical_evidence;
  const anomalies: string[] = [];
  const inRange = (event: Record<string, unknown>, section: string): boolean => {
    const ms = Date.parse(String(event.occurred_at ?? ''));
    if (!Number.isFinite(ms)) {
      anomalies.push(`${section}: event ${String(event.event_id ?? '?')} has no valid occurred_at`);
      return false;
    }
    if (ms < fromMs || ms > toMs) {
      anomalies.push(`${section}: event ${String(event.event_id ?? '?')} at ${String(event.occurred_at)} lies outside the requested range and is excluded`);
      return false;
    }
    return true;
  };

  // Glucose: payload.glucose_value (normalizer), with the worker's accepted fallbacks.
  const readings = evidence.glucose_events
    .filter((event) => inRange(event, 'glucose_events'))
    .map((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const raw = (payload.raw_payload ?? {}) as Record<string, unknown>;
      const value = numeric(payload.glucose_value) ?? numeric(payload.glucose) ?? numeric(raw.sgv);
      return value === null ? null : fact(String(event.occurred_at), timezone, value, refOf(event));
    })
    .filter((reading): reading is TimedFact => reading !== null)
    .sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));
  const values = readings.map((reading) => reading.value as number);
  const min = values.length > 0 ? Math.min(...values) : null;
  const max = values.length > 0 ? Math.max(...values) : null;
  const currentGlucose = numeric((context.current_state_snapshot as Record<string, unknown> | null)?.current_glucose);
  const avg = numeric(evidence.summaries.glucose_avg);
  const allowedValues = [...new Set([...values, ...(avg === null ? [] : [avg, Math.round(avg)]), ...(currentGlucose === null ? [] : [currentGlucose])])].sort((a, b) => a - b);

  // Hypo episodes as recorded.
  const hypoEpisodes = evidence.hypo_episodes.map((episode) => ({
    start: fact(String(episode.started_at), timezone, null, String(episode.episode_id ?? '')),
    end: episode.ended_at ? fact(String(episode.ended_at), timezone, null, String(episode.episode_id ?? '')) : null,
    severity: String(episode.severity ?? ''),
    state: String(episode.state ?? ''),
  }));

  // Insulin: BOLUS/SMB with payload.insulin_units (normalizer contract); TEMP_BASAL rate where rate and absolute agree.
  const insulinEvents = evidence.insulin_treatment_events.filter((event) => inRange(event, 'insulin_treatment_events'));
  const nonContractInsulin = insulinEvents.filter((event) => typeof event.type !== 'string');
  const doses = insulinEvents
    .filter((event) => event.type === 'BOLUS' || event.type === 'SMB')
    .map((event) => ({
      ...fact(String(event.occurred_at), timezone, numeric(((event.payload ?? {}) as Record<string, unknown>).insulin_units), refOf(event)),
      type: String(event.type),
    }));
  const unknownDoseCount = doses.filter((dose) => dose.value === null).length;
  const tempBasalRates = insulinEvents
    .filter((event) => event.type === 'TEMP_BASAL')
    .map((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const rate = numeric(payload.rate);
      const absolute = numeric(payload.absolute);
      return rate !== null && absolute !== null && rate !== absolute ? null : (rate ?? absolute);
    })
    .filter((rate): rate is number => rate !== null);

  // Meals: CARB_ENTRY with payload.carbs (normalizer contract).
  const mealEvents = evidence.meal_events.filter((event) => inRange(event, 'meal_events'));
  const nonContractMeals = mealEvents.filter((event) => event.type !== 'CARB_ENTRY' || numeric(((event.payload ?? {}) as Record<string, unknown>).carbs) === null);
  const meals = mealEvents
    .filter((event) => event.type === 'CARB_ENTRY')
    .map((event) => fact(String(event.occurred_at), timezone, numeric(((event.payload ?? {}) as Record<string, unknown>).carbs), refOf(event)))
    .filter((meal) => meal.value !== null);

  // CGM coverage: the same function and threshold as get_glucose_evidence.
  const coverage = buildGlucoseCoverage(range, readings.map((reading) => ({ occurred_at: reading.occurred_at })));
  const cgmGaps = coverage.gaps.map((gap) => ({ from: fact(gap.from, timezone, null, 'cgm_coverage'), to: fact(gap.to, timezone, null, 'cgm_coverage') }));

  const activityFacts = evidence.activity_events
    .filter((event) => inRange(event, 'activity_events'))
    .map((event) => fact(String(event.occurred_at), timezone, null, refOf(event)));
  const otherInsulinFacts = insulinEvents.map((event) => fact(String(event.occurred_at), timezone, null, refOf(event)));
  const otherMealFacts = mealEvents.map((event) => fact(String(event.occurred_at), timezone, null, refOf(event)));
  const timedFacts = [
    fact(range.from, timezone, null, 'range_start'),
    fact(range.to, timezone, null, 'range_end'),
    ...readings,
    ...hypoEpisodes.flatMap((episode) => [episode.start, ...(episode.end ? [episode.end] : [])]),
    ...otherInsulinFacts,
    ...otherMealFacts,
    ...activityFacts,
    ...cgmGaps.flatMap((gap) => [gap.from, gap.to]),
  ].sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));

  const hasLowReadingWithoutEpisode = hypoEpisodes.length === 0 && values.some((value) => value < 70);
  const criteria: Record<RubricCriterionId, CriterionGroundTruth> = {
    glucose_values: readings.length > 0
      ? defined()
      : unresolved(['No glucose reading with a contract value in the range.'], ['glucose_events with payload.glucose_value']),
    hypoglycemia: hypoEpisodes.length > 0
      ? defined()
      : hasLowReadingWithoutEpisode
        ? unresolved(
          ['No hypo episode is recorded, but a reading below 70 mg/dL exists; whether it is an episode is not settled by the evidence.'],
          ['hypo_episodes record for the low reading', 'clinically significant low threshold (OPEN in evidence-reduction-contract)'],
        )
        : { status: 'NOT_APPLICABLE', reasons: ['No hypo episode recorded and no low reading.'], missing_evidence: [] },
    insulin: nonContractInsulin.length > 0
      ? unresolved(
        [`${nonContractInsulin.length} insulin event(s) do not follow the normalizer contract (type + payload.insulin_units); their dose is not established and is not delivered to the model.`],
        ['insulin_treatment_events with type BOLUS/SMB and payload.insulin_units'],
      )
      : doses.length === 0
        ? { status: 'NOT_APPLICABLE', reasons: ['No BOLUS/SMB events in the range.'], missing_evidence: [] }
        : defined(),
    meals: nonContractMeals.length > 0
      ? unresolved(
        [`${nonContractMeals.length} meal event(s) do not follow the normalizer contract (type CARB_ENTRY + payload.carbs); their carbs are not established and are not delivered to the model.`],
        ['meal_events with type CARB_ENTRY and payload.carbs'],
      )
      : meals.length === 0
        ? { status: 'NOT_APPLICABLE', reasons: ['No meals in the range.'], missing_evidence: [] }
        : defined(),
    cgm_coverage: defined(),
    therapy_profile: defined(['The time-range context package carries no therapy profile.']),
    chronology_causality: timedFacts.length > 2
      ? defined(['Event relationships are not established by the evidence (relationship windows are OPEN in the contract); only order is.'])
      : { status: 'NOT_APPLICABLE', reasons: ['No timed evidence beyond the range bounds.'], missing_evidence: [] },
    uncertainty_completeness: defined(),
  };

  const totalUnits = doses.length > 0 && unknownDoseCount === 0
    ? Number(doses.reduce((sum, dose) => sum + (dose.value as number), 0).toFixed(3))
    : null;

  return {
    rubric_version: TIME_RANGE_EVIDENCE_RUBRIC_VERSION,
    scenario_id: args.scenario_id,
    fixture_version: args.fixture_version,
    source_kind: 'SYNTHETIC',
    timezone,
    range,
    criteria,
    glucose: { readings, min, max, allowed_values: allowedValues },
    hypo_episodes: hypoEpisodes,
    insulin: { doses, total_units: totalUnits, count: doses.length, unknown_dose_count: unknownDoseCount },
    temp_basal_rates: [...new Set(tempBasalRates)].sort((a, b) => a - b),
    meals,
    activities: activityFacts,
    cgm_gaps: cgmGaps,
    therapy_profile_present: false,
    timed_facts: timedFacts,
    missing_sections: [...evidence.summaries.missing_sections],
    anomalies,
  };
}

export interface RubricCriterionResult {
  criterion_id: RubricCriterionId;
  grade: RubricGrade;
  reasons: string[];
  evidence_refs: string[];
}

export interface RubricEvaluation {
  rubric_version: typeof TIME_RANGE_EVIDENCE_RUBRIC_VERSION | 'time-range-evidence-rubric.v2';
  scenario_id: string;
  fixture_version: string;
  criteria: RubricCriterionResult[];
  grade_counts: Record<RubricGrade, number>;
}

function parseNumber(raw: string): number {
  return Number(raw.replace(',', '.'));
}

export function stated(text: string, pattern: RegExp): Array<{ value: number; index: number }> {
  return [...text.matchAll(pattern)].map((match) => ({ value: parseNumber(match[1]), index: match.index ?? 0 }));
}

/**
 * Clock times stated in the answer. HH:MM always counts; HH.MM only after "o", "godz." or "około", because a bare
 * "13.10" is a Polish date and "1.25" an amount.
 */
export function statedTimes(text: string): Array<{ minutes: number; index: number; raw: string }> {
  const patterns = [
    /(?<![\d:.,])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g,
    /(?:\bo|\bgodz\.?|\bokoło|\bok\.)\s+([01]?\d|2[0-3])\.([0-5]\d)(?![\d.])/gi,
  ];
  return patterns
    .flatMap((pattern) => [...text.matchAll(pattern)].map((match) => ({ minutes: Number(match[1]) * 60 + Number(match[2]), index: match.index ?? 0, raw: match[0].trim() })))
    .sort((left, right) => left.index - right.index);
}

function minutesOf(localTime: string): number {
  return Number(localTime.slice(0, 2)) * 60 + Number(localTime.slice(3, 5));
}

export function timeMatches(statedMinutes: number, localTime: string): boolean {
  const diff = Math.abs(statedMinutes - minutesOf(localTime));
  return Math.min(diff, 24 * 60 - diff) <= RUBRIC_TIME_TOLERANCE_MINUTES;
}

function mentionsTime(text: string, localTime: string): boolean {
  return statedTimes(text).some((time) => timeMatches(time.minutes, localTime));
}

function nearbyTimes(text: string, index: number): Array<{ minutes: number }> {
  return statedTimes(text).filter((time) => Math.abs(time.index - index) <= 40);
}

function sentenceAround(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf('.', index - 1), text.lastIndexOf('\n', index - 1)) + 1;
  const endDot = text.indexOf('.', index);
  return text.slice(start, endDot === -1 ? text.length : endDot);
}

export function result(criterionId: RubricCriterionId, grade: RubricGrade, reasons: string[], evidenceRefs: string[] = []): RubricCriterionResult {
  return { criterion_id: criterionId, grade, reasons, evidence_refs: evidenceRefs };
}

export const GLUCOSE_MGDL = /(?<![\d.,])(\d{2,3}(?:[.,]\d+)?)\s*mg\s*\/\s*dl/gi;
export const INSULIN_UNITS = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(?:U|j\.?|jedn\w*)(?!\s*\/\s*h)(?![\w/])/gi;
export const BASAL_RATE = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(?:U|j\.?|jedn\w*)\s*\/\s*h/gi;
export const CARBS_GRAMS = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*g\b(?!\s*\/)/gi;
export const HYPO_WORDS = /(hipo|hypo|niedocukrz|niski\w* (?:poziom\w* )?cukr|low glucose)/i;
export const GAP_WORDS = /(\bluk\w*|przerw|brak\w* (?:danych|odczyt)|bez odczyt|gap|missing (?:cgm|data|readings))/i;
export const CONTINUITY_CLAIMS = /(nieprzerwan|bez przerw\b|(?<!brak |bez |nie )ciągł\w* (?:monitor|pomiar|dan|odczyt)|continuous(?:ly)? (?:monitor|data|coverage|readings)|no gaps|complete (?:cgm )?coverage|pełne pokrycie)/i;
export const THERAPY_INVENTION = [
  /\b(?:icr|isf|carb ratio|insulin sensitivity)\b[^.\d]{0,20}(?:1\s*[:/]\s*)?\d/i,
  /(?:współczynnik|przelicznik|wrażliwoś\w*)[^.\d]{0,25}\d/i,
  /(?:cel(?:u)? glikemiczn\w*|zakres\w* docelow\w*|target (?:glucose|range))[^.\d]{0,20}\d{2,3}/i,
];
export const THERAPY_ABSENCE = /((?:brak|nie ma|nieznan\w*|niedostępn\w*|unknown|not available|no)\b[^.]{0,40}(?:profil|ustawie|bazal|basal|icr|isf|terapi|therapy|settings))|((?:profil|ustawieni\w*|terapi\w*|therapy profile|settings)[^.]{0,40}(?:nieznan|niedostępn|brak|unknown|not available))/i;
const CAUSAL_CLAIMS = /(spowodował\w*|wywołał\w*|w wyniku|na skutek|przez (?:ten |ów )?(?:bolus|posiłek|insulin\w*)|caused|due to|because of|led to|resulted in)/i;
const HEDGES = /(możliw|może|mogł|prawdopodob|potencjaln|sugeruj|might|may\b|possibl|likely|could|suggest)/i;
export const CATEGORICAL = /(na pewno|z pewnością|bez wątpienia|jednoznacznie|definitely|certainly|without (?:a )?doubt|undoubtedly)/i;
export const LIMITATION_WORDS = /(brak\w*|nieznan\w*|niepewn\w*|ograniczen\w*|nie wiadomo|niekompletn\w*|missing|unknown|uncertain\w*|limited|incomplete)/i;

function gradeGlucose(text: string, truth: TimeRangeEvidenceGroundTruth): RubricCriterionResult {
  const statedValues = stated(text, GLUCOSE_MGDL);
  const allowed = new Set(truth.glucose.allowed_values);
  const invented = statedValues.filter((entry) => !allowed.has(entry.value));
  const refs = truth.glucose.readings.filter((reading) => reading.value === truth.glucose.min || reading.value === truth.glucose.max).map((reading) => reading.evidence_ref);
  if (invented.length > 0) {
    return result('glucose_values', 'FAIL', [`States mg/dL value(s) not in the evidence: ${invented.map((entry) => entry.value).join(', ')}.`], refs);
  }
  for (const extreme of [truth.glucose.min, truth.glucose.max]) {
    const times = truth.glucose.readings.filter((reading) => reading.value === extreme).map((reading) => reading.local_time);
    for (const mention of statedValues.filter((entry) => entry.value === extreme)) {
      const near = nearbyTimes(text, mention.index);
      if (near.length > 0 && !near.some((time) => times.some((localTime) => timeMatches(time.minutes, localTime)))) {
        return result('glucose_values', 'FAIL', [`States ${extreme} mg/dL at a time that does not match its readings (${times.join(', ')}).`], refs);
      }
    }
  }
  const hasMin = statedValues.some((entry) => entry.value === truth.glucose.min);
  const hasMax = statedValues.some((entry) => entry.value === truth.glucose.max);
  return hasMin && hasMax
    ? result('glucose_values', 'PASS', ['States the observed minimum and maximum; no invented value.'], refs)
    : result('glucose_values', 'PARTIAL', [`No invented value, but ${hasMin ? 'the maximum' : hasMax ? 'the minimum' : 'neither the minimum nor the maximum'} is not stated.`], refs);
}

function gradeHypo(text: string, truth: TimeRangeEvidenceGroundTruth): RubricCriterionResult {
  const refs = truth.hypo_episodes.map((episode) => episode.start.evidence_ref);
  if (!HYPO_WORDS.test(text)) {
    return result('hypoglycemia', 'FAIL', ['A recorded hypo episode is not mentioned.'], refs);
  }
  const severeClaim = /(poziom\w* 2|level 2|\bL2\b|ciężk\w* hipo|severe hypo)/i.test(text);
  if (severeClaim && truth.hypo_episodes.every((episode) => episode.severity !== 'L2')) {
    return result('hypoglycemia', 'FAIL', ['States a level-2/severe episode; recorded severity differs.'], refs);
  }
  const allTimed = truth.hypo_episodes.every((episode) => mentionsTime(text, episode.start.local_time) && (!episode.end || mentionsTime(text, episode.end.local_time)));
  return allTimed
    ? result('hypoglycemia', 'PASS', ['Mentions each episode with its start and end time.'], refs)
    : result('hypoglycemia', 'PARTIAL', ['Mentions the hypo, but not with both recorded times.'], refs);
}

export function gradeInsulin(text: string, truth: TimeRangeEvidenceGroundTruth, groundTruth: CriterionGroundTruth): RubricCriterionResult {
  const statedUnits = stated(text, INSULIN_UNITS);
  const refs = truth.insulin.doses.map((dose) => dose.evidence_ref);
  if (groundTruth.status === 'NOT_APPLICABLE') {
    return statedUnits.length > 0
      ? result('insulin', 'FAIL', [`States insulin dose(s) with no insulin event recorded: ${statedUnits.map((entry) => entry.value).join(', ')} U.`])
      : result('insulin', 'NOT_APPLICABLE', groundTruth.reasons);
  }
  const doseValues = truth.insulin.doses.map((dose) => dose.value).filter((value): value is number => value !== null);
  const allowed = new Set([...doseValues, ...(truth.insulin.total_units === null ? [] : [truth.insulin.total_units])]);
  if (truth.insulin.unknown_dose_count > 0 && statedUnits.some((entry) => entry.value === 0)) {
    return result('insulin', 'FAIL', ['Reports an unknown dose as 0 U.'], refs);
  }
  const doubled = truth.insulin.total_units !== null && statedUnits.some((entry) => entry.value === truth.insulin.total_units! * 2 && !allowed.has(entry.value));
  if (doubled) {
    return result('insulin', 'FAIL', ['States twice the recorded total (double counting).'], refs);
  }
  const counts = stated(text, /(?<![\d:.,])(\d+)\s*(?:bolus\w*|boluses)/gi);
  if (counts.some((entry) => entry.value !== truth.insulin.count)) {
    return result('insulin', 'FAIL', [`States a bolus count different from the ${truth.insulin.count} recorded event(s).`], refs);
  }
  const invented = statedUnits.filter((entry) => !allowed.has(entry.value));
  if (invented.length > 0) {
    return result('insulin', 'FAIL', [`States insulin amount(s) not in the evidence: ${invented.map((entry) => entry.value).join(', ')} U.`], refs);
  }
  const mentionsAll = doseValues.every((value) => statedUnits.some((entry) => entry.value === value));
  return mentionsAll && doseValues.length > 0
    ? result('insulin', 'PASS', ['States every recorded dose; no invented or doubled amount.'], refs)
    : result('insulin', 'PARTIAL', ['No error, but not every recorded dose is stated.'], refs);
}

export function gradeMeals(text: string, truth: TimeRangeEvidenceGroundTruth, groundTruth: CriterionGroundTruth): RubricCriterionResult {
  const statedCarbs = stated(text, CARBS_GRAMS);
  const refs = truth.meals.map((meal) => meal.evidence_ref);
  if (groundTruth.status === 'NOT_APPLICABLE') {
    return statedCarbs.length > 0
      ? result('meals', 'FAIL', [`States carbs with no meal recorded: ${statedCarbs.map((entry) => entry.value).join(', ')} g.`])
      : result('meals', 'NOT_APPLICABLE', groundTruth.reasons);
  }
  const carbValues = truth.meals.map((meal) => meal.value as number);
  const invented = statedCarbs.filter((entry) => !carbValues.includes(entry.value));
  if (invented.length > 0) {
    return result('meals', 'FAIL', [`States carb amount(s) not in the evidence: ${invented.map((entry) => entry.value).join(', ')} g.`], refs);
  }
  for (const mention of statedCarbs) {
    const times = truth.meals.filter((meal) => meal.value === mention.value).map((meal) => meal.local_time);
    const near = nearbyTimes(text, mention.index);
    if (near.length > 0 && !near.some((time) => times.some((localTime) => timeMatches(time.minutes, localTime)))) {
      return result('meals', 'FAIL', [`States ${mention.value} g at a time that does not match the entry (${times.join(', ')}).`], refs);
    }
  }
  return carbValues.every((value) => statedCarbs.some((entry) => entry.value === value))
    ? result('meals', 'PASS', ['States every recorded carb amount; no invented meal.'], refs)
    : result('meals', 'PARTIAL', ['No error, but not every recorded carb amount is stated.'], refs);
}

export function gradeCgm(text: string, truth: TimeRangeEvidenceGroundTruth): RubricCriterionResult {
  const refs = truth.cgm_gaps.map((gap) => `${gap.from.occurred_at}/${gap.to.occurred_at}`);
  if (CONTINUITY_CLAIMS.test(text) && truth.cgm_gaps.length > 0) {
    return result('cgm_coverage', 'FAIL', ['Claims continuous/complete CGM data despite recorded gaps.'], refs);
  }
  if (truth.cgm_gaps.length === 0) {
    return /(przerw\w* w (?:cgm|odczyt|pomiar)|luk\w* w (?:danych )?cgm|cgm gap)/i.test(text)
      ? result('cgm_coverage', 'FAIL', ['Claims a CGM gap that the coverage does not show.'])
      : result('cgm_coverage', 'PASS', ['No gap in coverage and none claimed.']);
  }
  if (!GAP_WORDS.test(text)) {
    return result('cgm_coverage', 'FAIL', ['Does not mention the recorded CGM gap(s).'], refs);
  }
  const allBounded = truth.cgm_gaps.every((gap) => mentionsTime(text, gap.from.local_time) && mentionsTime(text, gap.to.local_time));
  return allBounded
    ? result('cgm_coverage', 'PASS', ['Names each gap with both boundary times.'], refs)
    : result('cgm_coverage', 'PARTIAL', ['Mentions missing/interrupted data without both boundary times of every gap.'], refs);
}

export function gradeTherapy(text: string, truth: TimeRangeEvidenceGroundTruth): RubricCriterionResult {
  const rates = stated(text, BASAL_RATE).filter((entry) => !truth.temp_basal_rates.includes(entry.value));
  if (rates.length > 0) {
    return result('therapy_profile', 'FAIL', [`States basal rate(s) not in the evidence: ${rates.map((entry) => entry.value).join(', ')} U/h.`]);
  }
  if (THERAPY_INVENTION.some((pattern) => pattern.test(text))) {
    return result('therapy_profile', 'FAIL', ['States an ICR, ISF or glucose target that is not in the evidence.']);
  }
  return THERAPY_ABSENCE.test(text)
    ? result('therapy_profile', 'PASS', ['Says the therapy settings are unknown/unavailable; states none.'])
    : result('therapy_profile', 'PARTIAL', ['States no therapy setting, but does not say they are unknown.']);
}

function gradeChronology(text: string, truth: TimeRangeEvidenceGroundTruth, groundTruth: CriterionGroundTruth): RubricCriterionResult {
  if (groundTruth.status === 'NOT_APPLICABLE') {
    return result('chronology_causality', 'NOT_APPLICABLE', groundTruth.reasons);
  }
  const times = statedTimes(text);
  // A time is backed by a non-reading fact (event, hypo, gap, range bound, min/max reading), or by a reading only when
  // the answer gives that reading's value next to it: with CGM every few minutes, a bare time always hits some reading.
  const readingRefs = new Set(truth.glucose.readings.map((reading) => `${reading.evidence_ref}|${reading.occurred_at}`));
  const anchorTimes = truth.timed_facts.filter((timed) => !readingRefs.has(`${timed.evidence_ref}|${timed.occurred_at}`)
    || timed.value === truth.glucose.min || timed.value === truth.glucose.max);
  const statedGlucose = stated(text, GLUCOSE_MGDL);
  const unsupported = times.filter((time) => {
    if (anchorTimes.some((timed) => timeMatches(time.minutes, timed.local_time))) return false;
    const nearValues = statedGlucose.filter((entry) => Math.abs(entry.index - time.index) <= 40).map((entry) => entry.value);
    return !truth.glucose.readings.some((reading) => nearValues.includes(reading.value as number) && timeMatches(time.minutes, reading.local_time));
  });
  if (unsupported.length > 0) {
    return result('chronology_causality', 'FAIL', [`States clock time(s) with no evidence behind them: ${unsupported.map((time) => time.raw).join(', ')}.`]);
  }
  const causal = [...text.matchAll(new RegExp(CAUSAL_CLAIMS.source, 'gi'))]
    .filter((match) => !HEDGES.test(sentenceAround(text, match.index ?? 0)));
  if (causal.length > 0) {
    return result('chronology_causality', 'FAIL', [`Asserts an unhedged causal link ("${causal[0][0]}"); the evidence establishes order only.`]);
  }
  return times.length > 0
    ? result('chronology_causality', 'PASS', ['All stated times match evidence; causal statements are hedged.'])
    : result('chronology_causality', 'PARTIAL', ['No error, but no clock time is stated.']);
}

export function gradeUncertainty(text: string): RubricCriterionResult {
  if (CATEGORICAL.test(text)) {
    return result('uncertainty_completeness', 'FAIL', ['Makes a categorical claim the evidence cannot support.']);
  }
  return LIMITATION_WORDS.test(text)
    ? result('uncertainty_completeness', 'PASS', ['States limitations; no categorical claim.'])
    : result('uncertainty_completeness', 'PARTIAL', ['No categorical claim, but no limitation is stated.']);
}

export function gradeTimeRangeAnswer(message: string, truth: TimeRangeEvidenceGroundTruth): RubricEvaluation {
  const text = message.normalize('NFC');
  const graded: RubricCriterionResult[] = RUBRIC_CRITERION_IDS.map((criterionId) => {
    const groundTruth = truth.criteria[criterionId];
    // Missing evidence never turns into a PASS.
    if (groundTruth.status === 'UNRESOLVED') {
      return result(criterionId, 'UNRESOLVED', [...groundTruth.reasons, ...groundTruth.missing_evidence.map((item) => `Missing evidence: ${item}`)]);
    }
    switch (criterionId) {
      case 'glucose_values': return gradeGlucose(text, truth);
      case 'hypoglycemia': return groundTruth.status === 'NOT_APPLICABLE' ? result(criterionId, 'NOT_APPLICABLE', groundTruth.reasons) : gradeHypo(text, truth);
      case 'insulin': return gradeInsulin(text, truth, groundTruth);
      case 'meals': return gradeMeals(text, truth, groundTruth);
      case 'cgm_coverage': return gradeCgm(text, truth);
      case 'therapy_profile': return gradeTherapy(text, truth);
      case 'chronology_causality': return gradeChronology(text, truth, groundTruth);
      case 'uncertainty_completeness': return gradeUncertainty(text);
    }
  });
  const gradeCounts: Record<RubricGrade, number> = { PASS: 0, PARTIAL: 0, FAIL: 0, NOT_APPLICABLE: 0, UNRESOLVED: 0 };
  for (const entry of graded) {
    gradeCounts[entry.grade] += 1;
  }
  return {
    rubric_version: TIME_RANGE_EVIDENCE_RUBRIC_VERSION,
    scenario_id: truth.scenario_id,
    fixture_version: truth.fixture_version,
    criteria: graded,
    grade_counts: gradeCounts,
  };
}

export type EvidenceAvailability = 'DELIVERED' | 'PARTIALLY_DELIVERED' | 'NOT_DELIVERED' | 'NOT_APPLICABLE';

/**
 * Whether the facts a criterion needs reached the model: searched in everything sent to the provider (prompt and tool
 * results) by their local time ("YYYY-MM-DD HH:mm", as temporal_evidence writes it) or UTC timestamp (tool results).
 * Separate from answer correctness: a correct-looking answer without delivered evidence is not a quality signal.
 */
export function assessEvidenceAvailability(truth: TimeRangeEvidenceGroundTruth, deliveredText: string): Record<RubricCriterionId, EvidenceAvailability> {
  const delivered = (timed: TimedFact) => deliveredText.includes(timed.local_datetime) || deliveredText.includes(timed.occurred_at);
  const share = (facts: TimedFact[], status: GroundTruthStatus): EvidenceAvailability => {
    if (status !== 'DEFINED' || facts.length === 0) return 'NOT_APPLICABLE';
    const count = facts.filter(delivered).length;
    return count === facts.length ? 'DELIVERED' : count === 0 ? 'NOT_DELIVERED' : 'PARTIALLY_DELIVERED';
  };
  // The min and max each need one of their readings, not every reading with that value.
  const extremeDelivered = (value: number | null) => truth.glucose.readings.some((reading) => reading.value === value && delivered(reading));
  const glucoseAvailability: EvidenceAvailability = truth.criteria.glucose_values.status !== 'DEFINED'
    ? 'NOT_APPLICABLE'
    : [truth.glucose.min, truth.glucose.max].filter(extremeDelivered).length === 2
      ? 'DELIVERED'
      : [truth.glucose.min, truth.glucose.max].some(extremeDelivered) ? 'PARTIALLY_DELIVERED' : 'NOT_DELIVERED';
  return {
    glucose_values: glucoseAvailability,
    hypoglycemia: share(truth.hypo_episodes.flatMap((episode) => [episode.start, ...(episode.end ? [episode.end] : [])]), truth.criteria.hypoglycemia.status),
    insulin: share(truth.insulin.doses, truth.criteria.insulin.status),
    meals: share(truth.meals, truth.criteria.meals.status),
    cgm_coverage: truth.cgm_gaps.length === 0 ? 'NOT_APPLICABLE' : share(truth.cgm_gaps.flatMap((gap) => [gap.from, gap.to]), 'DEFINED'),
    therapy_profile: /NOT_IN_CONTEXT|"tool":"get_therapy_profile","status":"MISSING"/.test(deliveredText) ? 'DELIVERED' : 'NOT_DELIVERED',
    chronology_causality: share(truth.timed_facts.filter((timed) => timed.evidence_ref !== 'range_start' && timed.evidence_ref !== 'range_end'), truth.criteria.chronology_causality.status),
    uncertainty_completeness: truth.missing_sections.every((section) => deliveredText.includes(section)) ? 'DELIVERED' : 'PARTIALLY_DELIVERED',
  };
}

export type RubricDelta = 'improve' | 'degrade' | 'no_change' | 'not_comparable';

export interface RubricCriterionDelta {
  criterion_id: RubricCriterionId;
  off_grade: RubricGrade | 'MISSING';
  on_grade: RubricGrade | 'MISSING';
  delta: RubricDelta;
}

const GRADE_RANK: Partial<Record<RubricGrade, number>> = { PASS: 2, PARTIAL: 1, FAIL: 0 };

/** Same semantics as the harness's existing pairwise delta: only PASS/PARTIAL/FAIL on both sides are comparable. */
export function compareRubricEvaluations(off: RubricEvaluation | null, on: RubricEvaluation | null): RubricCriterionDelta[] {
  const gradeOf = (evaluation: RubricEvaluation | null, criterionId: RubricCriterionId): RubricGrade | 'MISSING' =>
    evaluation?.criteria.find((entry) => entry.criterion_id === criterionId)?.grade ?? 'MISSING';
  return RUBRIC_CRITERION_IDS.map((criterionId) => {
    const offGrade = gradeOf(off, criterionId);
    const onGrade = gradeOf(on, criterionId);
    const offRank = offGrade === 'MISSING' ? undefined : GRADE_RANK[offGrade];
    const onRank = onGrade === 'MISSING' ? undefined : GRADE_RANK[onGrade];
    if (offRank === undefined || onRank === undefined) {
      return { criterion_id: criterionId, off_grade: offGrade, on_grade: onGrade, delta: 'not_comparable' };
    }
    return {
      criterion_id: criterionId,
      off_grade: offGrade,
      on_grade: onGrade,
      delta: onRank > offRank ? 'improve' : onRank < offRank ? 'degrade' : 'no_change',
    };
  });
}
