import { describe, expect, it } from 'vitest';
import { computeSplitAdvice, mealFatProteinShare } from './application/split-advice';

describe('when to split a meal bolus (split-advice.v1)', () => {
  it('splits a child\'s small fatty meal 60/40 although it has under 20 g fat (half a small fries + 6 nuggets)', () => {
    expect(mealFatProteinShare({ carbs_g: 33.6, protein_g: 18.4, fat_g: 19.9 })).toEqual({ wbt_per_ww: 0.75, fat_energy_percent: 46 });
    expect(computeSplitAdvice({ carbs_g: 33.6, protein_g: 18.4, fat_g: 19.9 })).toMatchObject({ level: 'STRONG', now_percent: 60, after_minutes: 90, now_carbs_g: 20, later_carbs_g: 14 });
  });

  it('70/30 for a moderately fatty meal, one bolus for a lean one or the same fat on an adult\'s plate', () => {
    // Breaded pork chop with potatoes: 0,55 WBT/WW, fat 41% -> 60/40; a lean soup: none.
    expect(computeSplitAdvice({ carbs_g: 36.4, protein_g: 15, fat_g: 15.7 })?.level).toBe('STRONG');
    expect(computeSplitAdvice({ carbs_g: 40, protein_g: 15, fat_g: 14 })).toMatchObject({ level: 'MILD', now_percent: 70, after_minutes: 60, now_carbs_g: 28, later_carbs_g: 12 });
    expect(computeSplitAdvice({ carbs_g: 23.9, protein_g: 5.5, fat_g: 5 })).toBeNull();
    expect(computeSplitAdvice({ carbs_g: 90, protein_g: 18, fat_g: 20 })).toBeNull();
  });

  it('steps up for the patient\'s own history, keeps 60% now at most, and leaves tiny meals whole', () => {
    expect(computeSplitAdvice({ carbs_g: 40, protein_g: 15, fat_g: 14 }, true)?.level).toBe('STRONG');
    expect(computeSplitAdvice({ carbs_g: 23.9, protein_g: 5.5, fat_g: 5 }, true)?.level).toBe('MILD');
    expect(computeSplitAdvice({ carbs_g: 33.6, protein_g: 18.4, fat_g: 19.9 }, true)?.now_percent).toBe(60);
    expect(computeSplitAdvice({ carbs_g: 8, protein_g: 10, fat_g: 10 })).toBeNull();
  });
});
