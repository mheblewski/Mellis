ALTER TABLE ai_executions
  ADD COLUMN IF NOT EXISTS input_tokens bigint NULL,
  ADD COLUMN IF NOT EXISTS output_tokens bigint NULL,
  ADD COLUMN IF NOT EXISTS total_tokens bigint NULL,
  ADD COLUMN IF NOT EXISTS cached_input_tokens bigint NULL,
  ADD COLUMN IF NOT EXISTS reasoning_tokens bigint NULL,
  ADD COLUMN IF NOT EXISTS input_fingerprint text NULL,
  ADD COLUMN IF NOT EXISTS serialized_input_bytes integer NULL,
  ADD COLUMN IF NOT EXISTS provider_latency_ms integer NULL,
  ADD COLUMN IF NOT EXISTS context_package_usage jsonb NULL,
  ADD COLUMN IF NOT EXISTS estimated_cost numeric(20,12) NULL,
  ADD COLUMN IF NOT EXISTS cost_currency text NULL,
  ADD COLUMN IF NOT EXISTS pricing_version text NULL;
