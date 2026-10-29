/**
 * When to split a meal bolus (split-advice.v1): from the meal's fat and protein relative to its carbs,
 * not from grams. WBT per carb exchange ((4·protein + 9·fat) / 100 ÷ carbs / 10) and the fat share of the meal's energy
 * scale with the portion, so a child's small fatty meal counts (half a small fries + 6 nuggets: 0,75 WBT/WW, fat 46% of
 * the energy) while the same fat on an adult's plate of 80 g carbs does not.
 *
 * Evidence (the split-bolus plan): children need at least 60% of the dose before the meal (Lopez 2017,
 * 70/30 and 60/40 hold the first 2 h, a larger later part helps the 4–5 h rise); no agreed gram threshold exists and
 * test meals were rarely age-adjusted (Furthner 2021); ISPAD 2022: adjust when the child's own glucose shows it.
 * Checked on the first patient's confirmed meals (October 2026): from 0,5 WBT/WW nearly every comparable meal dipped in
 * the first 2 h, below it a third did; the old gram rule (fat ≥ 20 g or protein ≥ 25 g) caught none of them.
 */

export const SPLIT_ADVICE_POLICY = {
  version: 'split-advice.v1',
  /** WBT per carb exchange from which the dose is split (70/30), and from which more goes later (60/40). */
  ratio_split: 0.5,
  ratio_strong: 0.8,
  /** Fat share of the meal's energy (%) with the same meaning. */
  fat_share_split: 35,
  fat_share_strong: 40,
  mild: { now_percent: 70, after_minutes: 60 },
  strong: { now_percent: 60, after_minutes: 90 },
  /** Smaller meals are given at once (a later part of a few grams is not worth a reminder). */
  min_carbs_g: 10,
  min_later_carbs_g: 4,
} as const;

export type SplitAdviceLevel = 'MILD' | 'STRONG';

export interface SplitAdvice {
  policy_version: string;
  level: SplitAdviceLevel;
  now_percent: number;
  after_minutes: number;
  now_carbs_g: number;
  later_carbs_g: number;
  wbt_per_ww: number;
  fat_energy_percent: number;
  /** One Polish sentence: why and how. */
  reason: string;
}

export interface MealMacrosForAdvice {
  carbs_g: number;
  protein_g: number;
  fat_g: number;
}

/** Much fat or protein for the carbs (from 0,5 WBT/WW or 35% fat): the forecast delays its absorption (bolus-forecast.v4). */
export function isFattyMeal(macros: MealMacrosForAdvice): boolean {
  const share = mealFatProteinShare(macros);
  return share !== null && (share.wbt_per_ww >= SPLIT_ADVICE_POLICY.ratio_split || share.fat_energy_percent >= SPLIT_ADVICE_POLICY.fat_share_split);
}

/** The meal's numbers behind the advice (also when no split is advised). */
export function mealFatProteinShare(macros: MealMacrosForAdvice): { wbt_per_ww: number; fat_energy_percent: number } | null {
  if (!(macros.carbs_g > 0)) return null;
  const wbt = (4 * Math.max(0, macros.protein_g) + 9 * Math.max(0, macros.fat_g)) / 100;
  const energy = 4 * macros.carbs_g + 4 * Math.max(0, macros.protein_g) + 9 * Math.max(0, macros.fat_g);
  return {
    wbt_per_ww: Math.round((wbt / (macros.carbs_g / 10)) * 100) / 100,
    fat_energy_percent: Math.round(((9 * Math.max(0, macros.fat_g)) / energy) * 100),
  };
}

/**
 * The advised split, or null for one bolus. `stepUp`: the patient's own history (an early dip and a late rise after a
 * similar meal) moves the advice one level up: none → 70/30, 70/30 → 60/40.
 */
export function computeSplitAdvice(macros: MealMacrosForAdvice, stepUp = false): SplitAdvice | null {
  const share = mealFatProteinShare(macros);
  if (!share || macros.carbs_g < SPLIT_ADVICE_POLICY.min_carbs_g) return null;
  const strong = share.wbt_per_ww >= SPLIT_ADVICE_POLICY.ratio_strong || share.fat_energy_percent >= SPLIT_ADVICE_POLICY.fat_share_strong;
  const split = strong || share.wbt_per_ww >= SPLIT_ADVICE_POLICY.ratio_split || share.fat_energy_percent >= SPLIT_ADVICE_POLICY.fat_share_split;
  const level: SplitAdviceLevel | null = strong || (split && stepUp) ? 'STRONG' : split || stepUp ? 'MILD' : null;
  if (!level) return null;
  const shape = level === 'STRONG' ? SPLIT_ADVICE_POLICY.strong : SPLIT_ADVICE_POLICY.mild;
  const nowCarbs = Math.round((macros.carbs_g * shape.now_percent) / 100);
  const laterCarbs = Math.round(macros.carbs_g) - nowCarbs;
  if (laterCarbs < SPLIT_ADVICE_POLICY.min_later_carbs_g) return null;
  const ratio = share.wbt_per_ww.toFixed(2).replace('.', ',');
  return {
    policy_version: SPLIT_ADVICE_POLICY.version,
    level,
    now_percent: shape.now_percent,
    after_minutes: shape.after_minutes,
    now_carbs_g: nowCarbs,
    later_carbs_g: laterCarbs,
    wbt_per_ww: share.wbt_per_ww,
    fat_energy_percent: share.fat_energy_percent,
    reason: `Dużo tłuszczu i białka względem węglowodanów (${ratio} WBT na WW, tłuszcz ${share.fat_energy_percent}% energii)${stepUp ? ' i podobny posiłek wcześniej dał spadek, a potem późny wzrost' : ''}: ${shape.now_percent}% teraz, reszta węglowodanów z dawką za ok. ${shape.after_minutes} min.`,
  };
}
