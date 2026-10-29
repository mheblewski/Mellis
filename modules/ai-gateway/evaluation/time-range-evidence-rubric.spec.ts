import { describe, expect, it } from 'vitest';
import type { AiProvider, TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import { createConversationTimeRangeAnalysisTask } from '@modules/ai-gateway/application/ai-task';
import { buildTimeRangeAnalysisPrompt } from '@modules/ai-gateway/application/time-range-analysis-prompt';
import { buildTimeRangeSyntheticScenario } from '@modules/context/application/time-range-synthetic-scenario.fixture';
import { classifyGlucoseReading } from '@modules/triggering/application/hypo-detector';
import {
  assessEvidenceAvailability,
  buildTimeRangeEvidenceGroundTruth,
  compareRubricEvaluations,
  gradeTimeRangeAnswer,
  RUBRIC_CRITERION_IDS,
  TIME_RANGE_EVIDENCE_RUBRIC_V1,
  TIME_RANGE_EVIDENCE_RUBRIC_VERSION,
  type RubricEvaluation,
  type RubricGrade,
} from './time-range-evidence-rubric';
import {
  createHistoryComparisonScenarios,
  HISTORY_COMPARISON_FIXTURE_VERSION,
  runHistoryEvidenceComparisonExperiment,
} from './time-range-quality-cost-experiment';

// Offline only: ground truth from fixtures, hand-written answers, deterministic or stub providers. No model is
// called; these tests check the harness, not the quality of any model.

const REFERENCE_FIXTURE_VERSION = 'time-range-synthetic-scenario.v1';

/** The 3-day synthetic scenario projected the way the worker projects stored events into the context package. */
function referenceContext(overrides: { insulinPayloadOverride?: (payload: Record<string, unknown>, index: number) => Record<string, unknown> } = {}): TimeRangeAnalysisContextRecord {
  const scenario = buildTimeRangeSyntheticScenario();
  const project = (event: (typeof scenario.events)[number]) => ({
    event_id: event.id, type: event.type, occurred_at: event.occurred_at, payload: event.payload, source_record_id: event.source_record_id,
  });
  const glucose = scenario.events.filter((event) => event.type === 'GLUCOSE_READING_AVAILABLE').map(project);
  const insulin = scenario.events.filter((event) => event.type === 'BOLUS' || event.type === 'TEMP_BASAL').map(project)
    .map((event, index) => (overrides.insulinPayloadOverride ? { ...event, payload: overrides.insulinPayloadOverride(event.payload, index) } : event));
  const meals = scenario.events.filter((event) => event.type === 'CARB_ENTRY').map(project);
  const values = scenario.glucose_readings.map((reading) => reading.glucose_value);
  return {
    context_package_id: 'reference-cp',
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: 'sha256:reference',
    created_at: scenario.requested_at,
    patient_ref: { patient_id: scenario.patient_id },
    analysis_request_input: {
      user_message_id: 'reference-msg',
      user_message_text: scenario.user_message,
      range_type: scenario.range_type,
      timezone: scenario.timezone,
      range_start: scenario.range_start,
      range_end: scenario.range_end,
      requested_at: scenario.requested_at,
    },
    conversation_context: { thread_id: 'reference-thread', thread_state_version: 'conv-v1', awaiting_user_answer: false, messages: [] },
    current_state_snapshot: null,
    analytical_evidence: {
      glucose_events: glucose,
      insulin_treatment_events: insulin,
      meal_events: meals,
      activity_events: [],
      hypo_episodes: scenario.hypo_episodes.map((episode) => ({
        episode_id: episode.id, state: episode.state, severity: episode.severity, started_at: episode.started_at, ended_at: episode.ended_at, trigger_id: episode.trigger_id,
      })),
      range_event_facts: [],
      summaries: {
        total_events: glucose.length + insulin.length + meals.length,
        glucose_count: glucose.length,
        insulin_treatment_count: insulin.length,
        meal_count: meals.length,
        activity_count: 0,
        hypo_episode_count: 1,
        glucose_min: Math.min(...values),
        glucose_max: Math.max(...values),
        glucose_avg: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
        missing_sections: ['activity_events'],
      },
    },
    provenance: { source_refs: [], selection_policy_version: 'conversation-time-range-context-selection.v1' },
  } as unknown as TimeRangeAnalysisContextRecord;
}

const referenceTruth = () => buildTimeRangeEvidenceGroundTruth({ scenario_id: 'reference-3-day', fixture_version: REFERENCE_FIXTURE_VERSION, context: referenceContext() });

// Hand-written from the fixture (not model output): every fact stated correctly, causality hedged.
const GOOD_ANSWER = [
  'W analizowanym okresie glukoza wahała się od 55 mg/dL (wczoraj o 11:50) do 210 mg/dL (wczoraj o 09:30).',
  'Wczoraj o 06:30 była tymczasowa dawka bazalna 0,8 U/h, o 07:45 bolus 4 U, o 08:00 zapisano 45 g węglowodanów, a o 11:00 bolus korekcyjny 2 U.',
  'Między 11:40 a 12:20 wystąpił epizod hipoglikemii (L1); o 11:45 zapisano bazę tymczasową 0 U/h.',
  'W danych CGM jest przerwa od 15:00 do 16:30.',
  'Brak profilu terapii, więc ustawienia bazalu, ICR i ISF są nieznane. Brak danych o aktywności.',
  'Kolejność zdarzeń nie dowodzi, że bolus spowodował spadek; to możliwe, ale niepotwierdzone.',
].join(' ');

const gradeOf = (evaluation: RubricEvaluation, criterionId: string): RubricGrade =>
  evaluation.criteria.find((entry) => entry.criterion_id === criterionId)!.grade;

describe('time-range evidence rubric v1', () => {
  it('defines PASS/PARTIAL/FAIL/NOT_APPLICABLE conditions and critical failures for every criterion', () => {
    expect(TIME_RANGE_EVIDENCE_RUBRIC_VERSION).toBe('time-range-evidence-rubric.v1');
    expect(RUBRIC_CRITERION_IDS).toHaveLength(8);
    for (const criterionId of RUBRIC_CRITERION_IDS) {
      const definition = TIME_RANGE_EVIDENCE_RUBRIC_V1[criterionId];
      expect(definition.pass && definition.partial && definition.fail && definition.not_applicable).toBeTruthy();
      expect(definition.critical_failures.length).toBeGreaterThan(0);
    }
  });

  describe('ground truth', () => {
    it('settles every criterion of the reference 3-day scenario from the fixture and contracts', () => {
      const truth = referenceTruth();
      expect(Object.values(truth.criteria).map((entry) => entry.status)).toEqual(Array(8).fill('DEFINED'));
      expect(truth.glucose).toMatchObject({ min: 55, max: 210 });
      expect(truth.glucose.readings.filter((reading) => reading.value === 55).map((reading) => reading.local_time)).toEqual(['11:50', '11:55', '12:00', '12:05']);
      expect(truth.hypo_episodes.map((episode) => [episode.start.local_time, episode.end?.local_time, episode.severity, episode.state])).toEqual([['11:40', '12:20', 'L1', 'CLOSED']]);
      expect(truth.insulin).toMatchObject({ total_units: 6, count: 2, unknown_dose_count: 0 });
      expect(truth.insulin.doses.map((dose) => [dose.local_time, dose.value])).toEqual([['07:45', 4], ['11:00', 2]]);
      expect(truth.temp_basal_rates).toEqual([0, 0.8]);
      expect(truth.meals.map((meal) => [meal.local_time, meal.value])).toEqual([['08:00', 45]]);
      expect(truth.cgm_gaps.map((gap) => [gap.from.local_datetime, gap.to.local_datetime])).toEqual([['2026-10-13 15:00', '2026-10-13 16:30']]);
      expect(truth.anomalies).toEqual([]);
    });

    it('settles all eight criteria for each v2 paired scenario from its fixture and the contracts', () => {
      const scenarios = createHistoryComparisonScenarios();
      expect(scenarios).toHaveLength(7);
      for (const scenario of scenarios) {
        expect(scenario.fixture_version).toBe('history-comparison-scenarios.v2');
        const truth = buildTimeRangeEvidenceGroundTruth({ scenario_id: scenario.scenario_id, fixture_version: scenario.fixture_version, context: scenario.base_context });
        expect(Object.values(truth.criteria).map((entry) => entry.status)).toEqual(Array(8).fill('DEFINED'));
        expect(Object.values(truth.criteria).flatMap((entry) => entry.missing_evidence)).toEqual([]);
        expect(truth.anomalies).toEqual([]);
        // Europe/Warsaw (CEST): local = UTC + 2 h.
        expect(truth.glucose).toMatchObject({ min: 67, max: 128 });
        expect(truth.hypo_episodes.map((episode) => [episode.start.local_time, episode.end?.local_time, episode.severity, episode.state])).toEqual([['11:42', '12:02', 'L1', 'CLOSED']]);
        expect(truth.insulin).toMatchObject({ total_units: 1.6, count: 1, unknown_dose_count: 0 });
        expect(truth.insulin.doses.map((dose) => [dose.local_time, dose.type, dose.value])).toEqual([['11:08', 'BOLUS', 1.6]]);
        expect(truth.meals.map((meal) => [meal.local_time, meal.value])).toEqual([['11:02', 38], ['12:25', 18]]);
        expect(truth.cgm_gaps.map((gap) => [gap.from.local_time, gap.to.local_time])).toEqual([['11:12', '11:42'], ['11:42', '12:02'], ['12:02', '14:30']]);
        expect(truth.therapy_profile_present).toBe(false);
      }
    });

    it('keeps a criterion UNRESOLVED, with the missing evidence named, when events break the normalizer contract', () => {
      const context = referenceContext({ insulinPayloadOverride: (payload) => payload });
      const nonContract = {
        ...context,
        analytical_evidence: {
          ...context.analytical_evidence,
          insulin_treatment_events: [{ event_id: 'legacy-1', occurred_at: context.analysis_request_input.range_start, kind: 'BOLUS', amount: 1.6 }],
          meal_events: [{ event_id: 'legacy-m1', occurred_at: context.analysis_request_input.range_start, payload: { carbs_grams: 38 } }],
          hypo_episodes: [],
        },
      } as TimeRangeAnalysisContextRecord;
      const truth = buildTimeRangeEvidenceGroundTruth({ scenario_id: 'non-contract', fixture_version: 'test', context: nonContract });
      expect(truth.criteria.insulin).toMatchObject({ status: 'UNRESOLVED', missing_evidence: ['insulin_treatment_events with type BOLUS/SMB and payload.insulin_units'] });
      expect(truth.criteria.meals).toMatchObject({ status: 'UNRESOLVED', missing_evidence: ['meal_events with type CARB_ENTRY and payload.carbs'] });
      expect(truth.criteria.hypoglycemia.missing_evidence).toContain('clinically significant low threshold (OPEN in evidence-reduction-contract)');
    });

    it('is deterministic', () => {
      expect(referenceTruth()).toEqual(referenceTruth());
      expect(gradeTimeRangeAnswer(GOOD_ANSWER, referenceTruth())).toEqual(gradeTimeRangeAnswer(GOOD_ANSWER, referenceTruth()));
    });
  });

  describe('grading', () => {
    it('passes every criterion for an answer that states the evidence correctly', () => {
      const evaluation = gradeTimeRangeAnswer(GOOD_ANSWER, referenceTruth());
      expect(evaluation.criteria.filter((entry) => entry.grade !== 'PASS')).toEqual([]);
      expect(evaluation.grade_counts).toEqual({ PASS: 8, PARTIAL: 0, FAIL: 0, NOT_APPLICABLE: 0, UNRESOLVED: 0 });
      expect(evaluation.criteria.find((entry) => entry.criterion_id === 'hypoglycemia')!.evidence_refs.length).toBeGreaterThan(0);
    });

    it.each([
      ['glucose_values', 'Najniższa glukoza wyniosła 48 mg/dL, najwyższa 210 mg/dL.'],
      ['glucose_values', 'Minimum 55 mg/dL o 14:00, maksimum 210 mg/dL.'],
      ['hypoglycemia', 'Glukoza wahała się od 55 do 210 mg/dL.'],
      ['hypoglycemia', 'Wystąpiła ciężka hipoglikemia poziomu 2 między 11:40 a 12:20.'],
      ['insulin', 'Podano łącznie 12 U insuliny.'],
      ['insulin', 'Podano 4 bolusy: 4 U i 2 U.'],
      ['insulin', 'Podano bolus 5 U.'],
      ['meals', 'O 08:00 zjedzono 60 g węglowodanów.'],
      ['meals', 'Zapisano 45 g węglowodanów o 13:00.'],
      ['cgm_coverage', 'Glukoza była monitorowana nieprzerwanie przez cały okres.'],
      ['cgm_coverage', 'Glukoza wahała się od 55 do 210 mg/dL.'],
      ['therapy_profile', 'Bazal wynosi 0,6 U/h.'],
      ['therapy_profile', 'Przy ICR 1:10 dawka była właściwa.'],
      ['chronology_causality', 'O 15:10 glukoza wynosiła 120 mg/dL.'],
      ['chronology_causality', 'Bolus spowodował hipoglikemię.'],
      ['uncertainty_completeness', 'To na pewno wina posiłku.'],
    ])('grades %s FAIL for "%s"', (criterionId, answer) => {
      expect(gradeOf(gradeTimeRangeAnswer(answer, referenceTruth()), criterionId)).toBe('FAIL');
    });

    it.each([
      ['glucose_values', 'Glukoza osiągnęła 210 mg/dL.'],
      ['hypoglycemia', 'Wystąpił epizod hipoglikemii.'],
      ['insulin', 'Podano bolus 4 U.'],
      ['cgm_coverage', 'W danych CGM jest przerwa.'],
      ['therapy_profile', 'Glukoza była przez większość czasu stabilna.'],
      ['chronology_causality', 'Glukoza była przez większość czasu stabilna.'],
      ['uncertainty_completeness', 'Glukoza była przez większość czasu stabilna.'],
    ])('grades %s PARTIAL for "%s"', (criterionId, answer) => {
      expect(gradeOf(gradeTimeRangeAnswer(answer, referenceTruth()), criterionId)).toBe('PARTIAL');
    });

    it('treats an unknown dose reported as 0 U as a failure, and keeps the total unknown', () => {
      const context = referenceContext({ insulinPayloadOverride: (payload, index) => (index === 1 ? { source_event_type: 'Bolus' } : payload) });
      const truth = buildTimeRangeEvidenceGroundTruth({ scenario_id: 'unknown-dose', fixture_version: REFERENCE_FIXTURE_VERSION, context });
      expect(truth.insulin).toMatchObject({ unknown_dose_count: 1, total_units: null });
      expect(gradeOf(gradeTimeRangeAnswer('Rano podano bolus 0 U, potem 2 U.', truth), 'insulin')).toBe('FAIL');
    });

    it('never passes an UNRESOLVED criterion, whatever the answer says', () => {
      const context = referenceContext();
      const nonContract = {
        ...context,
        analytical_evidence: {
          ...context.analytical_evidence,
          insulin_treatment_events: [{ event_id: 'legacy-1', occurred_at: context.analysis_request_input.range_start, kind: 'BOLUS', amount: 1.6 }],
          meal_events: [{ event_id: 'legacy-m1', occurred_at: context.analysis_request_input.range_start, payload: { carbs_grams: 38 } }],
          hypo_episodes: [],
        },
      } as TimeRangeAnalysisContextRecord;
      const truth = buildTimeRangeEvidenceGroundTruth({ scenario_id: 'non-contract', fixture_version: 'test', context: nonContract });
      const evaluation = gradeTimeRangeAnswer('Podano bolus 1,6 U i zjedzono 38 g węglowodanów; hipoglikemia 55 mg/dL o 11:50.', truth);
      for (const criterionId of ['hypoglycemia', 'insulin', 'meals']) {
        const entry = evaluation.criteria.find((criterion) => criterion.criterion_id === criterionId)!;
        expect(entry.grade).toBe('UNRESOLVED');
        expect(entry.reasons.some((reason) => reason.startsWith('Missing evidence:'))).toBe(true);
      }
    });

    it('marks a criterion NOT_APPLICABLE when its evidence is absent, but fails invented entries', () => {
      const context = referenceContext();
      const noMeals = { ...context, analytical_evidence: { ...context.analytical_evidence, meal_events: [] } } as TimeRangeAnalysisContextRecord;
      const truth = buildTimeRangeEvidenceGroundTruth({ scenario_id: 'no-meals', fixture_version: REFERENCE_FIXTURE_VERSION, context: noMeals });
      expect(truth.criteria.meals.status).toBe('NOT_APPLICABLE');
      expect(gradeOf(gradeTimeRangeAnswer(GOOD_ANSWER.replace(', o 08:00 zapisano 45 g węglowodanów', ''), truth), 'meals')).toBe('NOT_APPLICABLE');
      expect(gradeOf(gradeTimeRangeAnswer('O 08:00 zjedzono 45 g węglowodanów.', truth), 'meals')).toBe('FAIL');
    });

    it('does not read Polish dates or decimal amounts as clock times', () => {
      const answer = `${GOOD_ANSWER} Dane z 12.10 i 13.10.2026; średnio 1.25 U na zdarzenie nie jest podane.`;
      expect(gradeOf(gradeTimeRangeAnswer(answer, referenceTruth()), 'chronology_causality')).toBe('PASS');
    });
  });

  describe('evidence availability', () => {
    const prompt = (context: TimeRangeAnalysisContextRecord) => buildTimeRangeAnalysisPrompt(createConversationTimeRangeAnalysisTask({
      task_id: 'availability', context_package_id: context.context_package_id, context_package_version: context.context_package_version,
      context_package_hash: context.content_hash, correlation_id: 'availability', created_at: context.created_at,
    }), context).user_payload;

    it('reports the default prompt as delivering the facts every criterion needs', () => {
      expect(assessEvidenceAvailability(referenceTruth(), prompt(referenceContext()))).toEqual({
        glucose_values: 'DELIVERED',
        hypoglycemia: 'DELIVERED',
        insulin: 'DELIVERED',
        meals: 'DELIVERED',
        cgm_coverage: 'DELIVERED',
        therapy_profile: 'DELIVERED',
        chronology_causality: 'PARTIALLY_DELIVERED', // the CGM series between anchors is deliberately not sent
        uncertainty_completeness: 'DELIVERED',
      });
    });

    it('reports an aggregates-only payload as not delivering timed evidence', () => {
      const payload = JSON.parse(prompt(referenceContext()));
      delete payload.temporal_evidence;
      const availability = assessEvidenceAvailability(referenceTruth(), JSON.stringify(payload));
      expect(availability).toMatchObject({ hypoglycemia: 'NOT_DELIVERED', insulin: 'NOT_DELIVERED', meals: 'NOT_DELIVERED', cgm_coverage: 'NOT_DELIVERED', therapy_profile: 'NOT_DELIVERED' });
    });
  });

  describe('paired comparison', () => {
    const evaluation = (grades: Partial<Record<string, RubricGrade>>): RubricEvaluation => ({
      rubric_version: TIME_RANGE_EVIDENCE_RUBRIC_VERSION,
      scenario_id: 's',
      fixture_version: 'f',
      criteria: RUBRIC_CRITERION_IDS.map((criterionId) => ({ criterion_id: criterionId, grade: grades[criterionId] ?? 'PASS', reasons: [], evidence_refs: [] })),
      grade_counts: { PASS: 0, PARTIAL: 0, FAIL: 0, NOT_APPLICABLE: 0, UNRESOLVED: 0 },
    });

    it('classifies improve, degrade, no_change and not_comparable per criterion', () => {
      const deltas = compareRubricEvaluations(
        evaluation({ glucose_values: 'FAIL', hypoglycemia: 'PASS', insulin: 'UNRESOLVED', meals: 'NOT_APPLICABLE' }),
        evaluation({ glucose_values: 'PARTIAL', hypoglycemia: 'PARTIAL', insulin: 'PASS', meals: 'PASS' }),
      );
      expect(Object.fromEntries(deltas.map((entry) => [entry.criterion_id, entry.delta]))).toEqual({
        glucose_values: 'improve',
        hypoglycemia: 'degrade',
        insulin: 'not_comparable',
        meals: 'not_comparable',
        cgm_coverage: 'no_change',
        therapy_profile: 'no_change',
        chronology_causality: 'no_change',
        uncertainty_completeness: 'no_change',
      });
      expect(compareRubricEvaluations(null, evaluation({})).every((entry) => entry.delta === 'not_comparable' && entry.off_grade === 'MISSING')).toBe(true);
    });

    it('runs the seven pairs through AiGatewayService.execute with rubric, availability and deltas', async () => {
      const report = await runHistoryEvidenceComparisonExperiment();
      expect(report.summary.evidence_rubric_version).toBe('time-range-evidence-rubric.v2'); // the harness grades with v2; v1 stays the reference
      expect(report.scenarios).toHaveLength(7);
      for (const scenario of report.scenarios) {
        expect(scenario.evidence_ground_truth.fixture_version).toBe(HISTORY_COMPARISON_FIXTURE_VERSION);
        expect(Object.values(scenario.evidence_ground_truth.criteria).every((entry) => entry.status === 'DEFINED')).toBe(true);
        expect(scenario.input_invariant.identical_without_history).toBe(true);
        for (const variant of [scenario.history_off, scenario.history_on]) {
          expect(variant.real_model_used).toBe(false);
          expect(variant.evidence_rubric?.criteria).toHaveLength(8);
          // With every criterion settled, an UNRESOLVED grade can only come from the answer (v2: e.g. a hedged cause
          // without an identifiable effect), never from missing evidence; and every criterion's evidence reached the model.
          for (const criterion of variant.evidence_rubric!.criteria.filter((entry) => entry.grade === 'UNRESOLVED')) {
            expect(criterion.reasons.some((reason) => reason.startsWith('Missing evidence:'))).toBe(false);
          }
          expect(Object.values(variant.evidence_availability!).every((availability) => availability === 'DELIVERED' || availability === 'PARTIALLY_DELIVERED')).toBe(true);
          expect(variant.tool_call_count).toBe(0);
        }
      }
      const totals = report.summary.evidence_rubric_delta_summary;
      expect(totals.improve + totals.degrade + totals.no_change + totals.not_comparable).toBe(7 * 8);
    });

    it('gives both variants of a pair the same clinical evidence and the same ground truth', () => {
      for (const scenario of createHistoryComparisonScenarios()) {
        const off = scenario.base_context;
        const on = { ...scenario.base_context, historical_evidence: { selected_cases: [], note: 'history channel only' } } as unknown as TimeRangeAnalysisContextRecord;
        expect(on.analytical_evidence).toEqual(off.analytical_evidence);
        const truth = (context: TimeRangeAnalysisContextRecord) => buildTimeRangeEvidenceGroundTruth({ scenario_id: scenario.scenario_id, fixture_version: scenario.fixture_version, context });
        expect(truth(on)).toEqual(truth(off));
      }
    });

    it('produces identical rubric results on repeated runs', async () => {
      const strip = (report: Awaited<ReturnType<typeof runHistoryEvidenceComparisonExperiment>>) => report.scenarios.map((scenario) => ({
        delta: scenario.evidence_rubric_delta,
        off: scenario.history_off.evidence_rubric,
        on: scenario.history_on.evidence_rubric,
        availability: [scenario.history_off.evidence_availability, scenario.history_on.evidence_availability],
      }));
      expect(strip(await runHistoryEvidenceComparisonExperiment())).toEqual(strip(await runHistoryEvidenceComparisonExperiment()));
    });

    it('makes every criterion of a pair not_comparable when one variant fails', async () => {
      const failing: AiProvider = { generate: async () => { throw new Error('synthetic provider failure'); } };
      const report = await runHistoryEvidenceComparisonExperiment({ provider: failing });
      for (const scenario of report.scenarios) {
        expect(scenario.history_off.evidence_rubric).toBeNull();
        expect(scenario.evidence_rubric_delta.every((entry) => entry.delta === 'not_comparable')).toBe(true);
      }
    });
  });
});

describe('history-comparison-scenarios.v2 fixtures', () => {
  const scenarios = createHistoryComparisonScenarios();
  const evidence = (scenario: (typeof scenarios)[number]) => scenario.base_context.analytical_evidence;
  const allEvents = (scenario: (typeof scenarios)[number]) => [
    ...evidence(scenario).glucose_events,
    ...evidence(scenario).insulin_treatment_events,
    ...evidence(scenario).meal_events,
    ...evidence(scenario).activity_events,
  ] as Array<Record<string, any>>;

  it('is deterministic and versioned', () => {
    expect(createHistoryComparisonScenarios()).toEqual(scenarios);
    expect(scenarios.every((scenario) => scenario.fixture_version === HISTORY_COMPARISON_FIXTURE_VERSION && scenario.source_kind === 'SYNTHETIC')).toBe(true);
  });

  it('uses the worker projection with the normalizer payload fields for every event', () => {
    for (const scenario of scenarios) {
      for (const event of allEvents(scenario)) {
        expect(Object.keys(event).sort()).toEqual(['event_id', 'occurred_at', 'payload', 'source_record_id', 'type']);
      }
      expect(evidence(scenario).glucose_events.every((event: any) => event.type === 'GLUCOSE_READING_AVAILABLE' && typeof event.payload.glucose_value === 'number')).toBe(true);
      expect(evidence(scenario).insulin_treatment_events.every((event: any) => event.type === 'BOLUS' && typeof event.payload.insulin_units === 'number' && event.payload.insulin_units > 0)).toBe(true);
      expect(evidence(scenario).meal_events.every((event: any) => event.type === 'CARB_ENTRY' && typeof event.payload.carbs === 'number' && event.payload.carbs > 0)).toBe(true);
      expect(evidence(scenario).activity_events.every((event: any) => event.type === 'ACTIVITY' && typeof event.payload.activity_type === 'string')).toBe(true);
    }
  });

  it('keeps every event inside the requested range with unique identifiers and source references', () => {
    for (const scenario of scenarios) {
      const { range_start: from, range_end: to } = scenario.base_context.analysis_request_input;
      const events = allEvents(scenario);
      expect(events.every((event) => event.occurred_at >= from && event.occurred_at <= to)).toBe(true);
      expect(new Set(events.map((event) => event.event_id)).size).toBe(events.length);
      expect(new Set(events.map((event) => event.source_record_id)).size).toBe(events.length);
      expect(events.every((event) => String(event.event_id).startsWith(`${scenario.scenario_id}-`) && String(event.source_record_id).startsWith(`${scenario.scenario_id}-sr-`))).toBe(true);
    }
  });

  it('declares a hypo episode consistent with the readings and the detector rule', () => {
    for (const scenario of scenarios) {
      const [episode] = evidence(scenario).hypo_episodes as Array<Record<string, any>>;
      expect(evidence(scenario).hypo_episodes).toHaveLength(1);
      expect(episode.trigger_id).toBe(`${scenario.scenario_id}-trigger1`);
      const readings = (evidence(scenario).glucose_events as Array<Record<string, any>>)
        .map((event) => ({ at: event.occurred_at as string, value: event.payload.glucose_value as number }));
      const opening = readings.find((reading) => reading.at === episode.started_at)!;
      const closing = readings.find((reading) => reading.at === episode.ended_at)!;
      // Opened by the first reading below 70, closed by the next reading at or above 70 (hypo.cgm.ada2026.v1).
      expect(classifyGlucoseReading(opening.value)).toBe(episode.severity);
      expect(readings.filter((reading) => reading.at < episode.started_at).every((reading) => classifyGlucoseReading(reading.value) === 'NORMAL')).toBe(true);
      expect(classifyGlucoseReading(closing.value)).toBe('NORMAL');
      expect(readings.filter((reading) => reading.at > episode.started_at && reading.at < episode.ended_at).every((reading) => classifyGlucoseReading(reading.value) !== 'NORMAL')).toBe(true);
      expect(episode.state).toBe('CLOSED');
    }
  });

  it('carries summaries and missing sections exactly as the worker computes them', () => {
    for (const scenario of scenarios) {
      const values = (evidence(scenario).glucose_events as Array<Record<string, any>>).map((event) => event.payload.glucose_value as number);
      const sections = { glucose_events: evidence(scenario).glucose_events, insulin_treatment_events: evidence(scenario).insulin_treatment_events, meal_events: evidence(scenario).meal_events, activity_events: evidence(scenario).activity_events, hypo_episodes: evidence(scenario).hypo_episodes };
      expect(evidence(scenario).summaries).toEqual({
        total_events: allEvents(scenario).length,
        glucose_count: values.length,
        insulin_treatment_count: evidence(scenario).insulin_treatment_events.length,
        meal_count: evidence(scenario).meal_events.length,
        activity_count: evidence(scenario).activity_events.length,
        hypo_episode_count: evidence(scenario).hypo_episodes.length,
        glucose_min: Math.min(...values),
        glucose_max: Math.max(...values),
        glucose_avg: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
        missing_sections: Object.entries(sections).filter(([, list]) => list.length === 0).map(([name]) => name),
      });
    }
  });

  it('sends the neutral request, not the evaluator description, as the user message', () => {
    for (const scenario of scenarios) {
      const [message] = scenario.base_context.conversation_context.messages;
      expect(message.content).toBe(scenario.base_context.analysis_request_input.user_message_text);
    }
  });

  it('lets a hand-written answer that states the v2 evidence correctly pass all eight criteria', () => {
    // Written from the fixture (Europe/Warsaw local times), not from any provider output.
    const answer = [
      'Glukoza wahała się od 67 mg/dL (o 11:42) do 128 mg/dL (o 11:12).',
      'O 11:02 zapisano 38 g węglowodanów, o 11:08 bolus 1,6 U, a o 12:25 kolejne 18 g.',
      'Między 11:42 a 12:02 wystąpił epizod hipoglikemii L1.',
      'Odczyty CGM są rzadkie: luki od 11:12 do 11:42, od 11:42 do 12:02 oraz od 12:02 do 14:30.',
      'Brak profilu terapii, więc ustawienia bazalu, ICR i ISF są nieznane. O 12:10 zapisano spacer.',
      'Kolejność zdarzeń nie dowodzi związku przyczynowego; bolus mógł przyczynić się do spadku, ale to niepotwierdzone.',
    ].join(' ');
    for (const scenario of scenarios) {
      const truth = buildTimeRangeEvidenceGroundTruth({ scenario_id: scenario.scenario_id, fixture_version: scenario.fixture_version, context: scenario.base_context });
      expect(gradeTimeRangeAnswer(answer, truth).grade_counts).toEqual({ PASS: 8, PARTIAL: 0, FAIL: 0, NOT_APPLICABLE: 0, UNRESOLVED: 0 });
    }
  });
});
