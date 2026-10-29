import { describe, expect, it } from 'vitest';
import type { TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import {
  buildTimeRangeEvidenceGroundTruth,
  gradeTimeRangeAnswer,
  RUBRIC_CRITERION_IDS,
  type RubricCriterionId,
  type RubricGrade,
} from './time-range-evidence-rubric';
import {
  causalClaims,
  clockTimes,
  gradeTimeRangeAnswerV2,
  parseClauses,
  TIME_RANGE_EVIDENCE_RUBRIC_V2,
  TIME_RANGE_EVIDENCE_RUBRIC_V2_KNOWN_LIMITATIONS,
  TIME_RANGE_EVIDENCE_RUBRIC_V2_VERSION,
} from './time-range-evidence-rubric-v2';
import { createHistoryComparisonScenarios, runHistoryEvidenceComparisonExperiment } from './time-range-quality-cost-experiment';

// Robustness of time-range-evidence-rubric.v2. Ground truth: history-comparison-scenarios.v2, pair-01 (identical in
// all seven pairs), via the shared ground-truth builder. Expected grades follow the v2 contract
// (TIME_RANGE_EVIDENCE_RUBRIC_V2). Answers are hand-written; local times are Europe/Warsaw (CEST):
// readings 11:12 = 128, 11:42 = 67, 12:02 = 92; meal 11:02 (38 g); bolus 11:08 (1.6 U); meal 12:25 (18 g);
// walk 12:10; hypo L1 11:42-12:02; CGM gaps 11:12-11:42, 11:42-12:02, 12:02-14:30.

const scenario = createHistoryComparisonScenarios()[0];
const truthFor = (context: TimeRangeAnalysisContextRecord) =>
  buildTimeRangeEvidenceGroundTruth({ scenario_id: scenario.scenario_id, fixture_version: scenario.fixture_version, context });
const truth = truthFor(scenario.base_context);

const PART = {
  glucose: 'Glukoza wahała się od 67 mg/dL (o 11:42) do 128 mg/dL (o 11:12).',
  meals: 'O 11:02 zapisano 38 g węglowodanów, o 11:08 bolus 1,6 U, a o 12:25 kolejne 18 g.',
  hypo: 'Między 11:42 a 12:02 wystąpił epizod hipoglikemii L1.',
  cgm: 'Odczyty CGM są rzadkie: luki od 11:12 do 11:42, od 11:42 do 12:02 oraz od 12:02 do 14:30.',
  therapy: 'Brak profilu terapii, więc ustawienia bazalu, ICR i ISF są nieznane. O 12:10 zapisano spacer.',
  causality: 'Kolejność zdarzeń nie dowodzi związku przyczynowego; bolus mógł przyczynić się do spadku, ale to niepotwierdzone.',
};
const answer = (overrides: Partial<Record<keyof typeof PART, string | null>> = {}, extra: string[] = []) =>
  [...(Object.keys(PART) as Array<keyof typeof PART>).map((key) => (key in overrides ? overrides[key] : PART[key])), ...extra]
    .filter((part): part is string => Boolean(part))
    .join(' ');
const grades = (text: string, groundTruth = truth): Record<RubricCriterionId, RubricGrade> =>
  Object.fromEntries(gradeTimeRangeAnswerV2(text, groundTruth).criteria.map((entry) => [entry.criterion_id, entry.grade])) as Record<RubricCriterionId, RubricGrade>;
const grade = (criterionId: RubricCriterionId, text: string, groundTruth = truth) => grades(text, groundTruth)[criterionId];
const ALL_PASS = Object.fromEntries(RUBRIC_CRITERION_IDS.map((id) => [id, 'PASS'])) as Record<RubricCriterionId, RubricGrade>;

describe('time-range-evidence-rubric.v2 contract', () => {
  it('defines evidence, all five grades and the claim basis for every criterion', () => {
    expect(TIME_RANGE_EVIDENCE_RUBRIC_V2_VERSION).toBe('time-range-evidence-rubric.v2');
    for (const criterionId of RUBRIC_CRITERION_IDS) {
      const contract = TIME_RANGE_EVIDENCE_RUBRIC_V2[criterionId];
      expect([contract.evidence_required, contract.pass, contract.partial, contract.fail, contract.not_applicable, contract.unresolved].every(Boolean)).toBe(true);
    }
    expect(TIME_RANGE_EVIDENCE_RUBRIC_V2.hypoglycemia.claim_basis).toEqual({ claim: true, negation: true, time: true, unit: false });
    expect(TIME_RANGE_EVIDENCE_RUBRIC_V2.chronology_causality.claim_basis).toEqual({ claim: true, negation: true, time: true, unit: false });
  });
});

describe('time-range-evidence-rubric.v2 robustness', () => {
  it('grounds the suite in a fully settled fixture and is deterministic', () => {
    expect(Object.values(truth.criteria).every((entry) => entry.status === 'DEFINED')).toBe(true);
    expect(gradeTimeRangeAnswerV2(answer(), truth)).toEqual(gradeTimeRangeAnswerV2(answer(), truth));
    expect(gradeTimeRangeAnswerV2(answer(), truth).rubric_version).toBe(TIME_RANGE_EVIDENCE_RUBRIC_V2_VERSION);
  });

  describe('kept from v1: correct, wrong, omitted and incomplete answers', () => {
    it.each<[string, string, Partial<Record<RubricCriterionId, RubricGrade>>]>([
      ['correct and complete', answer(), {}],
      ['omits the hypo', answer({ hypo: null }), { hypoglycemia: 'FAIL' }],
      ['wrong glucose value', answer({ glucose: PART.glucose.replace('67 mg/dL', '58 mg/dL') }), { glucose_values: 'FAIL' }],
      ['wrong insulin dose', answer({ meals: PART.meals.replace('1,6 U', '6 U') }), { insulin: 'FAIL' }],
      ['meal with absent macronutrients', answer({}, ['Posiłek o 11:02 zawierał też 20 g białka i 15 g tłuszczu.']), { meals: 'FAIL' }],
      ['continuous CGM claimed', answer({ cgm: 'CGM monitorował glukozę nieprzerwanie przez cały okres.' }), { cgm_coverage: 'FAIL' }],
      ['complete CGM claimed', answer({ cgm: 'Dane CGM są kompletne.' }), { cgm_coverage: 'FAIL' }],
      ['temporal order presented as proven cause', answer({ causality: 'Bolus o 11:08 spowodował hipoglikemię o 11:42.' }), { chronology_causality: 'FAIL' }],
      ['cautious: the cause cannot be settled', answer({ causality: 'Na podstawie dostępnych danych nie da się ustalić przyczyny spadku: brak profilu terapii, odczyty CGM mają luki, a kolejność zdarzeń nie dowodzi zależności.' }), {}],
    ])('%s', (_label, text, changed) => {
      expect(grades(text)).toEqual({ ...ALL_PASS, ...changed });
    });

    it('names the right reason when invented macronutrients fail meals', () => {
      const meals = gradeTimeRangeAnswerV2(answer({}, ['Posiłek zawierał 20 g białka.']), truth).criteria.find((entry) => entry.criterion_id === 'meals')!;
      expect(meals.reasons[0]).toContain('protein/fat/fiber');
    });

    it('gives PARTIAL when the facts are right but incomplete', () => {
      expect(grades('Glukoza osiągnęła 128 mg/dL. Wystąpił epizod hipoglikemii.')).toMatchObject({ glucose_values: 'PARTIAL', hypoglycemia: 'PARTIAL', insulin: 'PARTIAL', meals: 'PARTIAL', chronology_causality: 'PARTIAL' });
    });

    it('fails therapy_profile and uncertainty for an invented profile stated with certainty', () => {
      expect(grades(answer({ therapy: 'Na pewno aktywny profil to bazal 0,7 U/h.' }))).toMatchObject({ therapy_profile: 'FAIL', uncertainty_completeness: 'FAIL' });
    });
  });

  describe('A. hypo negation is read per statement', () => {
    it.each([
      ['Polish denial, episode times present elsewhere (min reading, CGM gap bounds)', 'Nie wystąpiła hipoglikemia.'],
      ['Polish "brak"', 'Brak hipoglikemii w tym okresie.'],
      ['negation after the hypo word', 'Hipoglikemia nie wystąpiła.'],
      ['English denial', 'There was no hypoglycemia.'],
      ['English negation after', 'Hypoglycemia did not occur.'],
    ])('%s: FAIL', (_label, hypo) => {
      expect(grade('hypoglycemia', answer({ hypo }))).toBe('FAIL');
    });

    it('accepts denying a severity the episode does not have', () => {
      expect(grade('hypoglycemia', answer({}, ['Nie była to ciężka hipoglikemia.']))).toBe('PASS');
    });

    it('fails an affirmed severity the episode does not have', () => {
      expect(grade('hypoglycemia', answer({ hypo: 'Między 11:42 a 12:02 wystąpiła ciężka hipoglikemia.' }))).toBe('FAIL');
    });
  });

  describe('B. hypo times are bound to the hypo statement', () => {
    it('passes the right start and end in the hypo statement, in Polish and English', () => {
      expect(grade('hypoglycemia', answer({ hypo: 'Hipoglikemia trwała od 11:42 do 12:02.' }))).toBe('PASS');
      expect(grade('hypoglycemia', answer({ hypo: 'Hypoglycemia lasted from 11:42 to 12:02.' }))).toBe('PASS');
    });

    it('passes a hypo statement with several times, including a non-hypo one', () => {
      expect(grade('hypoglycemia', answer({ hypo: 'Hipoglikemia zaczęła się o 11:42 i skończyła o 12:02, po bolusie o 11:08.' }))).toBe('PASS');
    });

    it('fails a hypo statement placed at a wrong time, even when the right times appear elsewhere', () => {
      expect(grade('hypoglycemia', answer({ hypo: 'Hipoglikemia wystąpiła o 13:00.' }))).toBe('FAIL');
      expect(grade('hypoglycemia', answer({ hypo: 'Hipoglikemia wystąpiła o 09:30.' }))).toBe('FAIL');
    });

    it('is PARTIAL when the hypo statement has no times of its own (gap times elsewhere do not count)', () => {
      expect(grade('hypoglycemia', answer({ hypo: 'Wystąpiła hipoglikemia.' }))).toBe('PARTIAL');
      expect(grade('hypoglycemia', answer({ hypo: 'Hipoglikemia zaczęła się o 11:42.' }))).toBe('PARTIAL');
    });
  });

  describe('C. ratios, durations and therapy values are neither times nor glucose', () => {
    it('does not read ICR 1:12 or a 1:30 h duration as clock times', () => {
      expect(clockTimes('Przyjmując ICR 1:12, pomiar trwał 1:30 h, a bolus był o 11:08.').map((time) => time.raw)).toEqual(['11:08']);
      expect(clockTimes('carb ratio 1:10; insulin-to-carb ratio 1:8').map((time) => time.raw)).toEqual([]);
      const result = grades(answer({ therapy: 'Aktywny profil: bazal 0,7 U/h, ICR 1:12.' }));
      expect(result).toMatchObject({ therapy_profile: 'FAIL', chronology_causality: 'PASS' });
    });

    it('treats ISF and target mg/dL values as therapy claims, not glucose values', () => {
      expect(grades(answer({ therapy: 'ISF 45 mg/dL.' }))).toMatchObject({ glucose_values: 'PASS', therapy_profile: 'FAIL' });
      expect(grades(answer({ therapy: 'Cel glikemii to 100 mg/dL.' }))).toMatchObject({ glucose_values: 'PASS', therapy_profile: 'FAIL' });
      expect(grades(answer({ therapy: 'Insulin sensitivity of 50 mg/dL per unit.' }))).toMatchObject({ glucose_values: 'PASS', therapy_profile: 'FAIL' });
    });

    it('still reads a glucose range as glucose values', () => {
      expect(grade('glucose_values', answer({ glucose: 'Zakres glukozy: od 67 mg/dL do 128 mg/dL.' }))).toBe('PASS');
      expect(grade('glucose_values', answer({ glucose: 'Zakres glukozy: od 67 mg/dL do 140 mg/dL.' }))).toBe('FAIL');
    });

    it('binds a stated time to the value in its own segment', () => {
      expect(grade('glucose_values', answer({ glucose: 'Glukoza wahała się od 67 mg/dL (o 11:12) do 128 mg/dL (o 11:42).' }))).toBe('FAIL');
      expect(grade('glucose_values', answer({ glucose: 'O 11:42 glukoza wynosiła 67 mg/dL, a o 11:12 128 mg/dL.' }))).toBe('PASS');
    });
  });

  describe('D. causal statements are classified', () => {
    it.each([
      'Przyczyną hipoglikemii była zbyt duża dawka insuliny.',
      'Hipoglikemia wystąpiła z powodu bolusa.',
      'Bolus doprowadził do spadku glukozy.',
      'Spadek był skutkiem bolusa.',
      'The hypoglycemia was caused by the bolus.',
      'The bolus led to the drop.',
      'The low resulted from the bolus.',
      'Insulin was responsible for the low.',
    ])('categorical attribution fails: "%s"', (causality) => {
      expect(grade('chronology_causality', answer({ causality }))).toBe('FAIL');
    });

    it.each([
      'Bolus mógł przyczynić się do hipoglikemii.',
      'Prawdopodobnie bolus wpłynął na spadek glukozy.',
      'The bolus may have contributed to the low.',
      'It is possible that insulin drove the drop.',
    ])('hedged hypothesis consistent with the order passes: "%s"', (causality) => {
      expect(grade('chronology_causality', answer({ causality }))).toBe('PASS');
    });

    it.each([
      'Nie da się ustalić przyczyny spadku.',
      'Kolejność zdarzeń nie dowodzi, że bolus spowodował spadek.',
      'The data do not establish what caused the low.',
      'Hipoglikemia zaczęła się 34 minuty po bolusie.',
    ])('disclaimers and temporal observations pass: "%s"', (causality) => {
      expect(grade('chronology_causality', answer({ causality }))).toBe('PASS');
    });

    it.each([
      'Prawdopodobnie hipoglikemię spowodował spacer.',
      'The walk might have caused the low.',
      'Możliwe, że do spadku przyczynił się późniejszy posiłek o 12:25.',
    ])('hedged cause occurring only after the hypo fails: "%s"', (causality) => {
      expect(grade('chronology_causality', answer({ causality }))).toBe('FAIL');
    });

    it('is UNRESOLVED when a placeable hedged cause has no identifiable effect', () => {
      expect(grade('chronology_causality', answer({ causality: 'Bolus mógł mieć wpływ.' }))).toBe('UNRESOLVED');
    });

    it('classifies the claim kinds it reports', () => {
      const claims = causalClaims(parseClauses('Bolus spowodował spadek. Bolus mógł przyczynić się do spadku. Nie da się ustalić przyczyny spadku.'));
      expect(claims.map((claim) => claim.kind)).toEqual(['CATEGORICAL', 'HEDGED', 'DISCLAIMER']);
      expect(claims[0]).toMatchObject({ cause: 'INSULIN', effect_identified: true });
    });
  });

  describe('missing units and ambiguous references', () => {
    it('is UNRESOLVED for a unitless number in a glucose sentence that matches no evidence value', () => {
      expect(grade('glucose_values', answer({}, ['Glukoza spadła do 58.']))).toBe('UNRESOLVED');
    });

    it('accepts a unitless number that equals an evidence value, and still fails an invented value with a unit', () => {
      expect(grade('glucose_values', answer({}, ['Glukoza spadła do 67.']))).toBe('PASS');
      expect(grade('glucose_values', answer({}, ['Glukoza spadła do 58 mg/dL, potem do 50.']))).toBe('FAIL');
    });

    it('does not read dates, durations or counts as unitless glucose values', () => {
      expect(grade('glucose_values', answer({}, ['Glukoza 13.10 była stabilna przez 30 minut.']))).toBe('PASS');
    });
  });

  describe('NOT_APPLICABLE and UNRESOLVED from the ground truth', () => {
    it('keeps them separate from the answer', () => {
      const noMeals = { ...scenario.base_context, analytical_evidence: { ...scenario.base_context.analytical_evidence, meal_events: [] } } as TimeRangeAnalysisContextRecord;
      expect(grade('meals', answer({ meals: 'O 11:08 podano bolus 1,6 U.' }), truthFor(noMeals))).toBe('NOT_APPLICABLE');
      const legacy = {
        ...scenario.base_context,
        analytical_evidence: { ...scenario.base_context.analytical_evidence, insulin_treatment_events: [{ event_id: 'legacy', occurred_at: '2026-10-08T09:08:00.000Z', kind: 'BOLUS', amount: 1.6 }] },
      } as TimeRangeAnalysisContextRecord;
      expect(grade('insulin', answer(), truthFor(legacy))).toBe('UNRESOLVED');
    });
  });

  it('fixes each v1 defect that v1 still has (v1 stays the reference)', () => {
    const cases: Array<[RubricCriterionId, string, RubricGrade]> = [
      ['hypoglycemia', answer({ hypo: 'Nie wystąpiła hipoglikemia.' }), 'FAIL'],
      ['hypoglycemia', answer({ hypo: 'Hipoglikemia wystąpiła o 13:00.' }), 'FAIL'],
      ['chronology_causality', answer({ therapy: 'Aktywny profil: bazal 0,7 U/h, ICR 1:12.' }), 'PASS'],
      ['chronology_causality', answer({ causality: 'Przyczyną hipoglikemii była zbyt duża dawka insuliny.' }), 'FAIL'],
    ];
    for (const [criterionId, text, expected] of cases) {
      const v1 = gradeTimeRangeAnswer(text, truth).criteria.find((entry) => entry.criterion_id === criterionId)!.grade;
      expect(grade(criterionId, text)).toBe(expected);
      expect(v1).not.toBe(expected);
    }
  });

  it('lists what v2 still cannot settle', () => {
    const ids = TIME_RANGE_EVIDENCE_RUBRIC_V2_KNOWN_LIMITATIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('unitless-values');
    expect(ids).not.toContain('hypo-denial-passes');
  });

  it('is the rubric the paired harness reports', async () => {
    const report = await runHistoryEvidenceComparisonExperiment();
    expect(report.summary.evidence_rubric_version).toBe(TIME_RANGE_EVIDENCE_RUBRIC_V2_VERSION);
    expect(report.scenarios.every((entry) => entry.history_off.evidence_rubric?.rubric_version === TIME_RANGE_EVIDENCE_RUBRIC_V2_VERSION)).toBe(true);
  });
});
