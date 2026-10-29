import { describe, expect, it } from 'vitest';
import {
  createTimeRangeQualityCostFixtures,
  evaluateTimeRangeQualityRubric,
  type QualityDimensionId,
} from './time-range-quality-cost-experiment';

function dimensionGrade(message: string, fixtureId: 'fixture-progressive-valuable-v2' | 'fixture-all-relevant', dimension: QualityDimensionId) {
  const fixture = createTimeRangeQualityCostFixtures().find((entry) => entry.fixture_id === fixtureId);
  if (!fixture) {
    throw new Error(`Fixture not found: ${fixtureId}`);
  }
  const result = evaluateTimeRangeQualityRubric(message, fixture).find((entry) => entry.dimension === dimension);
  if (!result) {
    throw new Error(`Dimension not found: ${dimension}`);
  }
  return result.grade;
}

describe('time-range quality rubric grading', () => {
  it('awards PASS for semantic equivalents without requiring literal golden strings', () => {
    const message = [
      'The low appears to bottom near 67 mg/dL after dropping from about 132 earlier in the hour.',
      'A 1.6 U insulin bolus at 09:08 likely contributed, but this is not definitive causality.',
      'Basal context is relevant: planned 0.65 U/h with a temporary 0.95 U/h segment, and uncertainty remains.',
      'Activity and meal linkage are unknown from available records.',
      'At 09:57 glucose was 104 and rising.',
    ].join(' ');

    expect(dimensionGrade(message, 'fixture-progressive-valuable-v2', 'glucose_trajectory')).toBe('PASS');
    expect(dimensionGrade(message, 'fixture-progressive-valuable-v2', 'insulin_evidence')).toBe('PASS');
    expect(dimensionGrade(message, 'fixture-progressive-valuable-v2', 'unknown_semantics')).toBe('PASS');
    expect(dimensionGrade(message, 'fixture-progressive-valuable-v2', 'final_conclusion')).toBe('PASS');
  });

  it('does not fail glucose trajectory on literal mismatch when meaning is preserved', () => {
    const message = 'Nadir was 49 mg/dL and the trace fell from 118 toward the hypo range before recovering.';
    const grade = dimensionGrade(message, 'fixture-all-relevant', 'glucose_trajectory');
    expect(grade).toBe('PASS');
  });

  it('still detects forbidden assumptions', () => {
    const message = [
      'Glucose reached 67 mg/dL after declining from 132.',
      'There was no activity and that definitively proves a single cause.',
      'Insulin 1.6 U at 09:08 caused the event.',
    ].join(' ');
    expect(dimensionGrade(message, 'fixture-progressive-valuable-v2', 'unnecessary_assumptions')).toBe('FAIL');
  });

  it('returns UNRESOLVED when evidence in response is too vague to grade reliably', () => {
    const message = 'I cannot determine the explanation from the available information.';
    expect(dimensionGrade(message, 'fixture-progressive-valuable-v2', 'glucose_trajectory')).toBe('UNRESOLVED');
    expect(dimensionGrade(message, 'fixture-progressive-valuable-v2', 'provenance_grounding')).toBe('UNRESOLVED');
    expect(dimensionGrade(message, 'fixture-progressive-valuable-v2', 'final_conclusion')).toBe('UNRESOLVED');
  });
});
