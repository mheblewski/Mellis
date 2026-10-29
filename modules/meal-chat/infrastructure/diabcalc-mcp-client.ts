/**
 * Minimal MCP client (streamable HTTP, JSON responses) for the public DiabCalc server. Only the anonymous product
 * search is used: no DiabCalc account or token, and only food names leave GlucoMind. The server is hobby-hosted with no
 * SLA, so every failure surfaces as DiabCalcUnavailableError and the meal chat estimates on its own.
 */

const DEFAULT_DIABCALC_MCP_URL = 'https://olga345-20345.wykr.es/mcp';
const PROTOCOL_VERSION = '2025-06-18';

export interface DiabCalcFood {
  name: string;
  brand: string | null;
  serving_grams: number | null;
  serving_note: string | null;
  per_100g: { carbs_g: number | null; protein_g: number | null; fat_g: number | null; kcal: number | null };
  glycemic_index: number | null;
}

export class DiabCalcUnavailableError extends Error {
  constructor(reason: string) {
    super(`DiabCalc unavailable: ${reason}`);
    this.name = 'DiabCalcUnavailableError';
  }
}

export interface FoodSearch {
  searchFood(query: string, limit?: number): Promise<DiabCalcFood[]>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/**
 * Products found, kept in the worker for a week: a new lookup takes 1-5 s (the server keeps its own results only for
 * minutes) and the same products come back day after day. Product values change rarely; a restart empties it. Shared
 * by every client of the process (the meal chat builds its client per job). Empty results are not kept.
 */
const SEARCH_CACHE_TTL_MS = 7 * 24 * 3_600_000;
const SEARCH_CACHE_MAX_ENTRIES = 1000;
const searchCache = new Map<string, { stored_at: number; foods: DiabCalcFood[] }>();
const searchesInFlight = new Map<string, Promise<DiabCalcFood[]>>();

/** Tests only: forget every kept product. */
export function clearDiabCalcSearchCache(): void {
  searchCache.clear();
  searchesInFlight.clear();
}

function copyFoods(foods: DiabCalcFood[]): DiabCalcFood[] {
  return foods.map((food) => ({ ...food, per_100g: { ...food.per_100g } }));
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class DiabCalcMcpClient implements FoodSearch {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly timeoutMs = 10_000,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv): DiabCalcMcpClient | null {
    const configured = env.DIABCALC_MCP_URL;
    // Explicitly empty disables DiabCalc; unset uses the public endpoint.
    if (configured !== undefined && configured.trim() === '') return null;
    return new DiabCalcMcpClient(configured?.trim() || DEFAULT_DIABCALC_MCP_URL);
  }

  async searchFood(query: string, limit = 5): Promise<DiabCalcFood[]> {
    const trimmed = query.trim().slice(0, 200);
    if (!trimmed) return [];
    const boundedLimit = Math.max(1, Math.min(8, Math.floor(limit)));
    const key = `${this.endpoint}|${boundedLimit}|${trimmed.toLowerCase().replace(/\s+/g, ' ')}`;
    const kept = searchCache.get(key);
    if (kept && Date.now() - kept.stored_at < SEARCH_CACHE_TTL_MS) return copyFoods(kept.foods);
    if (kept) searchCache.delete(key);
    // The same product asked twice at once (two searches of one answer) is looked up once.
    const running = searchesInFlight.get(key);
    if (running) return running;
    const search = this.searchFoodUncached(trimmed, boundedLimit).then((foods) => {
      if (foods.length > 0) {
        searchCache.set(key, { stored_at: Date.now(), foods: copyFoods(foods) });
        if (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) searchCache.delete(searchCache.keys().next().value as string);
      }
      return foods;
    }).finally(() => searchesInFlight.delete(key));
    searchesInFlight.set(key, search);
    return search;
  }

  private async searchFoodUncached(trimmed: string, limit: number): Promise<DiabCalcFood[]> {
    const result = await this.callTool('search_food', { query: trimmed, limit });
    const data = (result?.structuredContent as { data?: { foods?: unknown[] } } | undefined)?.data;
    const foods = Array.isArray(data?.foods) ? data.foods : [];
    return foods.map((raw) => {
      const food = (raw ?? {}) as Record<string, unknown>;
      const per100g = (food.per100g ?? {}) as Record<string, unknown>;
      const glycemic = (food.glycemic ?? {}) as Record<string, unknown>;
      return {
        name: String(food.name ?? ''),
        brand: typeof food.brand === 'string' && food.brand ? food.brand : null,
        serving_grams: numberOrNull(food.servingGrams),
        serving_note: typeof food.servingNote === 'string' && food.servingNote ? food.servingNote : null,
        per_100g: {
          carbs_g: numberOrNull(per100g.carbohydrates),
          protein_g: numberOrNull(per100g.protein),
          fat_g: numberOrNull(per100g.fat),
          kcal: numberOrNull(per100g.energyKcal),
        },
        glycemic_index: numberOrNull(glycemic.value),
      };
    }).filter((food) => food.name.length > 0);
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    if (!this.sessionId) {
      await this.initialize();
    }
    try {
      return await this.request('tools/call', { name, arguments: args });
    } catch (error) {
      // An expired session: start a new one once.
      if (error instanceof SessionExpiredError) {
        this.sessionId = null;
        await this.initialize();
        return this.request('tools/call', { name, arguments: args });
      }
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    const { sessionId } = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'glucomind', version: '1.0' } },
    });
    this.sessionId = sessionId;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  private async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const { body } = await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params });
    const parsed = body as { result?: Record<string, unknown>; error?: { message?: string } } | null;
    if (parsed?.error) {
      throw new DiabCalcUnavailableError(`rpc error ${parsed.error.message ?? ''}`.trim());
    }
    if (parsed?.result?.isError === true) {
      throw new DiabCalcUnavailableError('tool error');
    }
    return parsed?.result;
  }

  private async post(payload: Record<string, unknown>): Promise<{ sessionId: string | null; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
      };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      const response = await this.fetchImpl(this.endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
      if ((response.status === 404 || response.status === 400) && this.sessionId && payload.method !== 'initialize') {
        throw new SessionExpiredError();
      }
      if (response.status === 202) {
        return { sessionId: response.headers.get('mcp-session-id'), body: null };
      }
      if (response.status < 200 || response.status >= 300) {
        throw new DiabCalcUnavailableError(`HTTP ${response.status}`);
      }
      const text = await response.text();
      return { sessionId: response.headers.get('mcp-session-id'), body: parseBody(text, response.headers.get('content-type')) };
    } catch (error) {
      if (error instanceof SessionExpiredError || error instanceof DiabCalcUnavailableError) throw error;
      throw new DiabCalcUnavailableError((error as { name?: string })?.name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }
}

class SessionExpiredError extends Error {}

/** JSON, or the last JSON-RPC message of an SSE stream. */
function parseBody(text: string, contentType: string | null): unknown {
  if (!text) return null;
  if (contentType?.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0);
    return data.length > 0 ? JSON.parse(data[data.length - 1]) : null;
  }
  return JSON.parse(text);
}
