import type { Pool } from 'pg';
import type { SettledAiCall } from '@modules/ai-gateway/infrastructure/guarded-openai-client';

export type AiSideCallKind = 'MEAL_CHAT' | 'WBT_SUGGESTION';

/** ai_side_calls (migration 087): the meal chat's and the WBT screen's paid calls. */
export class PostgresAiSideCallRepository {
  constructor(private readonly pool: Pool) {}

  async record(kind: AiSideCallKind, call: SettledAiCall): Promise<void> {
    await this.pool.query(
      `INSERT INTO ai_side_calls (kind, provider, model, outcome, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens, cost, currency, latency_ms, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        kind, call.provider, call.model.slice(0, 80), call.outcome,
        call.usage?.input_tokens ?? null, call.usage?.output_tokens ?? null, call.usage?.cached_input_tokens ?? null, call.usage?.cache_write_tokens ?? null,
        call.cost, call.currency, Math.max(0, Math.round(call.latency_ms)), call.error_code,
      ],
    );
  }
}
