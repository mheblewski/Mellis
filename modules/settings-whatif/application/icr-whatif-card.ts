import { ICR_WHATIF_POLICY, type WhatIfGroup, type WhatIfResult } from './icr-whatif';
import { icrBlocks, type DayPart, type IcrBlock } from './icr-whatif-intent';

/**
 * The card above a what-if answer (icr-whatif-card.v1), carried as a metric card of kind SETTING_WHATIF (older apps
 * show no card for a kind they do not know, only the text). Numbers are rounded here, once: percentages of time to one
 * decimal, glucose and counts to whole numbers, doses to 0.01 U.
 */
export const ICR_WHATIF_CARD_VERSION = 'icr-whatif-card.v1';

export interface NowAfter { now: number; after: number }

export interface IcrWhatIfCardBlock {
  start: string;
  end: string;
  /** "Rano" */
  label: string;
  icr_now: number;
  icr_after: number;
  meals: number;
  time_below_70: NowAfter;
  time_above_180: NowAfter;
  /** Too few meals here for its own replay: shown greyed, never the best trade-off. */
  small: boolean;
}

export interface IcrWhatIfCard {
  version: string;
  /** "Wszystkie pory: 20% mniej insuliny na węgle", "ICR rano 5 → 6,3" */
  title: string;
  /** "Wszystkie pory", "Rano, 6:00–9:30" */
  scope_label: string;
  /** Change of the carb insulin per meal (negative: less). */
  dose_change_u_per_meal: number;
  meals: number;
  small_sample: boolean;
  /** Percent of time in the 5 h after meals. */
  time_below_70: NowAfter;
  time_above_180: NowAfter;
  mean_mgdl: NowAfter;
  meals_with_drop_below_70: NowAfter;
  meals_above_180_over_1h: NowAfter;
  /** Certain fact from the data: meals that went above 180 and later below 70. */
  meals_high_then_low: number;
  night: { nights: number; drop_below_70: NowAfter; above_180_over_1h: NowAfter } | null;
  /** All times of day replayed with the same proportion, in day order. */
  blocks: IcrWhatIfCardBlock[];
  /** The block with the most time below 70 removed per time above 180 added; null with fewer than two to compare. */
  best_block: string | null;
  /** First and last meal, "9.10" / "8.11". */
  from_label: string;
  to_label: string;
  basis: 'PROFILE_ISF_WITH_MEASURED_LOOP';
}

const LABEL: Record<DayPart, string> = { MORNING: 'Rano', DAY: 'W dzień', EVENING: 'Wieczorem', NIGHT: 'W nocy' };
const ORDER: DayPart[] = ['MORNING', 'DAY', 'EVENING', 'NIGHT'];
const pct = (share: number) => Math.round(share * 1000) / 10;
const whole = (value: number) => Math.round(value);
const clock = (time: string) => time.replace(/^0(\d):/, '$1:');

function dayLabel(ms: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'numeric' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${Number(parts.day)}.${Number(parts.month)}`;
}

function blockOf(group: WhatIfGroup, blocks: IcrBlock[], ratio: number): IcrWhatIfCardBlock | null {
  const block = blocks.find((b) => b.start === group.key);
  if (!block) return null;
  return {
    start: block.start,
    end: block.end,
    label: LABEL[block.part],
    icr_now: block.value,
    icr_after: Math.round(block.value * ratio * 10) / 10,
    meals: group.meals,
    time_below_70: { now: pct(group.now.time_below_70), after: pct(group.after.time_below_70) },
    time_above_180: { now: pct(group.now.time_above_180), after: pct(group.after.time_above_180) },
    small: group.meals < ICR_WHATIF_POLICY.min_meals,
  };
}

/**
 * The card from the replay of the named scope and the replay of all times with the same ratio (for the comparison).
 * Null when the scoped replay has no result.
 */
export function buildIcrWhatIfCard(args: {
  title: string;
  scoped: WhatIfResult;
  all: WhatIfResult | null;
  schedule: Array<[string, number]>;
  timeZone: string;
}): IcrWhatIfCard | null {
  if (args.scoped.status !== 'OK') return null;
  const result = args.scoped;
  const blocks = icrBlocks(args.schedule);
  const total = result.total;
  const scopeBlocks = result.scope.kind === 'ALL' ? blocks : blocks.filter((b) => (result.scope.kind === 'BLOCK' ? b.start === result.scope.start : result.scope.kind === 'BLOCKS' && result.scope.starts.includes(b.start)));
  const scopeLabel = result.scope.kind === 'ALL'
    ? 'Wszystkie pory'
    : scopeBlocks.map((b) => `${LABEL[b.part]}, ${clock(b.start)}–${clock(b.end)}`).join(' · ');

  const comparison = (args.all?.status === 'OK' ? args.all.blocks : result.blocks)
    .map((group) => blockOf(group, blocks, result.ratio))
    .filter((b): b is IcrWhatIfCardBlock => b !== null)
    .sort((a, b) => ORDER.indexOf(blocks.find((x) => x.start === a.start)!.part) - ORDER.indexOf(blocks.find((x) => x.start === b.start)!.part));
  const eligible = comparison.filter((b) => !b.small);
  let best: string | null = null;
  if (eligible.length >= 2) {
    const score = (b: IcrWhatIfCardBlock) => {
      const gain = b.time_below_70.now - b.time_below_70.after;
      const cost = b.time_above_180.after - b.time_above_180.now;
      return cost <= 0.05 ? (gain > 0 ? Infinity : 0) : gain / cost;
    };
    best = [...eligible].sort((a, b) => score(b) - score(a))[0].start;
  }

  return {
    version: ICR_WHATIF_CARD_VERSION,
    title: args.title,
    scope_label: scopeLabel,
    dose_change_u_per_meal: Math.round(total.dose_change_u_per_meal * 100) / 100,
    meals: total.meals,
    small_sample: result.small_sample,
    time_below_70: { now: pct(total.now.time_below_70), after: pct(total.after.time_below_70) },
    time_above_180: { now: pct(total.now.time_above_180), after: pct(total.after.time_above_180) },
    mean_mgdl: { now: whole(total.now.mean_mgdl), after: whole(total.after.mean_mgdl) },
    meals_with_drop_below_70: { now: total.now.meals_with_drop_below_70, after: total.after.meals_with_drop_below_70 },
    meals_above_180_over_1h: { now: total.now.meals_above_180_over_1h, after: total.after.meals_above_180_over_1h },
    meals_high_then_low: total.meals_high_then_low,
    night: result.night
      ? { nights: result.night.nights, drop_below_70: { now: result.night.now.with_drop_below_70, after: result.night.after.with_drop_below_70 }, above_180_over_1h: { now: result.night.now.above_180_over_1h, after: result.night.after.above_180_over_1h } }
      : null,
    blocks: comparison,
    best_block: best,
    from_label: dayLabel(result.first_meal_ms, args.timeZone),
    to_label: dayLabel(result.last_meal_ms, args.timeZone),
    basis: 'PROFILE_ISF_WITH_MEASURED_LOOP',
  };
}

/** The reply when the scope has too few meals for a replay (written by code). */
export function tooFewMealsMessage(scopeLabel: string, meals: number): string {
  const where = scopeLabel === 'Wszystkie pory' ? 'W ostatnich 31 dniach' : `W porze „${scopeLabel}” w ostatnich 31 dniach`;
  return `${where} jest za mało posiłków z bolusem, żeby to przeliczyć (${meals}, potrzeba co najmniej ${ICR_WHATIF_POLICY.min_meals}). Spróbuj innej pory albo wróć do tego za kilka tygodni.`;
}

/** Light structural check of a stored card (the app trusts the server; this keeps junk out of drafts and messages). */
export function sanitizeIcrWhatIfCard(value: unknown): IcrWhatIfCard | null {
  if (typeof value !== 'object' || value === null) return null;
  const card = value as Record<string, unknown>;
  const pair = (v: unknown) => typeof v === 'object' && v !== null && Number.isFinite((v as NowAfter).now) && Number.isFinite((v as NowAfter).after);
  if (card.version !== ICR_WHATIF_CARD_VERSION || typeof card.title !== 'string' || typeof card.scope_label !== 'string') return null;
  if (!Number.isFinite(card.meals) || !Number.isFinite(card.dose_change_u_per_meal)) return null;
  if (![card.time_below_70, card.time_above_180, card.mean_mgdl, card.meals_with_drop_below_70, card.meals_above_180_over_1h].every(pair)) return null;
  if (!Array.isArray(card.blocks)) return null;
  return card as unknown as IcrWhatIfCard;
}
