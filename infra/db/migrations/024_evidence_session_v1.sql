CREATE TABLE evidence_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_execution_id uuid NOT NULL REFERENCES ai_executions(id) ON DELETE CASCADE,
  patient_id text NOT NULL,
  task_type text NOT NULL,
  context_package_id text NOT NULL,
  context_package_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  initial_evidence_hash text NOT NULL,
  initial_evidence_bytes integer NOT NULL,
  tool_call_count integer NOT NULL DEFAULT 0,
  successful_tool_call_count integer NOT NULL DEFAULT 0,
  failed_tool_call_count integer NOT NULL DEFAULT 0,
  total_tool_result_bytes bigint NOT NULL DEFAULT 0,
  unique_tool_result_bytes bigint NOT NULL DEFAULT 0,
  duplicated_tool_result_bytes bigint NOT NULL DEFAULT 0,
  failure jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_sessions_ai_execution_unique UNIQUE (ai_execution_id)
);

CREATE INDEX evidence_sessions_patient_idx ON evidence_sessions (patient_id, created_at);
CREATE INDEX evidence_sessions_status_idx ON evidence_sessions (status, created_at);

CREATE TABLE evidence_session_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES evidence_sessions(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  call_id text NULL,
  tool_name text NOT NULL,
  request_hash text NOT NULL,
  arguments jsonb NOT NULL,
  patient_id text NOT NULL,
  time_range jsonb NULL,
  detail_level text NULL,
  result_status text NULL,
  result_hash text NULL,
  result_bytes integer NULL,
  compiler_version text NULL,
  evidence_version text NULL,
  provenance_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('REQUESTED', 'SUCCEEDED', 'FAILED')),
  failure jsonb NULL,
  requested_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_session_tool_calls_session_sequence_unique UNIQUE (session_id, sequence)
);

CREATE INDEX evidence_session_tool_calls_session_idx ON evidence_session_tool_calls (session_id, sequence);
CREATE INDEX evidence_session_tool_calls_call_id_idx ON evidence_session_tool_calls (call_id) WHERE call_id IS NOT NULL;
CREATE INDEX evidence_session_tool_calls_result_hash_idx ON evidence_session_tool_calls (result_hash) WHERE result_hash IS NOT NULL;
