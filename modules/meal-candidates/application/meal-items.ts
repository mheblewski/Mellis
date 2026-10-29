/**
 * Items of a meal (meal_records.confirmed_items, migration 043): what it consisted of, each with grams and macros from
 * DiabCalc or the model's own estimate. Pure. Totals are always the sum of the items, never a number the model wrote.
 */

export interface MealItem {
  name: string;
  grams: number | null;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  /** DIABCALC (product database) or ESTIMATE (the model's own estimate). */
  source: 'DIABCALC' | 'ESTIMATE';
}

export interface MealTotals {
  carbs_g: number;
  protein_g: number;
  fat_g: number;
}

const MEAL_ITEMS_LIMITS = {
  max_items: 30,
  max_name_chars: 120,
  /** Per item and per meal: a single value above this is a typo, not a meal. */
  max_grams: 1000,
} as const;

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Items as stored: names trimmed (empty ones dropped), values rounded to 0.1 g, grams of the portion only when
 * positive. Values that are not non-negative numbers are refused rather than read as zero, so a broken item never
 * becomes "0 g of carbs".
 */
export function sanitizeMealItems(raw: unknown): { items: MealItem[] } | { problem: string } {
  if (!Array.isArray(raw)) return { problem: 'items must be a list' };
  if (raw.length === 0) return { problem: 'a meal needs at least one item' };
  if (raw.length > MEAL_ITEMS_LIMITS.max_items) return { problem: `at most ${MEAL_ITEMS_LIMITS.max_items} items` };
  const items: MealItem[] = [];
  for (const entry of raw) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name.replace(/\s+/g, ' ').trim().slice(0, MEAL_ITEMS_LIMITS.max_name_chars) : '';
    if (!name) return { problem: 'every item needs a name' };
    const value = (key: 'carbs_g' | 'protein_g' | 'fat_g'): number | null => {
      const raw = item[key];
      return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= MEAL_ITEMS_LIMITS.max_grams ? round1(raw) : null;
    };
    const carbs = value('carbs_g');
    const protein = value('protein_g');
    const fat = value('fat_g');
    if (carbs === null || protein === null || fat === null) {
      return { problem: `${name}: carbs_g, protein_g and fat_g must be numbers between 0 and ${MEAL_ITEMS_LIMITS.max_grams}` };
    }
    const grams = typeof item.grams === 'number' && Number.isFinite(item.grams) && item.grams > 0 && item.grams <= 5000 ? round1(item.grams) : null;
    items.push({ name, grams, carbs_g: carbs, protein_g: protein, fat_g: fat, source: item.source === 'DIABCALC' ? 'DIABCALC' : 'ESTIMATE' });
  }
  const totals = sumMealItems(items);
  if (totals.carbs_g > MEAL_ITEMS_LIMITS.max_grams || totals.protein_g > MEAL_ITEMS_LIMITS.max_grams || totals.fat_g > MEAL_ITEMS_LIMITS.max_grams) {
    return { problem: `the meal's totals must stay at most ${MEAL_ITEMS_LIMITS.max_grams} g each` };
  }
  return { items };
}

export function sumMealItems(items: readonly MealItem[]): MealTotals {
  const sum = (key: keyof MealTotals) => round1(items.reduce((total, item) => total + item[key], 0));
  return { carbs_g: sum('carbs_g'), protein_g: sum('protein_g'), fat_g: sum('fat_g') };
}

/** True when the items add up to the given values (to 0.1 g), so they still describe the meal after a values edit. */
export function itemsMatchTotals(items: readonly MealItem[], totals: { carbs_g: number | null; protein_g: number | null; fat_g: number | null }): boolean {
  const sum = sumMealItems(items);
  const same = (a: number, b: number | null) => b !== null && Math.abs(a - b) < 0.05;
  return same(sum.carbs_g, totals.carbs_g) && same(sum.protein_g, totals.protein_g) && same(sum.fat_g, totals.fat_g);
}

/** "Skyr Polmlek truskawka i kiwi (75 g), Masło (5 g)" from a meal's items; null without items. */
export function describeMealItems(items: Array<{ name?: unknown; grams?: unknown }> | null | undefined): string | null {
  const parts = (items ?? [])
    .map((item) => {
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) return null;
      const grams = typeof item.grams === 'number' && Number.isFinite(item.grams) && item.grams > 0 ? ` (${Math.round(item.grams * 10) / 10} g)` : '';
      return `${name}${grams}`;
    })
    .filter((part): part is string => part !== null);
  const text = parts.join(', ');
  return text ? text.slice(0, 2000) : null;
}

/** Stored items read back (jsonb): anything that is not a valid item list is treated as no items. */
export function readStoredMealItems(value: unknown): MealItem[] | null {
  if (value === null || value === undefined) return null;
  const result = sanitizeMealItems(value);
  return 'items' in result ? result.items : null;
}
