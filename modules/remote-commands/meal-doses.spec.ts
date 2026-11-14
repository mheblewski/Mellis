import { describe, expect, it } from 'vitest';
import { PlannedBolusService, type PlannedBolusStore } from './application/planned-bolus.service';
import {
  bolusesSinceMealForPart,
  mealDoseLedger,
  mealDosesCoverUpdates,
  plannedBolusPushContent,
  type MealDoseLedger,
  type PlannedBolusRecord,
} from './application/split-bolus';

// meal-doses.v1 (owner 2026-11-11, "Chipsy jabłkowe" on the family server): the meal's later parts follow every dose
// given for the meal, not only changes of its carbs.

const MEAL = '98ace3cb-f4bb-4da3-bf95-08b6a3d8ab83';

function part(overrides: Partial<PlannedBolusRecord> = {}): PlannedBolusRecord {
  return {
    id: 'rest-1', kind: 'SPLIT', patient_id: 'p1', meal_record_id: MEAL, proposal_id: null, conversation_id: null, first_command_id: null,
    first_carbs_g: 10, first_insulin_u: 1.2, carbs_g: 22, planned_insulin_u: 2.3, icr_g_per_u: 8.3, now_percent: 31, delay_minutes: 0,
    due_at: '2026-11-11T10:55:38.000Z', status: 'SCHEDULED', notified_at: null, resolved_at: null, resolved_by_user_id: null, resolved_by_name: null,
    given_command_id: null, given_loop_action_id: null, given_insulin_u: null, created_at: '2026-11-11T10:40:38.000Z',
    trigger: 'AFTER_MINUTES', threshold_mgdl: null, dose_carbs_g: 20, fixed_insulin_u: null, drop_cover_g: null, subtract_first_insulin: false,
    wait_until: null, part_index: 0, meal_carbs_g: null, meal_change_g: 0, cancelled_by_meal_change: false, meal_excess_g: 0,
    ...overrides,
  };
}

const dose = (carbs: number, insulin: number, purpose = 'MEAL_ADDITION') => ({ purpose, carbs_g: carbs, bolus_units: insulin });

/** Applies the updates as the repository does (followMealDoses). */
function apply(parts: PlannedBolusRecord[], ledger: MealDoseLedger, step = 0.1): PlannedBolusRecord[] {
  const updates = mealDosesCoverUpdates(parts, ledger, step);
  return parts.map((row) => {
    const update = updates.find((candidate) => candidate.plan_id === row.id);
    if (!update) return row;
    return {
      ...row,
      carbs_g: update.carbs_g,
      dose_carbs_g: update.dose_carbs_g,
      planned_insulin_u: update.planned_insulin_u,
      fixed_insulin_u: update.fixed_insulin_u,
      doses_cover_carbs_g: update.doses_cover_carbs_g,
      doses_cover_dose_g: update.doses_cover_dose_g,
      doses_cover_insulin_u: update.doses_cover_insulin_u,
      status: update.cancel ? 'CANCELLED' : update.reopen ? (row.notified_at ? 'NOTIFIED' : 'SCHEDULED') : row.status,
      cancelled_by_meal_doses: update.cancel ? true : update.reopen ? false : row.cancelled_by_meal_doses,
    };
  });
}

function ledgerOf(actions: Array<ReturnType<typeof dose>>, parts: PlannedBolusRecord[], mealCarbs = 32): MealDoseLedger {
  const ledger = mealDoseLedger({ actions, meal_carbs_g: mealCarbs, meal_carbs_origin: 'AI_PROPOSAL', parts });
  if (!ledger) throw new Error('no ledger');
  return ledger;
}

describe('meal-doses.v1: the chips of 2026-11-11', () => {
  // 11:37 10 g + 1,2 j (the meal's own), 11:40 described 32 g → rest 22 g / dose for 20 g / 2,3 j; 11:41 the 11:30 dose
  // (10 g + 1,2 j) joined the meal, 11:49 a third one (10 g + 1,4 j).
  const own = dose(10, 1.2, 'NEW_MEAL');

  it('the 11:30 dose joined after the rest was made takes its share off', () => {
    const [rest] = apply([part()], ledgerOf([own, dose(10, 1.2)], [part()]));
    expect(rest.carbs_g).toBe(12);
    expect(rest.dose_carbs_g).toBe(12);
    expect(rest.planned_insulin_u).toBeCloseTo(1.3, 2);
    expect(rest.status).toBe('SCHEDULED');
  });

  it('the third dose leaves nothing to give: the rest is cancelled by the doses, not pushed at 22 g', () => {
    const actions = [own, dose(10, 1.2), dose(10, 1.4)];
    const [rest] = apply([part()], ledgerOf(actions, [part()]));
    expect(rest.status).toBe('CANCELLED');
    expect(rest.cancelled_by_meal_doses).toBe(true);
    expect(rest.carbs_g).toBe(2);
    expect(rest.planned_insulin_u).toBe(0);
  });

  it('step by step reaches the same as all at once (idempotent, nothing taken twice)', () => {
    let rows = [part()];
    rows = apply(rows, ledgerOf([own, dose(10, 1.2)], rows));
    rows = apply(rows, ledgerOf([own, dose(10, 1.2)], rows));
    expect(rows[0].carbs_g).toBe(12);
    rows = apply(rows, ledgerOf([own, dose(10, 1.2), dose(10, 1.4)], rows));
    expect(rows[0].status).toBe('CANCELLED');
    expect(mealDosesCoverUpdates(rows, ledgerOf([own, dose(10, 1.2), dose(10, 1.4)], rows), 0.1)).toEqual([]);
  });

  it('a dose taken off the meal again gives the part back', () => {
    let rows = apply([part()], ledgerOf([own, dose(10, 1.2), dose(10, 1.4)], [part()]));
    expect(rows[0].status).toBe('CANCELLED');
    rows = apply(rows, ledgerOf([own], rows));
    expect(rows[0].status).toBe('SCHEDULED');
    expect(rows[0].carbs_g).toBe(22);
    expect(rows[0].dose_carbs_g).toBe(20);
    expect(rows[0].planned_insulin_u).toBeCloseTo(2.3, 2);
    expect(rows[0].doses_cover_carbs_g).toBe(0);
  });
});

describe('meal-doses.v1: what it must not do', () => {
  it('a meal made bigger with its own dose ("Do posiłku", carbs added) keeps its rest', () => {
    // 32 g + 10 g of dessert with 1,2 j: the rest of the chips still waits.
    const rows = [part()];
    expect(mealDosesCoverUpdates(rows, ledgerOf([dose(10, 1.2, 'NEW_MEAL'), dose(10, 1.2)], rows, 42), 0.1)).toEqual([]);
  });

  it('carbs sent without insulin come off the carbs to send, never off the dose', () => {
    const [rest] = apply([part()], ledgerOf([dose(10, 1.2, 'NEW_MEAL'), dose(10, 0)], [part()]));
    expect(rest.carbs_g).toBe(12);
    expect(rest.dose_carbs_g).toBe(20);
    expect(rest.planned_insulin_u).toBeCloseTo(2.3, 2);
  });

  it('a split card keeps its later part when only its first part was given (calculator held back insulin)', () => {
    // 40 g card: 20 g now with 1,5 j (the calculator held 0,9 j back), 20 g later.
    const card = part({ proposal_id: 'b1', first_command_id: 'cmd-1', first_carbs_g: 20, first_insulin_u: 1.5, carbs_g: 20, dose_carbs_g: null, planned_insulin_u: 2.4, meal_carbs_g: 40, icr_g_per_u: 8.3 });
    const ledger = mealDoseLedger({ actions: [dose(20, 1.5, 'NEW_MEAL')], meal_carbs_g: 40, meal_carbs_origin: 'AI_PROPOSAL', parts: [card], held_back_u: 0.9 })!;
    expect(mealDosesCoverUpdates([card], ledger, 0.1)).toEqual([]);
  });

  it('a split card\'s next part shrinks by a dose of the same food added to the meal', () => {
    const card = part({ proposal_id: 'b1', first_command_id: 'cmd-1', first_carbs_g: 20, first_insulin_u: 2.4, carbs_g: 20, dose_carbs_g: null, planned_insulin_u: 2.4, meal_carbs_g: 40, icr_g_per_u: 8.3 });
    const [next] = apply([card], ledgerOf([dose(20, 2.4, 'NEW_MEAL'), dose(10, 1.2)], [card], 40));
    expect(next.carbs_g).toBe(10);
    expect(next.dose_carbs_g).toBe(10);
    expect(next.status).toBe('SCHEDULED');
  });

  it('carbs read from Nightscout entries are no whole meal: no ledger, the parts stay', () => {
    expect(mealDoseLedger({ actions: [dose(20, 2.4, 'NEW_MEAL')], meal_carbs_g: 20, meal_carbs_origin: 'NIGHTSCOUT_ENTRY', parts: [part({ meal_carbs_g: null })] })).toBeNull();
    // …unless the parts know the meal they were made for.
    expect(mealDoseLedger({ actions: [dose(20, 2.4, 'NEW_MEAL')], meal_carbs_g: 20, meal_carbs_origin: 'NIGHTSCOUT_ENTRY', parts: [part({ meal_carbs_g: 40 })] })?.meal_carbs_g).toBe(40);
  });

  it('no ICR or no insulin given: no ledger', () => {
    expect(mealDoseLedger({ actions: [dose(20, 2.4, 'NEW_MEAL')], meal_carbs_g: 40, meal_carbs_origin: 'AI_PROPOSAL', parts: [part({ icr_g_per_u: null })] })).toBeNull();
    expect(mealDoseLedger({ actions: [dose(20, 0, 'NEW_MEAL')], meal_carbs_g: 40, meal_carbs_origin: 'AI_PROPOSAL', parts: [part()] })).toBeNull();
  });

  it('pre-boluses and other meals\' doses are not the meal\'s', () => {
    const ledger = mealDoseLedger({ actions: [dose(10, 1.2, 'NEW_MEAL'), dose(0, 1, 'PRE_BOLUS'), dose(0, 1, 'CORRECTION')], meal_carbs_g: 32, meal_carbs_origin: 'AI_PROPOSAL', parts: [part()] });
    expect(ledger?.given_insulin_u).toBe(1.2);
  });

  it('a part on its way to the loop keeps its numbers and its share; the next one takes the rest', () => {
    const first = part({ id: 'a', carbs_g: 10, dose_carbs_g: 10, planned_insulin_u: 1.2, part_index: 0 });
    const second = part({ id: 'b', carbs_g: 12, dose_carbs_g: 10, planned_insulin_u: 1.1, part_index: 1, due_at: '2026-11-11T11:30:00.000Z' });
    const ledger = ledgerOf([dose(10, 1.2, 'NEW_MEAL'), dose(10, 1.2)], [first, second]);
    const updates = mealDosesCoverUpdates([first, second], ledger, 0.1, { locked: new Set(['a']) });
    expect(updates.map((update) => update.plan_id)).toEqual(['b']);
    expect(updates[0].carbs_g).toBe(2);
  });

  it('several parts: the next one gives first', () => {
    const first = part({ id: 'a', carbs_g: 10, dose_carbs_g: 10, planned_insulin_u: 1.2, part_index: 0 });
    const second = part({ id: 'b', carbs_g: 12, dose_carbs_g: 10, planned_insulin_u: 1.1, part_index: 1, due_at: '2026-11-11T11:30:00.000Z' });
    const rows = apply([first, second], ledgerOf([dose(10, 1.2, 'NEW_MEAL'), dose(10, 1.2)], [first, second]));
    expect(rows[0].status).toBe('CANCELLED');
    expect(rows[1].carbs_g).toBe(12);
    expect(rows[1].status).toBe('SCHEDULED');
  });

  it('a dose the caregiver named is lowered to what the meal still lacks', () => {
    // 32 g at 8,3 = 3,86 j; 2,4 j given: 1,46 j left, 1,4 j at the step (not the named 2,4 j).
    const fixed = part({ fixed_insulin_u: 2.4, planned_insulin_u: 2.4 });
    const [rest] = apply([fixed], ledgerOf([dose(10, 1.2, 'NEW_MEAL'), dose(10, 1.2)], [fixed]));
    expect(rest.fixed_insulin_u).toBeCloseTo(1.4, 2);
  });
});

describe('meal-doses.v1: the push and the card do not take a dose off twice', () => {
  const at = (minutes: number) => new Date(Date.parse('2026-11-11T10:37:29.000Z') + minutes * 60_000).toISOString();
  const actions = [
    { id: 'added', started_at: at(11), bolus_units: 1.4, carbs_g: 10, meal_record_id: MEAL },
    { id: 'insulin-only', started_at: at(12), bolus_units: 0.5, carbs_g: null, meal_record_id: MEAL },
    { id: 'no-meal', started_at: at(13), bolus_units: 0.4, carbs_g: null, meal_record_id: null },
    { id: 'remote-command:pending', started_at: at(14), bolus_units: 0.6, carbs_g: null, meal_record_id: MEAL },
  ];
  const args = { actions, used: new Set<string>(), meal_record_id: MEAL, meal_started_at: at(0), now: new Date(at(30)) };

  it('without the ledger every bolus since the meal is named, as before', () => {
    expect(bolusesSinceMealForPart(args).map((action) => action.id)).toEqual(['added', 'insulin-only', 'no-meal', 'remote-command:pending']);
  });

  it('with it, doses of the meal are in the part already: only boluses of no meal and doses not yet in the loop', () => {
    expect(bolusesSinceMealForPart({ ...args, meal_doses_in_ledger: true }).map((action) => action.id)).toEqual(['no-meal', 'remote-command:pending']);
  });

  it('the push says what the meal\'s doses covered', () => {
    const { body } = plannedBolusPushContent({ description: 'Chipsy jabłkowe (Lidl) (40 g)', carbs_g: 12, estimate_u: 0.9, low_glucose: null, doses_cover_u: 1.2 });
    expect(body).toContain('Dawki dopisane do tego posiłku pokryły już 1,2 j z tej części.');
  });
});

describe('meal-doses.v1: PlannedBolusService.followMealDoses', () => {
  class Store implements PlannedBolusStore {
    rows: PlannedBolusRecord[] = [part()];
    writes: string[] = [];
    async create() { return null; }
    async get(_p: string, id: string) { return this.rows.find((row) => row.id === id) ?? null; }
    async latestForMeal() { return this.rows.at(-1) ?? null; }
    async listForProposals() { return new Map(); }
    async listForMeal() { return this.rows; }
    async listOpen() { return this.rows; }
    async markNotified() { return true; }
    async resolve() { return null; }
    async followMealDoses(_p: string, id: string, fields: Parameters<NonNullable<PlannedBolusStore['followMealDoses']>>[2]) {
      this.writes.push(id);
      Object.assign(this.rows.find((row) => row.id === id)!, { carbs_g: fields.carbs_g, dose_carbs_g: fields.dose_carbs_g, planned_insulin_u: fields.planned_insulin_u, doses_cover_carbs_g: fields.doses_cover_carbs_g, doses_cover_dose_g: fields.doses_cover_dose_g, doses_cover_insulin_u: fields.doses_cover_insulin_u, status: fields.cancel ? 'CANCELLED' : 'SCHEDULED', cancelled_by_meal_doses: fields.cancel });
      return true;
    }
  }

  it('writes the covered part once and returns the ledger', async () => {
    const store = new Store();
    const service = new PlannedBolusService({ store, commands: { latestForPlannedBolus: async () => null } });
    const input = { actions: [dose(10, 1.2, 'NEW_MEAL'), dose(10, 1.2), dose(10, 1.4)], meal_carbs_g: 32, meal_carbs_origin: 'AI_PROPOSAL' };
    const first = await service.followMealDoses('p1', MEAL, input, 0.1);
    expect(first.changed).toBe(true);
    expect(first.ledger).not.toBeNull();
    expect(store.rows[0].status).toBe('CANCELLED');
    const again = await service.followMealDoses('p1', MEAL, input, 0.1);
    expect(again.changed).toBe(false);
    expect(store.writes).toEqual(['rest-1']);
  });

  it('a part being sent is locked', async () => {
    const store = new Store();
    const service = new PlannedBolusService({ store, commands: { latestForPlannedBolus: async () => ({ status: 'SENT' }) as never } });
    const result = await service.followMealDoses('p1', MEAL, { actions: [dose(10, 1.2, 'NEW_MEAL'), dose(10, 1.2), dose(10, 1.4)], meal_carbs_g: 32, meal_carbs_origin: 'AI_PROPOSAL' }, 0.1);
    expect(result.changed).toBe(false);
    expect(store.rows[0].status).toBe('SCHEDULED');
  });
});
