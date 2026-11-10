import { describe, expect, it } from 'vitest';
import { detectMealUnderdose, isMealUnderdoseEnabled, mealUnderdosePush, type MealUnderdoseInput } from './meal-underdose';

const start = '2026-11-10T12:00:00.000Z';
const at = (min: number) => new Date(Date.parse(start) + min * 60_000).toISOString();
const rising = (to: number) => [
  { at: at(0), mgdl: 130 },
  { at: at(45), mgdl: to - 30 },
  { at: at(60), mgdl: to },
];
const base = (over: Partial<MealUnderdoseInput> = {}): MealUnderdoseInput => ({
  meal_started_at: start,
  meal_carbs_g: 32,
  icr_g_per_u: 10,
  boluses: [{ started_at: at(-2), units: 1.5 }],
  rest_planned: false,
  readings: rising(214),
  now: new Date(at(60)),
  ...over,
});

describe('detectMealUnderdose (meal-underdose.v1)', () => {
  it('fires for a half dose with a fast rise', () => {
    const found = detectMealUnderdose(base());
    expect(found).toMatchObject({ given_u: 1.5, icr_dose_u: 3.2, short_u: 1.7, glucose_mgdl: 214, start_mgdl: 130, slope_mgdl_min: 2, minutes_after: 60 });
  });
  it('stays quiet when the rest is planned (part or reminder)', () => {
    expect(detectMealUnderdose(base({ rest_planned: true }))).toBeNull();
  });
  it('stays quiet after any later bolus (a top-up already given)', () => {
    expect(detectMealUnderdose(base({ boluses: [{ started_at: at(-2), units: 1.5 }, { started_at: at(40), units: 0.6 }] }))).toBeNull();
  });
  it('counts what the calculator held back as covered', () => {
    expect(detectMealUnderdose(base({ held_back_u: 1.2 }))).toBeNull();
  });
  it('needs 80% or less and at least 0,4 j short', () => {
    expect(detectMealUnderdose(base({ boluses: [{ started_at: at(-2), units: 2.6 }] }))).toBeNull();
    expect(detectMealUnderdose(base({ meal_carbs_g: 8, boluses: [{ started_at: at(-2), units: 0.5 }] }))).toBeNull();
  });
  it('stays quiet without meal insulin, too early or too late', () => {
    expect(detectMealUnderdose(base({ boluses: [] }))).toBeNull();
    expect(detectMealUnderdose(base({ now: new Date(at(25)) }))).toBeNull();
    expect(detectMealUnderdose(base({ now: new Date(at(125)), readings: [{ at: at(0), mgdl: 130 }, { at: at(110), mgdl: 190 }, { at: at(125), mgdl: 220 }] }))).toBeNull();
  });
  it('needs ≥ 180, ≥ +40 from start and ≥ 1,5/min', () => {
    expect(detectMealUnderdose(base({ readings: rising(175) }))).toBeNull();
    expect(detectMealUnderdose(base({ readings: [{ at: at(0), mgdl: 160 }, { at: at(45), mgdl: 170 }, { at: at(60), mgdl: 195 }] }))).toBeNull();
    expect(detectMealUnderdose(base({ readings: [{ at: at(0), mgdl: 130 }, { at: at(45), mgdl: 200 }, { at: at(60), mgdl: 214 }] }))).toBeNull();
  });
  it('needs fresh readings', () => {
    expect(detectMealUnderdose(base({ readings: [{ at: at(0), mgdl: 130 }, { at: at(45), mgdl: 184 }] }))).toBeNull();
  });
  it('push text', () => {
    const found = detectMealUnderdose(base())!;
    expect(mealUnderdosePush({ meal_name: 'Obiad', found })).toEqual({
      title: 'Dawka mniejsza niż z przelicznika',
      body: 'Do posiłku „Obiad” podano 1,5 j z 3,2 j. Glukoza 214 i rośnie. Dotknij, aby policzyć resztę.',
    });
  });
});

describe('MEAL_UNDERDOSE_ENABLED', () => {
  it('is off unless switched on', () => {
    expect(isMealUnderdoseEnabled({})).toBe(false);
    expect(isMealUnderdoseEnabled({ MEAL_UNDERDOSE_ENABLED: 'false' })).toBe(false);
    expect(isMealUnderdoseEnabled({ MEAL_UNDERDOSE_ENABLED: 'true' })).toBe(true);
  });
});
