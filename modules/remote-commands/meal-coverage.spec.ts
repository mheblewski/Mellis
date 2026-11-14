import { describe, expect, it } from 'vitest';
import { mealCoverage, type MealCoverageInput } from './application/meal-coverage';

const TZ = 'Europe/Warsaw';
// 2026-11-11 is CET (UTC+1): 10:30Z = 11:30.
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 11, h - 1, m)).toISOString();
};
const dose = (id: string, time: string, units: number, carbs: number, purpose = 'MEAL_ADDITION') => ({ id, started_at: at(time), purpose, carbs_g: carbs, bolus_units: units });

function input(overrides: Partial<MealCoverageInput> = {}): MealCoverageInput {
  return {
    meal_carbs_g: 32,
    meal_carbs_origin: 'CAREGIVER',
    icr_g_per_u: 8.3,
    actions: [dose('a1', '11:30', 1.2, 10, 'NEW_MEAL'), dose('a2', '11:37', 1.2, 10), dose('a3', '11:48', 1.4, 10)],
    commands: [],
    parts: [],
    held_back_u: 0,
    excess_u: null,
    step: 0.1,
    time_zone: TZ,
    loop_name: 'Trio',
    ...overrides,
  };
}

describe('mealCoverage (meal-coverage.v1)', () => {
  it('chips 2026-11-11: three doses cover the meal, no empty end and no "z X j"', () => {
    const coverage = mealCoverage(input())!;
    expect(coverage.headline).toBe('3,8 j na 32 g');
    expect(coverage.icr_u).toBe(3.9);
    expect(coverage.segments.map((s) => [s.kind, s.insulin_u])).toEqual([['GIVEN', 1.2], ['GIVEN', 1.2], ['GIVEN', 1.4]]);
    expect(coverage.excess_u).toBe(0);
    expect(coverage.notes).toEqual([]);
    expect(coverage.accessibility_label).toBe('Insulina na węglowodany: podano 3,8 j na 32 g');
  });

  it('one dose: no bar, the headline says so', () => {
    const coverage = mealCoverage(input({ actions: [dose('a1', '11:30', 3.9, 32, 'NEW_MEAL')] }))!;
    expect(coverage.segments).toEqual([]);
    expect(coverage.headline).toBe('3,9 j na 32 g · jedna dawka');
  });

  it('a later part to come: hatched segment and its time, never a gap', () => {
    const coverage = mealCoverage(input({
      meal_carbs_g: 80, icr_g_per_u: 10,
      actions: [dose('a1', '18:05', 4, 40, 'NEW_MEAL')],
      parts: [{ id: 'p1', status: 'SCHEDULED', due_at: at('19:35'), planned_insulin_u: 4, fixed_insulin_u: null }],
    }))!;
    expect(coverage.headline).toBe('4 j podane · 4 j o 19:35');
    expect(coverage.segments.map((s) => s.kind)).toEqual(['GIVEN', 'PLANNED']);
  });

  it('what the calculator held back is drawn as covered and named without "IOB"', () => {
    const coverage = mealCoverage(input({ meal_carbs_g: 40, icr_g_per_u: 8, actions: [dose('a1', '13:10', 3.6, 40, 'NEW_MEAL')], held_back_u: 1.4 }))!;
    expect(coverage.segments.map((s) => [s.kind, s.insulin_u])).toEqual([['GIVEN', 3.6], ['HELD', 1.4]]);
    expect(coverage.headline).toBe('3,6 j na 40 g');
    expect(coverage.notes).toEqual(['1,4 j mniej: insulina z wcześniejszych dawek jeszcze działała.']);
  });

  it('a real rest (as the action card) is the only empty end, and the only "z X j"', () => {
    const coverage = mealCoverage(input({ actions: [dose('a1', '11:30', 2.4, 20, 'NEW_MEAL')] }))!;
    // 32 − 2,4 × 8,3 = 12,1 g → 1,4 j.
    expect(coverage.segments.map((s) => [s.kind, s.insulin_u])).toEqual([['GIVEN', 2.4], ['GAP', 1.4]]);
    expect(coverage.headline).toBe('2,4 j z 3,9 j');
  });

  it('a small rest below ~0,5 j is no gap (rounding is not a to-do)', () => {
    const coverage = mealCoverage(input({ actions: [dose('a1', '11:30', 1.8, 15, 'NEW_MEAL'), dose('a2', '11:40', 1.8, 15)] }))!;
    expect(coverage.segments.some((s) => s.kind === 'GAP')).toBe(false);
    expect(coverage.headline).toBe('3,6 j na 32 g');
  });

  it('a dose on its way is an outline, counted, and keeps the gap away', () => {
    const coverage = mealCoverage(input({
      actions: [dose('a1', '11:30', 2.4, 20, 'NEW_MEAL')],
      commands: [{ id: 'c2', status: 'UNCERTAIN', purpose: null, insulin_u: 1.4, authorized_at: at('11:40'), loop_action_id: null, planned_bolus_id: null }],
    }))!;
    expect(coverage.segments.map((s) => s.kind)).toEqual(['GIVEN', 'IN_FLIGHT']);
    expect(coverage.headline).toBe('3,8 j na 32 g');
    expect(coverage.notes).toEqual(['1,4 j o 11:40: sprawdzam, czy doszło.']);
  });

  it('a sent dose waits for the loop; a part being sent is not also planned; WBT and matched commands stay out', () => {
    const coverage = mealCoverage(input({
      meal_carbs_g: 80, icr_g_per_u: 10,
      actions: [dose('a1', '18:05', 4, 40, 'NEW_MEAL')],
      parts: [{ id: 'p1', status: 'NOTIFIED', due_at: at('19:35'), planned_insulin_u: 4, fixed_insulin_u: null }],
      commands: [
        { id: 'c0', status: 'SUCCEEDED', purpose: null, insulin_u: 4, authorized_at: at('18:05'), loop_action_id: 'a1', planned_bolus_id: null },
        { id: 'c1', status: 'SENT', purpose: 'MEAL_PART', insulin_u: 4, authorized_at: at('19:36'), loop_action_id: null, planned_bolus_id: 'p1' },
        { id: 'c2', status: 'SENT', purpose: 'WBT', insulin_u: 1, authorized_at: at('19:36'), loop_action_id: null, planned_bolus_id: null },
      ],
    }))!;
    expect(coverage.segments.map((s) => s.kind)).toEqual(['GIVEN', 'IN_FLIGHT']);
    expect(coverage.notes).toEqual(['4 j wysłano o 19:36, czekam na Trio.']);
  });

  it('the dose excess is the end of the bar, not more than was given', () => {
    const coverage = mealCoverage(input({ meal_carbs_g: 20, excess_u: 1.4 }))!;
    expect(coverage.excess_u).toBe(1.4);
    expect(mealCoverage(input({ excess_u: 9 }))!.excess_u).toBe(3.8);
  });

  it('no bar without an honest count: Nightscout carbs, no ICR, nothing given', () => {
    expect(mealCoverage(input({ meal_carbs_origin: 'NIGHTSCOUT_ENTRY' }))).toBeNull();
    expect(mealCoverage(input({ meal_carbs_origin: null }))).toBeNull();
    expect(mealCoverage(input({ icr_g_per_u: null }))).toBeNull();
    expect(mealCoverage(input({ actions: [] }))).toBeNull();
    expect(mealCoverage(input({ actions: [{ ...dose('w', '13:00', 1, 0), purpose: 'WBT' }] }))).toBeNull();
  });

  it('a pre-bolus counts for the meal', () => {
    const coverage = mealCoverage(input({ actions: [dose('p', '11:15', 2, 0, 'PRE_BOLUS'), dose('a1', '11:30', 1.9, 32, 'NEW_MEAL')] }))!;
    expect(coverage.headline).toBe('3,9 j na 32 g');
    expect(coverage.segments).toHaveLength(2);
  });

  it('another meal with a bolus within the hour is named (the 11:53 dose saved as a new meal)', () => {
    const coverage = mealCoverage(input({ neighbours: [{ meal_id: 'm2', started_at: at('11:53'), insulin_u: 2.4, carbs_g: 20 }] }))!;
    expect(coverage.neighbours).toEqual([{ meal_id: 'm2', started_at: at('11:53'), insulin_u: 2.4, carbs_g: 20, line: 'O 11:53 zapisano osobny posiłek: 2,4 j na 20 g.' }]);
  });
});

describe('journalReminders: a part closed by the meal doses', () => {
  it('says why instead of "wyłączone"', async () => {
    const { journalReminders } = await import('@modules/meal-journal/application/meal-journal');
    const part = { id: 'p1', status: 'CANCELLED', cancelled_by_meal_doses: true, due_at: at('11:55'), notified_at: null, trigger: 'AFTER_MINUTES', threshold_mgdl: null, wait_until: null } as any;
    const [reminder] = journalReminders({ wbt: null, care: [], parts: [part], actions: [], awaiting_units: new Map() }, new Date(at('12:30')));
    expect(reminder).toMatchObject({ id: 'p1', status: 'OFF', note: 'niepotrzebna: pokryły ją dopisane dawki' });
    const [other] = journalReminders({ wbt: null, care: [], parts: [{ ...part, cancelled_by_meal_doses: false }], actions: [], awaiting_units: new Map() }, new Date(at('12:30')));
    expect(other.note).toBeUndefined();
  });
});
