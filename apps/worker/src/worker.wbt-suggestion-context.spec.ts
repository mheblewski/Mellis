import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';

// Fake repositories only: no database. Breakfast at 07:40 (ICR 5 g/U), WBT suggestion asked at 10:20 (ICR 8 g/U).
describe('worker WBT suggestion context', () => {
  const patientId = '11111111-1111-4111-8111-111111111111';
  const icrSchedule = [['00:00', 10], ['06:00', 5], ['09:00', 8]];
  const iso = (value: string) => new Date(value).toISOString();
  const macros = (carbs: number, protein: number, fat: number) => ({ carbs: { grams: carbs }, protein: { grams: protein }, fat: { grams: fat } });
  const events = [
    // An earlier breakfast (07:30, ICR 5) with 8 g WBT carbs logged at 10:00 (ICR 8): 1 U, not 1.6 U.
    { id: 'c1', type: 'CARB_ENTRY', occurred_at: new Date('2026-10-15T08:00:00.000Z'), payload: { carbs: 8 } },
    { id: 'g1', type: 'GLUCOSE_READING_AVAILABLE', occurred_at: new Date('2026-10-15T08:30:00.000Z'), payload: { glucose_value: 170 } },
  ];

  function worker() {
    const repository = {
      getTherapyProfileAt: vi.fn(async () => ({ timezone: 'Europe/Warsaw', carb_ratio_g_per_u: icrSchedule })),
      listPatientEventsByRange: vi.fn(async ({ startAtIso, endAtIso }: { startAtIso: string; endAtIso: string }) => events
        .filter((event) => event.occurred_at.toISOString() >= startAtIso && event.occurred_at.toISOString() <= endAtIso)),
      listCarbEntryKinds: vi.fn(async () => new Map([['c1', 'FAT_PROTEIN_UNITS']])),
      getCurrentState: vi.fn(async () => ({ glucose: { value: 117, trend: 'FLAT' }, iob: { value: 0.35 } })),
    } as any;
    const service = new WorkerService(repository, {} as any, { get: vi.fn() } as any, {} as any, {} as any, {} as any, {} as any) as any;
    service.mealRecordRepository = {
      findMealIdentityById: vi.fn(async () => 'meal:today'),
      getMealRecord: vi.fn(async () => ({ started_at: iso('2026-10-18T05:40:00Z'), description: 'Parówki, jajecznica', macros: macros(6, 13.9, 21.7), source_carbs_g: 6 })),
      listMealRecordsStartedBetween: vi.fn(async () => [{
        meal_identity: 'meal:earlier', status: 'CONFIRMED', started_at: iso('2026-10-15T05:30:00Z'), description: 'Jajecznica', macros: macros(10, 12, 12),
      }]),
    };
    return service;
  }

  it('uses the ICR of the dose time for the suggestion and no WBT history from earlier meals', async () => {
    const context = await worker().loadWbtSuggestionContext(patientId, 'meal-1', iso('2026-10-18T08:20:00Z'));

    expect(context.icr_g_per_u).toBe(8);
    expect(context.meal.local_time).toBe('2026-10-18 07:40');
    // The standard rule only: earlier meals are not read.
    expect(context).not.toHaveProperty('history');
  });
});
