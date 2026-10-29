CREATE TABLE IF NOT EXISTS compact_delivery_rollout_state (
  task_type text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('SHADOW', 'COMPACT', 'ROLLBACK')),
  readiness_status text NOT NULL CHECK (readiness_status IN ('NOT_READY', 'READY_TO_ENABLE')),
  policy_version text NOT NULL,
  observation_start_at timestamptz NULL,
  observation_end_at timestamptz NULL,
  last_evaluated_at timestamptz NULL,
  last_transition_at timestamptz NOT NULL DEFAULT now(),
  transition_reason text NULL,
  previous_state text NULL,
  metrics_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compact_delivery_rollout_state_state_idx
  ON compact_delivery_rollout_state (state, last_evaluated_at DESC);

CREATE INDEX IF NOT EXISTS compact_delivery_rollout_state_policy_idx
  ON compact_delivery_rollout_state (policy_version, last_evaluated_at DESC);
