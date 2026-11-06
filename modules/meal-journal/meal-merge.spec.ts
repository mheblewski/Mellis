import { describe, expect, it } from 'vitest';
import { carbsToAdd, hasOpenSplit, mealHasContent, mealStoredCarbs, mergeCarbsQuestion, MEAL_MERGE_POLICY, parseMergeMealIds, parseSplitChoice, planMealMerge, type MergeCandidate } from './application/meal-merge';

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 12, 0) + minutes * 60_000).toISOString();
const meal = (id: string, minutes: number, overrides: Partial<MergeCandidate> = {}): MergeCandidate => ({
  meal_id: id, started_at: at(minutes), has_content: false, split_open: false, source_carbs_g: 20, ...overrides,
});
const none = { grams: null, origin: null };

describe('meal merge plan (meal-merge.v1)', () => {
  it('joins meals without content into the earliest, nothing to keep or reset', () => {
    const plan = planMealMerge([meal('b', 40), meal('a', 0), meal('c', 90)]);
    expect(plan).toMatchObject({ ok: true, target_id: 'a', source_ids: ['b', 'c'], content: 'NONE', content_meal_id: null, split_meal_id: null });
  });

  it('keeps the one meal with content, its carbs grown by the others', () => {
    const plan = planMealMerge([meal('a', 0, { source_carbs_g: 30 }), meal('b', 30, { has_content: true, source_carbs_g: 45 }), meal('c', 60, { source_carbs_g: 12.5 })]);
    expect(plan).toMatchObject({ ok: true, target_id: 'b', source_ids: ['a', 'c'], content: 'KEPT', content_meal_id: 'b', added_carbs_g: 42.5 });
  });

  it('asks about carbs only when the kept meal has its own and the others would add some', () => {
    const asked = planMealMerge([meal('a', 0, { source_carbs_g: 10 }), meal('b', 30, { has_content: true, stored_carbs_g: 32 })]);
    expect(asked).toMatchObject({ ok: true, content: 'KEPT', kept_carbs_g: 32, added_carbs_g: 10 });
    const noOwnCarbs = planMealMerge([meal('a', 0, { source_carbs_g: 10 }), meal('b', 30, { has_content: true })]);
    expect(noOwnCarbs).toMatchObject({ ok: true, kept_carbs_g: null, added_carbs_g: 10 });
    const nothingAdded = planMealMerge([meal('a', 0, { source_carbs_g: 0 }), meal('b', 30, { has_content: true, stored_carbs_g: 32 })]);
    expect(nothingAdded).toMatchObject({ ok: true, kept_carbs_g: null });
    const reset = planMealMerge([meal('a', 0, { has_content: true, stored_carbs_g: 10 }), meal('b', 30, { has_content: true, stored_carbs_g: 32 })]);
    expect(reset).toMatchObject({ ok: true, content: 'RESET', kept_carbs_g: null });
  });

  it('asks with what the loop has for the kept meal', () => {
    const plan = planMealMerge([meal('a', 0, { source_carbs_g: 10 }), meal('b', 30, { has_content: true, stored_carbs_g: 32, source_carbs_g: 20 })]);
    expect(plan.ok && mergeCarbsQuestion(plan)).toEqual({ kept_g: 32, added_g: 10, loop_g: 20 });
  });

  it('included grams add nothing, or only what goes beyond the meal; extra grams add all', () => {
    expect(carbsToAdd({ added_carbs_g: 10, kept_carbs_g: 32 }, 'INCLUDED')).toBe(0);
    expect(carbsToAdd({ added_carbs_g: 10, kept_carbs_g: 8 }, 'INCLUDED')).toBe(2);
    expect(carbsToAdd({ added_carbs_g: 10, kept_carbs_g: 32 }, 'EXTRA')).toBe(10);
    expect(carbsToAdd({ added_carbs_g: 10, kept_carbs_g: 32 }, null)).toBe(10);
    expect(carbsToAdd({ added_carbs_g: 10, kept_carbs_g: null }, 'INCLUDED')).toBe(10);
  });

  it('counts carbs from a caregiver or the AI as the meal\'s own, not those copied from the loop', () => {
    const macros = (grams: number | null, origin: string | null) => ({ carbs: { grams, origin }, protein: none, fat: none });
    expect(mealStoredCarbs({ macros: macros(32, 'AI_PROPOSAL') })).toBe(32);
    expect(mealStoredCarbs({ macros: macros(32, 'CAREGIVER') })).toBe(32);
    expect(mealStoredCarbs({ macros: macros(32, 'NIGHTSCOUT_ENTRY') })).toBeNull();
    expect(mealStoredCarbs({ macros: macros(null, null) })).toBeNull();
  });

  it('resets content when several meals have their own', () => {
    const plan = planMealMerge([meal('a', 0, { has_content: true }), meal('b', 30, { has_content: true })]);
    expect(plan).toMatchObject({ ok: true, target_id: 'a', content: 'RESET', content_meal_id: null, added_carbs_g: 0 });
  });

  it('keeps the split meal as the merged one, also when another meal has the content', () => {
    const plan = planMealMerge([meal('a', 0, { has_content: true, source_carbs_g: 40 }), meal('b', 20, { split_open: true, source_carbs_g: 50 })]);
    expect(plan).toMatchObject({ ok: true, target_id: 'b', source_ids: ['a'], content: 'KEPT', content_meal_id: 'a', split_meal_id: 'b', added_carbs_g: 50 });
  });

  it('refuses more than one split meal', () => {
    const plan = planMealMerge([meal('a', 0, { split_open: true }), meal('b', 20, { split_open: true }), meal('c', 30)]);
    expect(plan).toMatchObject({ ok: false, code: 'MEAL_MERGE_SEVERAL_SPLIT' });
    if (!plan.ok) expect(plan.message).toContain('Takich posiłków nie można scalić');
  });

  it('refuses one meal, too many meals and meals too far apart', () => {
    expect(planMealMerge([meal('a', 0)])).toMatchObject({ ok: false, code: 'MEAL_MERGE_TOO_FEW' });
    const many = Array.from({ length: MEAL_MERGE_POLICY.max_meals + 1 }, (_, index) => meal(`m${index}`, index));
    expect(planMealMerge(many)).toMatchObject({ ok: false, code: 'MEAL_MERGE_TOO_MANY' });
    expect(planMealMerge([meal('a', 0), meal('b', MEAL_MERGE_POLICY.max_span_hours * 60 + 1)])).toMatchObject({ ok: false, code: 'MEAL_MERGE_TOO_FAR_APART' });
    expect(planMealMerge([meal('a', 0), meal('b', MEAL_MERGE_POLICY.max_span_hours * 60)])).toMatchObject({ ok: true });
  });

  it('allows meals within 4 hours only (the meal chart range, owner 2026-11-01)', () => {
    expect(MEAL_MERGE_POLICY.max_span_hours).toBe(4);
    expect(planMealMerge([meal('a', 0), meal('b', 60), meal('c', 240)])).toMatchObject({ ok: true });
    const refused = planMealMerge([meal('a', 0), meal('b', 60), meal('c', 241)]);
    expect(refused).toMatchObject({ ok: false, code: 'MEAL_MERGE_TOO_FAR_APART' });
    if (!refused.ok) expect(refused.message).toBe('Scalić można tylko posiłki, które zmieszczą się w 4 godzinach. Między pierwszym a ostatnim z zaznaczonych posiłków minęło więcej czasu.');
  });

  it('counts a description, photo, items or given values as content, not the loop carbs alone', () => {
    const base = { description: null, has_photo: false, items: null, macros: { carbs: none, protein: none, fat: none } };
    expect(mealHasContent(base)).toBe(false);
    expect(mealHasContent({ ...base, description: '  ' })).toBe(false);
    expect(mealHasContent({ ...base, description: 'Pizza' })).toBe(true);
    expect(mealHasContent({ ...base, has_photo: true })).toBe(true);
    expect(mealHasContent({ ...base, items: [{}] })).toBe(true);
    expect(mealHasContent({ ...base, macros: { carbs: { grams: 40, origin: 'NIGHTSCOUT_ENTRY' }, protein: none, fat: none } })).toBe(false);
    expect(mealHasContent({ ...base, macros: { carbs: none, protein: { grams: 12, origin: 'CAREGIVER' }, fat: none } })).toBe(true);
    expect(mealHasContent({ ...base, macros: { carbs: { grams: 55, origin: 'AI_PROPOSAL' }, protein: none, fat: none } })).toBe(true);
  });

  it('sees a split only in a later part or second dose still to come', () => {
    expect(hasOpenSplit([{ kind: 'PLANNED_PART', status: 'WAITING' }])).toBe(true);
    expect(hasOpenSplit([{ kind: 'SECOND_DOSE', status: 'DUE_NOW' }])).toBe(true);
    expect(hasOpenSplit([{ kind: 'PLANNED_PART', status: 'GIVEN' }, { kind: 'SECOND_DOSE', status: 'OFF' }])).toBe(false);
    expect(hasOpenSplit([{ kind: 'WBT', status: 'WAITING' }])).toBe(false);
  });

  it('parses the request', () => {
    expect(parseMergeMealIds(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(parseMergeMealIds('a')).toBeNull();
    expect(parseMergeMealIds([1])).toBeNull();
    expect(parseSplitChoice(undefined)).toBeNull();
    expect(parseSplitChoice('KEEP')).toBe('KEEP');
    expect(parseSplitChoice('RESPLIT')).toBe('RESPLIT');
    expect(parseSplitChoice('x')).toBe('INVALID');
  });
});
