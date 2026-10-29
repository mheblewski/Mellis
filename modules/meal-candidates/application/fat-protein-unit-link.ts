/**
 * Links a "carbs for WBT" entry (FAT_PROTEIN_UNITS) to the meal whose protein and fat it covers.
 *
 * 1 WBT (fat-protein unit, Pańkowska 2009) = 100 kcal from protein (4 kcal/g) and fat (9 kcal/g). Their glucose effect
 * is delayed by hours, so the WBT entry is often logged after the meal. The source meal is searched among meals from
 * LOOKBACK_HOURS before the entry up to the entry itself: the one with the most WBT (caregiver-confirmed macros first,
 * else protein/fat logged in Nightscout); without any known protein/fat, the meal closest to TYPICAL_DELAY_HOURS before
 * the entry, marked as a time-only guess. This is a display aid, not a dosing rule.
 */

import { fatProteinUnitsOf } from '@modules/meal-wbt/application/wbt-policy';
import { isTrustedMealRecord, toMealContextItem, type MealContextItem, type MealRecord } from './meal-record-trust';

export const FAT_PROTEIN_UNIT_LOOKBACK_HOURS = 6;
const TYPICAL_DELAY_HOURS = 3;

export interface LinkableCarbEntry {
  event_id: string;
  occurred_at: string | null;
  kind: string;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  part_of_meal_id: string | null;
  meal: { trusted?: unknown; macros?: { protein?: { grams?: unknown }; fat?: { grams?: unknown } } } | null;
  /** The meal record this entry starts (a candidate); absent when unknown. */
  meal_record_id?: string | null;
  /** A WBT entry the caregiver answered "WBT do: <meal>" for: that meal, whatever the WBT counts say. */
  assigned_meal_id?: string | null;
}

export interface FatProteinUnitLink {
  event_id: string;
  occurred_at: string;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  /** WBT of the meal, from its protein and fat; null when unknown. */
  fat_protein_units: number | null;
  /** MACROS: chosen by its protein/fat; TIME_ONLY: no protein/fat known, closest to the typical delay. */
  basis: 'MACROS' | 'TIME_ONLY';
}

const grams = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

function mealMacros(entry: LinkableCarbEntry): { protein_g: number | null; fat_g: number | null } {
  if (entry.meal?.trusted === true) {
    const protein = grams(entry.meal.macros?.protein?.grams);
    const fat = grams(entry.meal.macros?.fat?.grams);
    if (protein !== null || fat !== null) return { protein_g: protein, fat_g: fat };
  }
  return { protein_g: entry.protein_g, fat_g: entry.fat_g };
}

/** Source meal of one WBT entry among `entries` (any order); null when no meal lies in the window. */
export function linkFatProteinUnitEntry(entry: LinkableCarbEntry, entries: LinkableCarbEntry[]): FatProteinUnitLink | null {
  const at = entry.occurred_at ? Date.parse(entry.occurred_at) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const earliest = at - FAT_PROTEIN_UNIT_LOOKBACK_HOURS * 3_600_000;
  const candidates = entries
    .filter((candidate) => candidate.kind === 'MEAL' && candidate.part_of_meal_id === null && candidate.event_id !== entry.event_id && candidate.occurred_at)
    .map((candidate) => {
      const when = Date.parse(candidate.occurred_at as string);
      const macros = mealMacros(candidate);
      return { candidate, when, macros, units: fatProteinUnitsOf(macros.protein_g, macros.fat_g) };
    })
    .filter(({ when }) => Number.isFinite(when) && when >= earliest && when <= at);
  if (candidates.length === 0) return null;

  // The caregiver's answer wins over the guess (the same meal the WBT history counts it for, wbt-history.ts).
  const assigned = entry.assigned_meal_id ? candidates.find((item) => item.candidate.meal_record_id === entry.assigned_meal_id) : undefined;
  if (assigned) {
    return {
      event_id: assigned.candidate.event_id,
      occurred_at: assigned.candidate.occurred_at as string,
      carbs_g: assigned.candidate.carbs_g,
      protein_g: assigned.macros.protein_g,
      fat_g: assigned.macros.fat_g,
      fat_protein_units: assigned.units,
      basis: (assigned.units ?? 0) > 0 ? 'MACROS' : 'TIME_ONLY',
    };
  }

  const typical = at - TYPICAL_DELAY_HOURS * 3_600_000;
  const withUnits = candidates.filter((item) => (item.units ?? 0) > 0);
  const chosen = withUnits.length > 0
    ? withUnits.sort((left, right) => (right.units as number) - (left.units as number) || Math.abs(left.when - typical) - Math.abs(right.when - typical))[0]
    : candidates.sort((left, right) => Math.abs(left.when - typical) - Math.abs(right.when - typical))[0];

  return {
    event_id: chosen.candidate.event_id,
    occurred_at: chosen.candidate.occurred_at as string,
    carbs_g: chosen.candidate.carbs_g,
    protein_g: chosen.macros.protein_g,
    fat_g: chosen.macros.fat_g,
    fat_protein_units: chosen.units,
    basis: withUnits.length > 0 ? 'MACROS' : 'TIME_ONLY',
  };
}

/** The meal a WBT entry covers, as AI context gets it: the whole meal record (all its entries), not one entry. */
export interface FatProteinUnitLinkedMeal {
  link_basis: FatProteinUnitLink['basis'];
  /** WBT of the meal, from its protein and fat; null when unknown. */
  fat_protein_units: number | null;
  anchor_event_id: string;
  started_at: string;
  /** Trust-labelled record (description, carbs of all its entries, macros); null when the meal has no record. */
  meal_record: MealContextItem | null;
  /** Carbs of the meal's first Nightscout entry, as logged (the record sums all entries). */
  first_entry_carbs_g: number | null;
  /** Protein and fat fat_protein_units is computed from (confirmed macros, else logged in Nightscout). */
  protein_g: number | null;
  fat_g: number | null;
}

/** A carb entry as stored, with the record of the meal it starts (anchors only). */
export interface WbtLinkCarbEntry {
  event_id: string;
  occurred_at: string | null;
  kind: string;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  /** Record of the meal this entry joined (not its first entry); null otherwise. */
  part_of_meal_id: string | null;
  /** Record of the meal this entry starts; null otherwise. */
  meal_record: MealRecord | null;
  /** Id of the meal record this entry starts (with meal_record). */
  meal_record_id?: string | null;
  /** WBT entry: the meal the caregiver answered it for (its loop action). */
  assigned_meal_id?: string | null;
}

/**
 * Source meal of every WBT entry among `entries` (which must reach FAT_PROTEIN_UNIT_LOOKBACK_HOURS before the
 * earliest one), keyed by the WBT entry's event id. A WBT entry without a meal in its window, or whose meal is
 * cancelled or evidence-excluded, maps to null.
 */
export function linkFatProteinUnitEntriesToMeals(entries: WbtLinkCarbEntry[]): Map<string, FatProteinUnitLinkedMeal | null> {
  const linkable: LinkableCarbEntry[] = entries.map((entry) => ({
    event_id: entry.event_id,
    occurred_at: entry.occurred_at,
    kind: entry.kind,
    carbs_g: entry.carbs_g,
    protein_g: entry.protein_g,
    fat_g: entry.fat_g,
    part_of_meal_id: entry.part_of_meal_id,
    meal: entry.meal_record ? { trusted: isTrustedMealRecord(entry.meal_record), macros: entry.meal_record.macros } : null,
    meal_record_id: entry.meal_record_id ?? null,
    assigned_meal_id: entry.assigned_meal_id ?? null,
  }));
  const byEventId = new Map(entries.map((entry) => [entry.event_id, entry]));
  const links = new Map<string, FatProteinUnitLinkedMeal | null>();
  for (const entry of linkable) {
    if (entry.kind !== 'FAT_PROTEIN_UNITS') continue;
    const link = linkFatProteinUnitEntry(entry, linkable);
    const record = link ? byEventId.get(link.event_id)?.meal_record ?? null : null;
    const item = record ? toMealContextItem(record) : null;
    links.set(entry.event_id, !link || (record && !item) ? null : {
      link_basis: link.basis,
      fat_protein_units: link.fat_protein_units,
      anchor_event_id: link.event_id,
      started_at: item?.started_at ?? link.occurred_at,
      meal_record: item,
      first_entry_carbs_g: link.carbs_g,
      protein_g: link.protein_g,
      fat_g: link.fat_g,
    });
  }
  return links;
}
