import { describe, expect, it } from 'vitest';
import type { TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import {
  buildTimeRangeEvidenceGroundTruth,
  gradeTimeRangeAnswer,
  RUBRIC_CRITERION_IDS,
  TIME_RANGE_EVIDENCE_RUBRIC_V1_KNOWN_LIMITATIONS,
  type RubricCriterionId,
  type RubricGrade,
} from './time-range-evidence-rubric';
import { createHistoryComparisonScenarios } from './time-range-quality-cost-experiment';

// Robustness of time-range-evidence-rubric.v1 against hand-written answers. Ground truth comes from the v2 fixture of
// history-pair-01 (identical clinical evidence in all seven pairs) and the contracts; expected grades come from the
// rubric's own PASS/PARTIAL/FAIL definitions. Where the implementation contradicts its definitions the test is an
// `it.fails` KNOWN DEFECT; cases the definitions do not settle are listed in TIME_RANGE_EVIDENCE_RUBRIC_V1_KNOWN_LIMITATIONS
// instead of being asserted. Local times are Europe/Warsaw (CEST).

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
  Object.fromEntries(gradeTimeRangeAnswer(text, groundTruth).criteria.map((entry) => [entry.criterion_id, entry.grade])) as Record<RubricCriterionId, RubricGrade>;

const ALL_PASS: Record<RubricCriterionId, RubricGrade> = Object.fromEntries(RUBRIC_CRITERION_IDS.map((id) => [id, 'PASS'])) as Record<RubricCriterionId, RubricGrade>;

describe('time-range-evidence-rubric.v1 robustness (history-comparison-scenarios.v2, pair-01 evidence)', () => {
  it('grounds the suite in a fully settled fixture', () => {
    expect(Object.values(truth.criteria).every((entry) => entry.status === 'DEFINED')).toBe(true);
  });

  // Answers that change exactly one fact: only the targeted criterion may move away from PASS.
  it.each<[string, string, Partial<Record<RubricCriterionId, RubricGrade>>]>([
    ['correct and complete', answer(), {}],
    ['omits the hypo', answer({ hypo: null }), { hypoglycemia: 'FAIL' }],
    ['wrong glucose value', answer({ glucose: PART.glucose.replace('67 mg/dL', '58 mg/dL') }), { glucose_values: 'FAIL' }],
    ['wrong insulin dose', answer({ meals: PART.meals.replace('1,6 U', '6 U') }), { insulin: 'FAIL' }],
    ['meal with absent data', answer({}, ['Posiłek o 11:02 zawierał też 20 g białka i 15 g tłuszczu.']), { meals: 'FAIL' }],
    ['continuous CGM claimed', answer({ cgm: 'CGM monitorował glukozę nieprzerwanie przez cały okres.' }), { cgm_coverage: 'FAIL' }],
    ['temporal order presented as proven cause', answer({ causality: 'Bolus o 11:08 spowodował hipoglikemię o 11:42.' }), { chronology_causality: 'FAIL' }],
    ['cautious: says the cause cannot be settled', answer({ causality: 'Na podstawie dostępnych danych nie da się ustalić przyczyny spadku: brak profilu terapii, odczyty CGM mają luki, a kolejność zdarzeń nie dowodzi zależności.' }), {}],
  ])('%s', (_label, text, changed) => {
    expect(grades(text)).toEqual({ ...ALL_PASS, ...changed });
  });

  // Answers whose targeted criterion follows the definition, while other criteria are affected by documented limits.
  it('fails therapy_profile for an invented active profile', () => {
    expect(grades(answer({ therapy: 'Aktywny profil: bazal 0,7 U/h, ICR 1:12, ISF 45 mg/dL.' })).therapy_profile).toBe('FAIL');
  });

  it('fails uncertainty_completeness for unjustified certainty stated with a certainty word', () => {
    expect(grades(answer({ causality: 'Na pewno przyczyną była zbyt duża dawka insuliny.' })).uncertainty_completeness).toBe('FAIL');
  });

  it('gives PARTIAL, not PASS or FAIL, when facts are right but incomplete', () => {
    expect(grades('Glukoza osiągnęła 128 mg/dL. Wystąpił epizod hipoglikemii.')).toMatchObject({ glucose_values: 'PARTIAL', hypoglycemia: 'PARTIAL', insulin: 'PARTIAL', meals: 'PARTIAL', chronology_causality: 'PARTIAL' });
  });

  it('separates NOT_APPLICABLE (no evidence for the criterion) from UNRESOLVED (evidence cannot settle it)', () => {
    const noMeals = { ...scenario.base_context, analytical_evidence: { ...scenario.base_context.analytical_evidence, meal_events: [] } } as TimeRangeAnalysisContextRecord;
    expect(grades(answer({ meals: 'O 11:08 podano bolus 1,6 U.' }), truthFor(noMeals)).meals).toBe('NOT_APPLICABLE');
    expect(grades(answer(), truthFor(noMeals)).meals).toBe('FAIL'); // 38 g and 18 g are now invented

    const legacyInsulin = {
      ...scenario.base_context,
      analytical_evidence: { ...scenario.base_context.analytical_evidence, insulin_treatment_events: [{ event_id: 'legacy', occurred_at: '2026-10-08T09:08:00.000Z', kind: 'BOLUS', amount: 1.6 }] },
    } as TimeRangeAnalysisContextRecord;
    expect(grades(answer(), truthFor(legacyInsulin)).insulin).toBe('UNRESOLVED');
  });

  it('is deterministic', () => {
    expect(gradeTimeRangeAnswer(answer(), truth)).toEqual(gradeTimeRangeAnswer(answer(), truth));
  });

  describe('KNOWN DEFECT (pinned with it.fails; listed in TIME_RANGE_EVIDENCE_RUBRIC_V1_KNOWN_LIMITATIONS)', () => {
    // Definition: FAIL when a recorded episode is omitted; denying it is at least as wrong.
    it.fails('hypo-denial-passes: an answer denying the recorded hypo fails hypoglycemia', () => {
      expect(grades(answer({ hypo: 'Nie wystąpiła hipoglikemia.' })).hypoglycemia).toBe('FAIL');
    });

    // Definition: PASS needs the episode with its start and end time; a wrong time cannot pass.
    it.fails('hypo-wrong-time-passes: a hypo placed at the wrong time does not pass hypoglycemia', () => {
      expect(grades(answer({ hypo: 'Hipoglikemia wystąpiła o 13:00.' })).hypoglycemia).not.toBe('PASS');
    });

    // Definition: FAIL for a clock time without evidence; "1:12" here is a carb ratio, not a clock time.
    it.fails('ratio-read-as-clock-time: a carb ratio is not reported as an unsupported clock time', () => {
      const result = gradeTimeRangeAnswer(answer({ therapy: 'Aktywny profil: bazal 0,7 U/h, ICR 1:12.' }), truth);
      expect(result.criteria.find((entry) => entry.criterion_id === 'chronology_causality')!.reasons.join(' ')).not.toContain('1:12');
    });

    // Definition: FAIL for an unhedged causal link; this one is phrased outside the fixed vocabulary.
    it.fails('causal-lexicon-gaps: "przyczyną ... była" is recognised as an unhedged causal claim', () => {
      expect(grades(answer({ causality: 'Przyczyną hipoglikemii była zbyt duża dawka insuliny.' })).chronology_causality).toBe('FAIL');
    });
  });

  it('documents every known defect and limitation with its criterion', () => {
    const ids = TIME_RANGE_EVIDENCE_RUBRIC_V1_KNOWN_LIMITATIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TIME_RANGE_EVIDENCE_RUBRIC_V1_KNOWN_LIMITATIONS.filter((entry) => entry.kind === 'DEFECT').map((entry) => entry.id))
      .toEqual(['hypo-denial-passes', 'hypo-wrong-time-passes', 'ratio-read-as-clock-time', 'causal-lexicon-gaps']);
    expect(TIME_RANGE_EVIDENCE_RUBRIC_V1_KNOWN_LIMITATIONS.every((entry) => RUBRIC_CRITERION_IDS.includes(entry.criterion))).toBe(true);
  });
});
