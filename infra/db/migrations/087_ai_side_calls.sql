-- Paid AI calls made outside the AI gateway's records (owner 2026-10-26: the meal chat and the WBT screen were only in
-- the budget ledger): what each used and cost and how long it took. No prompt or answer text, no patient data.

CREATE TABLE IF NOT EXISTS ai_side_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- MEAL_CHAT (one round of a meal chat reply) or WBT_SUGGESTION (the WBT screen's dose).
  kind text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  -- OK, FAILED (error or timeout: the cost is unknown, the ledger keeps the worst case), REFUSED_AFTER_CALL.
  outcome text NOT NULL,
  input_tokens integer NULL,
  output_tokens integer NULL,
  cached_input_tokens integer NULL,
  cache_write_tokens integer NULL,
  cost numeric(12, 6) NULL,
  currency text NULL,
  latency_ms integer NOT NULL,
  error_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_side_calls_kind_check CHECK (kind IN ('MEAL_CHAT', 'WBT_SUGGESTION')),
  CONSTRAINT ai_side_calls_outcome_check CHECK (outcome IN ('OK', 'FAILED', 'REFUSED_AFTER_CALL'))
);

CREATE INDEX IF NOT EXISTS ai_side_calls_created_idx ON ai_side_calls (created_at DESC);
