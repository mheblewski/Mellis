/**
 * search_food in the main chat: the DiabCalc product search the meal chat uses, offered to conversation answers so a
 * question like "ile insuliny na 2 kajzerki z szynką?" or a photo of a plate gets macros from a product database instead
 * of the model's memory. Several products per call (the conversation allows one tool call per turn). DiabCalc is
 * hobby-hosted without an SLA: any failure becomes an UNAVAILABLE result and the answer estimates on its own.
 */
import type { AiRuntimeToolDefinition } from '@modules/ai-gateway/domain/ai-gateway';
import { type DiabCalcFood, type FoodSearch } from '../infrastructure/diabcalc-mcp-client';

export const SEARCH_FOOD_TOOL_NAME = 'search_food';
export const FOOD_SEARCH_POLICY_VERSION = 'food-search.v2';
/** search_food calls per answer: one for the meal, one more for products the first call did not find. */
export const MAX_FOOD_SEARCH_CALLS_PER_ANSWER = 2;
/** Products looked up in one call (the components of one meal). */
const MAX_FOOD_QUERIES_PER_CALL = 8;
const RESULTS_PER_QUERY = 3;

export const SEARCH_FOOD_TOOL_DEFINITION: AiRuntimeToolDefinition = {
  name: SEARCH_FOOD_TOOL_NAME,
  description: `Look up food products in the DiabCalc database (Polish products) by name: up to ${MAX_FOOD_QUERIES_PER_CALL} products in one call, ${RESULTS_PER_QUERY} best matches each, with carbohydrates, protein, fat and kcal per 100 g, a typical serving and the glycemic index. Returns FOUND, NONE_FOUND or UNAVAILABLE per call.`,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Polish product names, one per main component of the meal, without amounts (for example ["bułka kajzerka", "szynka konserwowa", "masło"]).',
      },
    },
    required: ['queries'],
  },
};

export const FOOD_SEARCH_INSTRUCTIONS = [
  'Food products: search_food looks products up in the DiabCalc database (values per 100 g). Use it when the caregiver asks about the macros of a food or meal described in words or shown in a photo, or about an insulin dose for such a meal, and the meal is not already in the evidence with confirmed macros.',
  'Recognise the main components and their weight in grams (from the message, a package or the photo: plate, cutlery, pieces; otherwise a typical portion for the patient\'s age, and say so). Call search_food once with all main components. Pick the best plain match (not gluten-free/light/special unless the message or photo says so). Compute each component: value_per_100g × grams / 100.',
  'In the answer give a short breakdown: each component with grams and carbohydrates (protein and fat when they matter, e.g. for WBT), marked "DiabCalc" or "szacunek", then the totals (W, B, T; WBT when fat and protein are significant). When a product is NONE_FOUND or the tool is UNAVAILABLE, estimate it yourself and mark it "szacunek".',
  'When the portion size changes the carbohydrates by more than about 20%, give your best estimate and ask one short question about the portion. A dose question then follows the dosing rules with these carbohydrates.',
].join('\n');

export interface FoodSearchOutcome {
  status: 'FOUND' | 'NONE_FOUND' | 'UNAVAILABLE';
  /** unavailable: this query's lookup failed (the others still count). */
  results: Array<{ query: string; foods: DiabCalcFood[]; unavailable?: boolean }>;
}

/** Normalised queries of one call: trimmed, deduplicated (case-insensitive), at most MAX_FOOD_QUERIES_PER_CALL. */
export function normalizeFoodQueries(raw: unknown): string[] {
  return allFoodQueries(raw).slice(0, MAX_FOOD_QUERIES_PER_CALL);
}

/** The queries of one call beyond MAX_FOOD_QUERIES_PER_CALL: not looked up, and the model is told which. */
export function droppedFoodQueries(raw: unknown): string[] {
  return allFoodQueries(raw).slice(MAX_FOOD_QUERIES_PER_CALL);
}

function allFoodQueries(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const value of values) {
    const query = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
  }
  return queries;
}

/**
 * Runs one search_food call; DiabCalc failures never fail the answer. Each query on its own: one that fails is marked
 * unavailable and the products found for the others are kept.
 */
export async function runFoodSearch(foods: FoodSearch, queries: string[]): Promise<FoodSearchOutcome> {
  const settled = await Promise.allSettled(queries.map((query) => foods.searchFood(query, RESULTS_PER_QUERY)));
  const results = queries.map((query, index) => {
    const outcome = settled[index];
    return outcome.status === 'fulfilled' ? { query, foods: outcome.value } : { query, foods: [] as DiabCalcFood[], unavailable: true };
  });
  if (results.length > 0 && results.every((result) => result.unavailable)) return { status: 'UNAVAILABLE', results: [] };
  return { status: results.some((result) => result.foods.length > 0) ? 'FOUND' : 'NONE_FOUND', results };
}

export function buildFoodSearchToolResult(queries: string[], outcome: FoodSearchOutcome, skipped: string[] = []): Record<string, unknown> {
  const skippedNote = skipped.length > 0 ? { skipped_queries: skipped, skipped_note: `At most ${MAX_FOOD_QUERIES_PER_CALL} products per call: these were not looked up; ask for them in the next call or estimate them (szacunek).` } : {};
  if (outcome.status === 'UNAVAILABLE') {
    return {
      tool: SEARCH_FOOD_TOOL_NAME,
      status: 'UNAVAILABLE',
      queries,
      products: [],
      note: 'The DiabCalc database is unavailable: estimate the values yourself and mark them as an estimate (szacunek).',
      ...skippedNote,
    };
  }
  return {
    tool: SEARCH_FOOD_TOOL_NAME,
    status: outcome.status,
    products: outcome.results.map((result) => ({
      query: result.query,
      matches: result.foods.map((food) => ({
        name: food.name,
        brand: food.brand,
        per_100g: food.per_100g,
        serving_grams: food.serving_grams,
        serving_note: food.serving_note,
        glycemic_index: food.glycemic_index,
      })),
      ...(result.unavailable
        ? { note: 'The lookup failed for this product: estimate it (szacunek).' }
        : result.foods.length === 0 ? { note: 'Not found: try another name in the second call or estimate it (szacunek).' } : {}),
    })),
    ...skippedNote,
  };
}
