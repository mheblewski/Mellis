CREATE TABLE patient_context (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  fact_key text NOT NULL,
  fact_name text NOT NULL,
  fact_type text NOT NULL,
  scope text NOT NULL,
  value jsonb NOT NULL DEFAULT 'null'::jsonb,
  value_type text NOT NULL,
  knowledge_status text NOT NULL,
  source_type text NOT NULL,
  source_ref text NOT NULL,
  source_event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source_conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_question_id text NOT NULL,
  related_episode_id uuid NULL REFERENCES hypo_episodes(id) ON DELETE SET NULL,
  related_trigger_id uuid NULL REFERENCES triggers(id) ON DELETE SET NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  confidence text NOT NULL,
  validity text NOT NULL,
  created_by text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_context_event_unique UNIQUE (patient_id, fact_key, scope, source_event_id, source_question_id)
);

CREATE INDEX patient_context_event_lookup_idx
  ON patient_context (patient_id, source_event_id, fact_key, scope, status, validity, knowledge_status);

CREATE INDEX patient_context_conversation_idx
  ON patient_context (source_conversation_id, source_question_id, recorded_at DESC);
