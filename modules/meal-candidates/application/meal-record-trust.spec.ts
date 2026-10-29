import { describe, expect, it } from 'vitest';
import { canTransitionMealRecord, isTrustedMealRecord, selectMealsForAiContext, toMealContextItem, type MealRecord } from './meal-record-trust';

const none = { grams: null, origin: null };

function record(identity: string, status: MealRecord['status'], extra: Partial<MealRecord> = {}): MealRecord {
  return {
    meal_identity: identity,
    status,
    started_at: '2026-11-02T07:00:00.000Z',
    source_carbs_g: 40,
    description: null,
    has_photo: false,
    macros: { carbs: none, protein: none, fat: none },
    ...extra,
  };
}

describe('meal record trust', () => {
  it('trusts only caregiver-confirmed or corrected records', () => {
    expect(['AWAITING_DESCRIPTION', 'DESCRIBED', 'AI_PROPOSED', 'CANCELLED', 'INCOMPLETE'].map((status) => isTrustedMealRecord({ status: status as MealRecord['status'] }))).toEqual([false, false, false, false, false]);
    expect(isTrustedMealRecord({ status: 'CONFIRMED' })).toBe(true);
    expect(isTrustedMealRecord({ status: 'CORRECTED' })).toBe(true);
  });

  it('never lets an AI proposal become trusted without the caregiver', () => {
    expect(canTransitionMealRecord('AWAITING_DESCRIPTION', 'CONFIRMED')).toBe(false);
    expect(canTransitionMealRecord('DESCRIBED', 'CONFIRMED')).toBe(false);
    expect(canTransitionMealRecord('AI_PROPOSED', 'CONFIRMED')).toBe(true);
    expect(canTransitionMealRecord('CANCELLED', 'CONFIRMED')).toBe(false);
  });

  it('keeps unconfirmed AI macros out of known values', () => {
    const proposed = record('m-proposed', 'AI_PROPOSED', {
      description: 'naleśniki z serem',
      macros: { carbs: { grams: 55, origin: 'AI_PROPOSAL' }, protein: { grams: 18, origin: 'AI_PROPOSAL' }, fat: { grams: 12, origin: 'AI_PROPOSAL' } },
    });
    const item = toMealContextItem(proposed)!;
    expect(item.trusted).toBe(false);
    expect(item.carbs).toEqual({ value: 40, knowledge_status: 'KNOWN', origin: 'OBSERVED' });
    expect(item.protein).toEqual({ value: null, knowledge_status: 'UNKNOWN', origin: 'INFERRED', unconfirmed_proposal_g: 18 });
    expect(item.fat).toEqual({ value: null, knowledge_status: 'UNKNOWN', origin: 'INFERRED', unconfirmed_proposal_g: 12 });
  });

  it('never invents protein or fat for an unconfirmed meal', () => {
    const awaiting = record('m-awaiting', 'AWAITING_DESCRIPTION', { macros: { carbs: none, protein: { grams: 0, origin: null }, fat: { grams: 0, origin: null } } });
    const item = toMealContextItem(awaiting)!;
    expect(item.carbs).toEqual({ value: 40, knowledge_status: 'KNOWN', origin: 'OBSERVED' });
    expect(item.protein).toEqual({ value: null, knowledge_status: 'UNKNOWN', origin: null });
    expect(item.fat).toEqual({ value: null, knowledge_status: 'UNKNOWN', origin: null });
  });

  it('builds AI context from confirmed meals, keeping unconfirmed ones apart', () => {
    const selection = selectMealsForAiContext([
      record('m-confirmed', 'CONFIRMED', {
        description: 'owsianka z bananem',
        macros: { carbs: { grams: 45, origin: 'CAREGIVER' }, protein: { grams: 9, origin: 'CAREGIVER' }, fat: { grams: 6, origin: 'CAREGIVER' } },
      }),
      record('m-corrected', 'CORRECTED', {
        started_at: '2026-11-02T12:00:00.000Z',
        description: 'zupa pomidorowa',
        macros: { carbs: { grams: 30, origin: 'CAREGIVER' }, protein: { grams: 7, origin: 'CAREGIVER' }, fat: { grams: null, origin: null } },
      }),
      record('m-awaiting', 'AWAITING_DESCRIPTION', { started_at: '2026-11-02T18:00:00.000Z' }),
      record('m-cancelled', 'CANCELLED'),
    ]);

    expect(selection.trusted.map((item) => item.meal_identity)).toEqual(['m-confirmed', 'm-corrected']);
    expect(selection.trusted[0].protein).toEqual({ value: 9, knowledge_status: 'KNOWN', origin: 'REPORTED', value_source: 'CAREGIVER' });
    expect(selection.trusted[1].fat).toEqual({ value: null, knowledge_status: 'UNKNOWN', origin: null });
    expect(selection.unconfirmed.map((item) => item.meal_identity)).toEqual(['m-awaiting']);
    expect(selection.excluded_count).toBe(1);
  });

  it('keeps an accepted AI estimate distinguishable from caregiver-entered values', () => {
    const accepted = toMealContextItem(record('m-accepted', 'CONFIRMED', {
      macros: { carbs: { grams: 50, origin: 'AI_PROPOSAL' }, protein: { grams: 12, origin: 'AI_PROPOSAL' }, fat: { grams: 8, origin: 'CAREGIVER' } },
    }))!;
    expect(accepted.trusted).toBe(true);
    expect(accepted.protein).toEqual({ value: 12, knowledge_status: 'KNOWN', origin: 'REPORTED', value_source: 'AI_PROPOSAL' });
    expect(accepted.fat).toEqual({ value: 8, knowledge_status: 'KNOWN', origin: 'REPORTED', value_source: 'CAREGIVER' });
    expect(accepted.source_carbs_g).toBe(40);
  });

  it('keeps evidence-excluded meals out of AI context without changing their status', () => {
    const excluded = record('m-excluded', 'CONFIRMED', {
      evidence_excluded: true,
      macros: { carbs: { grams: 50, origin: 'CAREGIVER' }, protein: { grams: 12, origin: 'CAREGIVER' }, fat: { grams: 8, origin: 'CAREGIVER' } },
    });
    expect(toMealContextItem(excluded)).toBeNull();
    expect(selectMealsForAiContext([excluded, record('m-ok', 'AWAITING_DESCRIPTION')])).toMatchObject({ trusted: [], unconfirmed: [{ meal_identity: 'm-ok' }], excluded_count: 1 });
    expect(toMealContextItem({ ...excluded, evidence_excluded: false })?.trusted).toBe(true);
  });
});
