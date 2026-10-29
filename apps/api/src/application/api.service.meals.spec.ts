import { describe, expect, it, vi } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@shared/errors/app-error';
import { canTransitionMealRecord, type MacroValue, type MealRecord, type MealRecordStatus } from '@modules/meal-candidates/application/meal-record-trust';
import { ApiService } from './api.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const MEAL_ID = '22222222-2222-4222-8222-222222222222';
const IDENTITY = `meal:new-meal-assignment.v1:epoch:${MEAL_ID}`;
const CAREGIVER = { user_id: '33333333-3333-4333-8333-333333333333' } as any;
const READER = { user_id: '44444444-4444-4444-8444-444444444444' } as any;

class InMemoryRepo {
  async getAccessRow(userId: string, patientId: string) {
    if (patientId !== PATIENT) return null;
    if (userId === CAREGIVER.user_id) return { can_read_patient: true, can_write_patient: true };
    if (userId === READER.user_id) return { can_read_patient: true, can_write_patient: false };
    return null;
  }
  async insertAuditEvent() {}
}

/** Mirrors PostgresMealRecordRepository's transition rules and caregiver attribution. */
class InMemoryMealRecords {
  status: MealRecordStatus = 'AWAITING_DESCRIPTION';
  description: string | null = null;
  photoRef: string | null = null;
  proposal: { proposal_id: string; carbs_g: number | null; protein_g: number | null; fat_g: number | null } | null = null;
  confirmed: { macros: Record<string, MacroValue>; by: string } | null = null;

  async findMealIdentityById(patientId: string, mealId: string) {
    return patientId === PATIENT && mealId === MEAL_ID ? IDENTITY : null;
  }
  async getAnchorEventId() {
    return 'anchor-event';
  }
  async getMealRecord(): Promise<MealRecord> {
    const none: MacroValue = { grams: null, origin: null };
    const proposed = (grams: number | null): MacroValue => ({ grams, origin: grams === null ? null : 'AI_PROPOSAL' });
    const macros = this.confirmed
      ? { carbs: this.confirmed.macros.carbs, protein: this.confirmed.macros.protein, fat: this.confirmed.macros.fat }
      : this.status === 'AI_PROPOSED' && this.proposal
        ? { carbs: proposed(this.proposal.carbs_g), protein: proposed(this.proposal.protein_g), fat: proposed(this.proposal.fat_g) }
        : { carbs: none, protein: none, fat: none };
    return {
      meal_identity: IDENTITY, status: this.status, started_at: '2026-11-01T12:00:00.000Z', source_carbs_g: 45,
      description: this.description, has_photo: this.photoRef !== null, macros,
      pending_proposal_id: this.status === 'AI_PROPOSED' ? this.proposal!.proposal_id : null,
    };
  }
  private move(to: MealRecordStatus) {
    if (!canTransitionMealRecord(this.status, to)) throw new ConflictError(`cannot move from ${this.status} to ${to}`);
    this.status = to;
  }
  async recordDescription(_p: string, _i: string, input: { description: string | null; photo_ref: string | null }) {
    if (!input.description && !input.photo_ref) throw new ValidationError('A meal description or photo is required');
    this.move('DESCRIBED');
    this.description = input.description;
    this.photoRef = input.photo_ref;
  }
  async correctMacros(_p: string, _i: string, caregiver: string, macros: { carbs_g: number | null; protein_g: number | null; fat_g: number | null }) {
    this.move('CORRECTED');
    const value = (grams: number | null): MacroValue => ({ grams, origin: grams === null ? null : 'CAREGIVER' });
    this.confirmed = { macros: { carbs: value(macros.carbs_g), protein: value(macros.protein_g), fat: value(macros.fat_g) }, by: caregiver };
  }
}

function setup() {
  const repo = new InMemoryRepo();
  const meals = new InMemoryMealRecords();
  const api = new ApiService(repo as any, {} as any);
  (api as unknown as { mealRecordRepository: unknown }).mealRecordRepository = meals;
  (api as unknown as { mealWbtRepository: unknown }).mealWbtRepository = { getReminder: async () => null, setAutoReminder: async () => undefined, setManualReminder: async () => undefined, getLatestSuggestion: async () => null };
  // The meal's open later parts follow its carbs (migration 076): the carbs each change reports.
  const followedCarbs: Array<number | null> = [];
  (api as unknown as { plannedBoluses: { followMealCarbs: unknown } }).plannedBoluses.followMealCarbs = async (_patientId: string, _mealId: string, carbs: number | null) => { followedCarbs.push(carbs); };
  return { api, repo, meals, followedCarbs };
}

describe('meal endpoints (offline)', () => {
  it('a DESCRIBED meal (left by the removed description endpoints) waits for no proposal; the caregiver enters values', async () => {
    const { api, meals } = setup();

    const initial = await api.getMeal(CAREGIVER, PATIENT, MEAL_ID);
    expect(initial.meal).toMatchObject({ meal_id: MEAL_ID, status: 'AWAITING_DESCRIPTION', source_carbs_g: 45, trusted: false, proposal_in_progress: false, proposal_failed: false });

    await meals.recordDescription(PATIENT, IDENTITY, { description: 'Makaron z sosem', photo_ref: 'photo://local/abc' });
    const described = await api.getMeal(CAREGIVER, PATIENT, MEAL_ID);
    expect(described.meal).toMatchObject({ status: 'DESCRIBED', description: 'Makaron z sosem', has_photo: true, proposal_in_progress: false, proposal_failed: true, pending_proposal_id: null, trusted: false });

    const corrected = await api.correctMealMacros(CAREGIVER, PATIENT, MEAL_ID, { carbs_g: 55, protein_g: null, fat_g: null });
    expect(corrected.meal).toMatchObject({ status: 'CORRECTED', trusted: true, proposal_in_progress: false, proposal_failed: false, macros: { carbs: { grams: 55, origin: 'CAREGIVER' } } });
  });

  it('caregiver correction stores caregiver-attributed values', async () => {
    const { api, meals, followedCarbs } = setup();
    const corrected = await api.correctMealMacros(CAREGIVER, PATIENT, MEAL_ID, { carbs_g: 50, protein_g: 20, fat_g: null });
    expect(corrected.meal).toMatchObject({ status: 'CORRECTED', trusted: true, macros: { carbs: { grams: 50, origin: 'CAREGIVER' }, protein: { grams: 20, origin: 'CAREGIVER' }, fat: { grams: null, origin: null } } });
    expect(meals.confirmed?.by).toBe(CAREGIVER.user_id);
    expect(followedCarbs).toEqual([50]);
  });

  it('a meal made smaller than its bolus warns once, with a push to the caregivers (owner 2026-10-26)', async () => {
    const { api } = setup();
    const internals = api as unknown as Record<string, unknown>;
    let notified = 0;
    const enqueue = vi.fn().mockResolvedValue(null);
    Object.assign(internals, {
      plannedBolusRepository: { listForMeal: async () => [] },
      loopActions: { ...(internals.loopActions as object), listActionsForMeals: async () => [{ purpose: 'NEW_MEAL', carbs_g: 45, bolus_units: 4.5 }], nextMealStart: async () => null, listSmbsBetween: async () => [] },
      mealJournal: { notifiedDoseExcess: async () => notified, setNotifiedDoseExcess: async (_p: string, _m: string, grams: number) => { notified = grams; } },
      pushOutbox: { enqueue },
    });
    await api.correctMealMacros(CAREGIVER, PATIENT, MEAL_ID, { carbs_g: 35, protein_g: null, fat_g: null });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      patientId: PATIENT,
      request: { kind: 'care_reminder', input: { mealId: MEAL_ID, title: 'Za duża dawka po zmianie posiłku', body: expect.stringContaining('o 10 g węglowodanów mniej') } },
    });
    expect(notified).toBe(10);
    // The same excess again: no second push.
    await api.correctMealMacros(CAREGIVER, PATIENT, MEAL_ID, { carbs_g: 35, protein_g: null, fat_g: null });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('refuses invalid caregiver values', async () => {
    const { api } = setup();
    await expect(api.correctMealMacros(CAREGIVER, PATIENT, MEAL_ID, { carbs_g: -1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(api.correctMealMacros(CAREGIVER, PATIENT, MEAL_ID, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('requires write access to change a meal and returns 404 for unknown meals', async () => {
    const { api } = setup();
    await expect(api.getMeal(READER, PATIENT, MEAL_ID)).resolves.toMatchObject({ meal: { meal_id: MEAL_ID } });
    await expect(api.correctMealMacros(READER, PATIENT, MEAL_ID, { carbs_g: 10 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(api.getMeal(CAREGIVER, PATIENT, '55555555-5555-4555-8555-555555555555')).rejects.toBeInstanceOf(NotFoundError);
  });
});
