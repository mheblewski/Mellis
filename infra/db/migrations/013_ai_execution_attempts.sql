CREATE TABLE ai_execution_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_execution_id uuid NOT NULL REFERENCES ai_executions(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  model_fingerprint text NULL,
  input_fingerprint text NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  provider_latency_ms integer NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  error_type text NULL,
  error_code text NULL,
  input_tokens bigint NULL,
  output_tokens bigint NULL,
  total_tokens bigint NULL,
  cached_input_tokens bigint NULL,
  reasoning_tokens bigint NULL,
  estimated_cost numeric(20,12) NULL,
  cost_currency text NULL,
  pricing_version text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_execution_attempts_unique UNIQUE (ai_execution_id, attempt_number)
);

CREATE INDEX ai_execution_attempts_execution_idx ON ai_execution_attempts (ai_execution_id, created_at);
CREATE INDEX ai_execution_attempts_status_idx ON ai_execution_attempts (status, created_at);
