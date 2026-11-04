import { describe, expect, it } from 'vitest';
import { pickAttachTarget, type AttachMeal } from './meal-attach';

const at = (minutesBefore: number) => new Date(Date.parse('2026-11-03T14:10:00Z') - minutesBefore * 60_000).toISOString();
const meal = (id: string, minutesBefore: number, carbs: number | null, insulin: number | null): AttachMeal => ({ meal_id: id, started_at: at(minutesBefore), carbs_g: carbs, insulin_total_u: insulin });

describe('pickAttachTarget (meal-attach.v1)', () => {
  const dose = meal('dose', 0, 15, 1.5);

  it('picks the newest bigger meal within 3 hours', () => {
    const target = pickAttachTarget(dose, [meal('lunch', 85, 60, 6), meal('snack', 30, 10, 1), meal('breakfast', 170, 50, 5)]);
    expect(target?.meal_id).toBe('lunch');
  });

  it('counts more insulin alone as bigger', () => {
    expect(pickAttachTarget(dose, [meal('correction-meal', 40, 10, 3)])?.meal_id).toBe('correction-meal');
  });

  it('leaves out meals 3 hours back or more, later meals, smaller ones and the meal itself', () => {
    expect(pickAttachTarget(dose, [meal('old', 180, 80, 8), meal('later', -5, 80, 8), meal('small', 20, 15, 1.5), meal('dose', 0, 90, 9)])).toBeNull();
  });

  it('treats missing values as none', () => {
    expect(pickAttachTarget(meal('dose', 0, null, null), [meal('carbs-only', 60, 20, null)])?.meal_id).toBe('carbs-only');
    expect(pickAttachTarget(dose, [meal('empty', 60, null, null)])).toBeNull();
  });
});
