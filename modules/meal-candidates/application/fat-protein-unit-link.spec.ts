import { describe, expect, it } from 'vitest';
import { fatProteinUnitsOf } from '@modules/meal-wbt/application/wbt-policy';
import { linkFatProteinUnitEntriesToMeals, linkFatProteinUnitEntry, type LinkableCarbEntry, type WbtLinkCarbEntry } from './fat-protein-unit-link';
import type { MealRecord } from './meal-record-trust';

function entry(id: string, at: string, partial: Partial<LinkableCarbEntry> = {}): LinkableCarbEntry {
  return { event_id: id, occurred_at: at, kind: 'MEAL', carbs_g: 30, protein_g: null, fat_g: null, part_of_meal_id: null, meal: null, ...partial };
}

describe('fat-protein units (WBT) link', () => {
  it('computes WBT as 100 kcal of protein (4 kcal/g) and fat (9 kcal/g)', () => {
    expect(fatProteinUnitsOf(20, 20)).toBe(2.6);
    expect(fatProteinUnitsOf(null, null)).toBeNull();
  });

  it('links the WBT entry to the richest protein/fat meal of the previous 6 hours, confirmed macros first', () => {
    const wbt = entry('wbt', '2026-10-15T16:00:00.000Z', { kind: 'FAT_PROTEIN_UNITS', carbs_g: 15 });
    const all = [
      entry('breakfast', '2026-10-15T08:00:00.000Z', { protein_g: 30, fat_g: 30 }), // 8 h before: outside the window
      entry('lunch', '2026-10-15T12:50:00.000Z', { meal: { trusted: true, macros: { protein: { grams: 25 }, fat: { grams: 18 } } } }),
      entry('snack', '2026-10-15T14:30:00.000Z', { protein_g: 2, fat_g: 1 }),
      entry('extra', '2026-10-15T12:55:00.000Z', { part_of_meal_id: 'lunch-meal', protein_g: 50, fat_g: 50 }),
      wbt,
    ];

    expect(linkFatProteinUnitEntry(wbt, all)).toEqual({
      event_id: 'lunch',
      occurred_at: '2026-10-15T12:50:00.000Z',
      carbs_g: 30,
      protein_g: 25,
      fat_g: 18,
      fat_protein_units: 2.6,
      basis: 'MACROS',
    });
  });

  it('without known protein/fat picks the meal closest to 3 hours before, as a time-only guess', () => {
    const wbt = entry('wbt', '2026-10-15T16:00:00.000Z', { kind: 'FAT_PROTEIN_UNITS' });
    const link = linkFatProteinUnitEntry(wbt, [entry('a', '2026-10-15T11:00:00.000Z'), entry('b', '2026-10-15T13:10:00.000Z'), entry('c', '2026-10-15T15:30:00.000Z'), wbt]);
    expect(link).toMatchObject({ event_id: 'b', basis: 'TIME_ONLY', fat_protein_units: null });
  });

  it('returns null when no meal lies in the window', () => {
    const wbt = entry('wbt', '2026-10-15T16:00:00.000Z', { kind: 'FAT_PROTEIN_UNITS' });
    expect(linkFatProteinUnitEntry(wbt, [wbt, entry('late', '2026-10-15T17:00:00.000Z')])).toBeNull();
  });

  describe('linkFatProteinUnitEntriesToMeals (AI context)', () => {
    const stored = (id: string, at: string, partial: Partial<WbtLinkCarbEntry> = {}): WbtLinkCarbEntry => ({
      event_id: id, occurred_at: at, kind: 'MEAL', carbs_g: 5, protein_g: null, fat_g: null, part_of_meal_id: null, meal_record: null, ...partial,
    });
    const nuggets: MealRecord = {
      meal_identity: 'meal:v1:e:nuggets', status: 'CONFIRMED', started_at: '2026-10-15T17:04:00.000Z', source_carbs_g: 30,
      description: 'Frytki małe, Kurczak McNuggets', has_photo: false,
      macros: { carbs: { grams: 30, origin: 'CAREGIVER' }, protein: { grams: 16, origin: 'CAREGIVER' }, fat: { grams: 22, origin: 'CAREGIVER' } },
    };

    it('gives a WBT entry the whole meal it covers, with entries joined to that meal summed in', () => {
      const links = linkFatProteinUnitEntriesToMeals([
        stored('deleted', '2026-10-15T16:00:00.000Z', { kind: 'IGNORED' }),
        stored('nuggets', '2026-10-15T17:04:00.000Z', { meal_record: nuggets }),
        stored('joined-1', '2026-10-15T17:46:00.000Z', { carbs_g: 20, part_of_meal_id: 'record-nuggets' }),
        stored('joined-2', '2026-10-15T17:57:00.000Z', { part_of_meal_id: 'record-nuggets' }),
        stored('wbt', '2026-10-15T20:24:00.000Z', { kind: 'FAT_PROTEIN_UNITS', carbs_g: 10 }),
      ]);

      expect([...links.keys()]).toEqual(['wbt']);
      expect(links.get('wbt')).toMatchObject({
        link_basis: 'MACROS',
        fat_protein_units: 2.6,
        anchor_event_id: 'nuggets',
        started_at: '2026-10-15T17:04:00.000Z',
        first_entry_carbs_g: 5,
        meal_record: {
          record_status: 'CONFIRMED',
          trusted: true,
          description: 'Frytki małe, Kurczak McNuggets',
          source_carbs_g: 30,
          protein: { value: 16, knowledge_status: 'KNOWN' },
          fat: { value: 22, knowledge_status: 'KNOWN' },
        },
      });
    });

    it('links to no meal when there is none, or when the covered meal was cancelled', () => {
      expect(linkFatProteinUnitEntriesToMeals([stored('wbt', '2026-10-15T20:24:00.000Z', { kind: 'FAT_PROTEIN_UNITS' })]).get('wbt')).toBeNull();
      const cancelled = linkFatProteinUnitEntriesToMeals([
        stored('nuggets', '2026-10-15T17:04:00.000Z', { meal_record: { ...nuggets, status: 'CANCELLED' } }),
        stored('wbt', '2026-10-15T20:24:00.000Z', { kind: 'FAT_PROTEIN_UNITS' }),
      ]);
      expect(cancelled.get('wbt')).toBeNull();
    });

    it('without a meal record still names the meal entry it covers', () => {
      const links = linkFatProteinUnitEntriesToMeals([
        stored('legacy', '2026-10-15T17:04:00.000Z', { carbs_g: 40 }),
        stored('wbt', '2026-10-15T20:24:00.000Z', { kind: 'FAT_PROTEIN_UNITS' }),
      ]);
      expect(links.get('wbt')).toMatchObject({ link_basis: 'TIME_ONLY', anchor_event_id: 'legacy', meal_record: null, first_entry_carbs_g: 40 });
    });
  });

  it('links a WBT entry the caregiver answered for a meal to that meal, not the one with the most WBT', () => {
    const wbt = entry('wbt', '2026-10-15T12:30:00.000Z', { kind: 'FAT_PROTEIN_UNITS', carbs_g: 10, assigned_meal_id: 'snack-meal' });
    const all = [
      entry('breakfast', '2026-10-15T08:00:00.000Z', { protein_g: 30, fat_g: 30, meal_record_id: 'breakfast-meal' }),
      entry('snack', '2026-10-15T11:00:00.000Z', { protein_g: 8, fat_g: 5, meal_record_id: 'snack-meal' }),
      wbt,
    ];
    expect(linkFatProteinUnitEntry(wbt, all)?.event_id).toBe('snack');
    expect(linkFatProteinUnitEntry({ ...wbt, assigned_meal_id: null }, all)?.event_id).toBe('breakfast');
  });
});
