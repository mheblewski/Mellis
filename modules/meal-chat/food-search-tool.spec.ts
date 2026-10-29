import { describe, expect, it } from 'vitest';
import { buildFoodSearchToolResult, droppedFoodQueries, normalizeFoodQueries, runFoodSearch } from './application/food-search-tool';
import { DiabCalcUnavailableError } from './infrastructure/diabcalc-mcp-client';

const food = (name: string) => ({ name, brand: null, per_100g: { carbs_g: 10, protein_g: 1, fat_g: 1, kcal: 50 }, serving_grams: null, serving_note: null, glycemic_index: null }) as any;

describe('search_food per query', () => {
  it('keeps the products found when one lookup fails, and is unavailable only when all fail', async () => {
    const foods = { searchFood: async (query: string) => { if (query === 'pizza') throw new Error('socket hang up'); return [food(query)]; } };
    const outcome = await runFoodSearch(foods as any, ['chleb', 'pizza']);
    expect(outcome.status).toBe('FOUND');
    const result: any = buildFoodSearchToolResult(['chleb', 'pizza'], outcome);
    expect(result.products[0].matches).toHaveLength(1);
    expect(result.products[1]).toMatchObject({ query: 'pizza', matches: [], note: expect.stringContaining('lookup failed') });
    const down = { searchFood: async () => { throw new DiabCalcUnavailableError('down'); } };
    expect((await runFoodSearch(down as any, ['chleb'])).status).toBe('UNAVAILABLE');
  });

  it('tells the model which products beyond the per-call limit were not looked up', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `produkt ${i}`);
    expect(normalizeFoodQueries(raw)).toHaveLength(8);
    expect(droppedFoodQueries(raw)).toEqual(['produkt 8', 'produkt 9']);
    const result: any = buildFoodSearchToolResult(normalizeFoodQueries(raw), { status: 'NONE_FOUND', results: [] }, droppedFoodQueries(raw));
    expect(result.skipped_queries).toEqual(['produkt 8', 'produkt 9']);
  });
});
