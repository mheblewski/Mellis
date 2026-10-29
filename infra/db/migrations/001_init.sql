CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  communication_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  custom_instructions text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  date_of_birth date NULL,
  age_information jsonb NOT NULL DEFAULT '{}'::jsonb,
  diabetes_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE caregiver_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  relationship_type text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT caregiver_relationships_unique UNIQUE (user_id, patient_id, relationship_type)
);

CREATE TABLE therapies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  therapy_version text NOT NULL,
  active_profile_id text NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from timestamptz NULL,
  valid_to timestamptz NULL,
  observed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT therapies_version_unique UNIQUE (patient_id, therapy_version)
);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  source_system text NOT NULL,
  source_key text NOT NULL,
  sync_cursor text NULL,
  last_successful_observed_at timestamptz NULL,
  source_version text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sources_unique UNIQUE (patient_id, source_system, source_key)
);

CREATE TABLE source_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_system text NOT NULL,
  source_record_id text NULL,
  natural_key text NOT NULL,
  record_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  payload_version integer NOT NULL DEFAULT 1,
  normalization_version text NOT NULL DEFAULT 'nightscout.entries.v1',
  validity text NOT NULL DEFAULT 'VALID',
  raw_payload jsonb NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  canonical_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_records_unique UNIQUE (source_id, natural_key),
  CONSTRAINT source_records_canonical_hash_unique UNIQUE (source_system, canonical_hash)
);

CREATE UNIQUE INDEX source_records_source_system_record_id_unique
  ON source_records (source_system, source_record_id)
  WHERE source_record_id IS NOT NULL;

CREATE INDEX source_records_patient_occurred_idx ON source_records (patient_id, occurred_at DESC);

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  source_record_id uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_unique UNIQUE (patient_id, source_record_id, type)
);

CREATE TABLE current_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  state_version text NOT NULL,
  as_of timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT current_states_unique UNIQUE (patient_id, state_version)
);

CREATE TABLE hypo_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  trigger_id uuid NOT NULL,
  start_event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  analysis_id uuid NULL,
  recommendation_id uuid NULL,
  state text NOT NULL,
  severity text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NULL,
  latest_event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  rule_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hypo_episodes_unique UNIQUE (patient_id, start_event_id)
);

CREATE TABLE triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  type text NOT NULL,
  source_event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES hypo_episodes(id) ON DELETE CASCADE,
  rule_version text NOT NULL,
  status text NOT NULL,
  cooldown_seconds integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT triggers_unique UNIQUE (patient_id, type, source_event_id, rule_version)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES hypo_episodes(id) ON DELETE CASCADE,
  analysis_id uuid NULL,
  recommendation_id uuid NULL,
  thread_state_version text NOT NULL,
  awaiting_user_answer boolean NOT NULL DEFAULT false,
  conversation_type text NOT NULL DEFAULT 'TRIGGER_INITIATED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_unique UNIQUE (patient_id, episode_id)
);

CREATE TABLE context_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  question_id text NOT NULL,
  question_type text NOT NULL DEFAULT 'CONTEXT_QUESTION',
  question_text text NOT NULL DEFAULT '',
  reason text NOT NULL,
  expected_information_gain text NOT NULL,
  expected_answer_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  related_event_id uuid NULL REFERENCES events(id) ON DELETE SET NULL,
  status text NOT NULL,
  answer_message_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT context_questions_unique UNIQUE (conversation_id, question_id)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  role text NOT NULL,
  message_type text NOT NULL,
  content text NOT NULL,
  question_id text NULL,
  answer_type text NULL,
  answer_text text NULL,
  answer_value boolean NULL,
  provenance_ref text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_idempotency_unique UNIQUE (conversation_id, idempotency_key)
);

CREATE TABLE analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES hypo_episodes(id) ON DELETE CASCADE,
  trigger_id uuid NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  task_type text NOT NULL,
  status text NOT NULL,
  facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  unknowns jsonb NOT NULL DEFAULT '[]'::jsonb,
  calculations jsonb NOT NULL DEFAULT '[]'::jsonb,
  hypotheses jsonb NOT NULL DEFAULT '[]'::jsonb,
  assumptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  uncertainty jsonb NOT NULL DEFAULT '{}'::jsonb,
  rationale text NOT NULL DEFAULT '',
  analysis_version text NOT NULL DEFAULT 'analysis.v1',
  context_package_id uuid NULL,
  context_package_version text NULL,
  context_package_hash text NULL,
  input_hash text NULL,
  prompt_version text NULL,
  model_fingerprint text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analyses_unique UNIQUE (patient_id, episode_id, task_type, context_package_hash)
);

CREATE TABLE recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES hypo_episodes(id) ON DELETE CASCADE,
  status text NOT NULL,
  facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  unknowns jsonb NOT NULL DEFAULT '[]'::jsonb,
  calculations jsonb NOT NULL DEFAULT '[]'::jsonb,
  hypotheses jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposal jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recommendations_unique UNIQUE (analysis_id)
);

CREATE TABLE context_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  package_version text NOT NULL,
  content_hash text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT context_packages_unique UNIQUE (package_version, content_hash)
);

CREATE TABLE ai_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_identity text NOT NULL,
  task_id text NOT NULL,
  task_type text NOT NULL,
  task_version text NOT NULL,
  patient_id text NULL,
  trigger_id text NULL,
  analysis_id text NULL,
  context_package_id text NOT NULL,
  context_package_version text NOT NULL,
  context_package_hash text NOT NULL,
  correlation_id text NOT NULL,
  input_hash text NOT NULL,
  prompt_version text NOT NULL,
  output_schema_version text NOT NULL,
  model_policy_version text NOT NULL,
  provider text NULL,
  model text NULL,
  model_fingerprint text NULL,
  input_tokens bigint NULL,
  output_tokens bigint NULL,
  total_tokens bigint NULL,
  cached_input_tokens bigint NULL,
  reasoning_tokens bigint NULL,
  input_fingerprint text NULL,
  serialized_input_bytes integer NULL,
  provider_latency_ms integer NULL,
  context_package_usage jsonb NULL,
  estimated_cost numeric(20,12) NULL,
  cost_currency text NULL,
  pricing_version text NULL,
  status text NOT NULL,
  normalized_result jsonb NULL,
  error jsonb NULL,
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  failed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_executions_task_identity_unique UNIQUE (task_identity)
);

CREATE INDEX ai_executions_correlation_idx ON ai_executions (correlation_id, created_at);
CREATE INDEX ai_executions_status_idx ON ai_executions (status, created_at);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  status text NOT NULL,
  payload_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  dedupe_key text NOT NULL,
  correlation_id uuid NOT NULL,
  causation_id uuid NULL,
  patient_id uuid NULL REFERENCES patients(id) ON DELETE CASCADE,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz NULL,
  lock_expires_at timestamptz NULL,
  locked_by text NULL,
  lease_token uuid NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  last_error jsonb NULL,
  completed_at timestamptz NULL,
  failed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_unique UNIQUE (job_type, dedupe_key)
);

CREATE INDEX jobs_claimable_idx ON jobs (status, available_at, created_at);
CREATE INDEX jobs_running_lease_idx ON jobs (status, lock_expires_at) WHERE status = 'running';
CREATE INDEX jobs_correlation_idx ON jobs (correlation_id);
CREATE INDEX jobs_causation_idx ON jobs (causation_id);
CREATE INDEX jobs_patient_idx ON jobs (patient_id, created_at) WHERE patient_id IS NOT NULL;

CREATE TABLE audit_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NULL REFERENCES patients(id) ON DELETE SET NULL,
  actor_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  correlation_id uuid NULL,
  causation_id uuid NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
