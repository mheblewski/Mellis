import { describe, expect, it } from 'vitest';
import { mealDoseChoice } from './bolus-proposal-tool';

const calc = (over: Record<string, unknown> = {}) => ({ default_u: 1.5, carbs_first: false, limited_by: 'IOB', ...over }) as never;
const base = { icr_dose_u: 3, drop_adjustment: null, correction: null, standard_plan: false, add_correction: false, step: 0.05 };

describe('mealDoseChoice (dose-basis.v1)', () => {
  it('by ICR: the ICR dose, the calculator offered as a variant', () => {
    expect(mealDoseChoice({ ...base, calculation: calc(), dose_basis: 'ICR' })).toEqual({ insulin: 3, calculatorLower: true, appliedAdjustment: null, correctionApplied: false });
  });
  it('by the calculator: the lower of both', () => {
    expect(mealDoseChoice({ ...base, calculation: calc(), dose_basis: 'CALCULATOR' })).toMatchObject({ insulin: 1.5, calculatorLower: false });
  });
  it('carbs first keeps the calculator\'s 0 j whatever the basis, and no correction', () => {
    const correction = { dose_u: 0.5 } as never;
    expect(mealDoseChoice({ ...base, calculation: calc({ default_u: 0, carbs_first: true }), dose_basis: 'ICR', correction, add_correction: true })).toEqual({ insulin: 0, calculatorLower: false, appliedAdjustment: null, correctionApplied: false });
  });
  it('the standard plan is always by ICR, without the calculator variant', () => {
    expect(mealDoseChoice({ ...base, calculation: calc({ default_u: 0, carbs_first: true }), dose_basis: 'CALCULATOR', standard_plan: true })).toMatchObject({ insulin: 3, calculatorLower: false });
  });
  it('a drop lowering applies only by the calculator; a correction only when asked', () => {
    const drop = { dose_u: 2 } as never;
    expect(mealDoseChoice({ ...base, calculation: calc({ limited_by: 'DROP' }), drop_adjustment: drop, dose_basis: 'CALCULATOR' }).appliedAdjustment).toBe(drop);
    expect(mealDoseChoice({ ...base, calculation: calc({ limited_by: 'DROP' }), drop_adjustment: drop, dose_basis: 'ICR' }).appliedAdjustment).toBeNull();
    expect(mealDoseChoice({ ...base, calculation: calc(), dose_basis: 'ICR', correction: { dose_u: 0.5 } as never, add_correction: true })).toMatchObject({ insulin: 3.5, correctionApplied: true });
  });
});
