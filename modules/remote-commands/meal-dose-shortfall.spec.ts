import { describe, expect, it } from 'vitest';
import { calculatorHeldBackU, mealDoseShortfall } from './application/split-bolus';

const given = [{ purpose: 'NEW_MEAL', carbs_g: 30, bolus_units: 1.5 }];

describe('a meal bigger than its dose (meal-underdose.v1 helpers)', () => {
  it('counts the carbs not in the loop and the insulin for the carbs the dose does not cover', () => {
    // 50 g described; 1,5 j × ICR 10 covers 15 g → 35 g uncovered → 3,5 j; 20 g not yet in the loop.
    expect(mealDoseShortfall({ actions: given, meal_carbs_g: 50, icr_g_per_u: 10 })).toEqual({ carbs_g: 20, uncovered_g: 35, insulin_u: 3.5, given_carbs_g: 30, given_insulin_u: 1.5 });
  });

  it('says nothing when the dose covers the meal, without a dose or without ICR', () => {
    expect(mealDoseShortfall({ actions: [{ purpose: 'NEW_MEAL', carbs_g: 30, bolus_units: 3 }], meal_carbs_g: 30, icr_g_per_u: 10 })).toBeNull();
    expect(mealDoseShortfall({ actions: [{ purpose: 'NEW_MEAL', carbs_g: 30, bolus_units: 0 }], meal_carbs_g: 50, icr_g_per_u: 10 })).toBeNull();
    expect(mealDoseShortfall({ actions: given, meal_carbs_g: 50, icr_g_per_u: null })).toBeNull();
  });

  it('what the calculator held back on purpose is no shortfall (10.11, 11:16), a smaller dose chosen by hand is', () => {
    // 11 g, ICR 8,3: the calculator advised 0,3 j of 1,3 j (insulin on board), 0,7 j given.
    const meal1116 = [{ purpose: 'NEW_MEAL', carbs_g: 11, bolus_units: 0.7 }];
    const heldBack = calculatorHeldBackU([{ status: 'SUCCEEDED', icr_insulin_u: 1.3, context: { dose_calculation: { default_u: 0.3, icr_dose_u: 1.3 } } }]);
    expect(heldBack).toBeCloseTo(1, 5);
    expect(mealDoseShortfall({ actions: meal1116, meal_carbs_g: 11, icr_g_per_u: 8.3, held_back_u: heldBack })).toBeNull();
    // Without the calculator's context (its own smaller dose): the old "brakuje 0,6 j".
    expect(mealDoseShortfall({ actions: meal1116, meal_carbs_g: 11, icr_g_per_u: 8.3 })).toMatchObject({ insulin_u: 0.6 });
    // A failed or refused command held nothing back.
    expect(calculatorHeldBackU([{ status: 'REJECTED', icr_insulin_u: 1.3, context: { dose_calculation: { default_u: 0.3 } } }])).toBe(0);
  });
});
