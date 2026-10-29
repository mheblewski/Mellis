CREATE TABLE investigations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  event_family text NOT NULL,
  episode_id uuid NOT NULL REFERENCES hypo_episodes(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  trigger_id uuid NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  candidate_id text NOT NULL,
  candidate_version text NOT NULL,
  fact_key text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  decision text NOT NULL DEFAULT 'ASK_NOW',
  reason text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT investigations_unique UNIQUE (patient_id, event_family, episode_id, candidate_id)
);

CREATE INDEX investigations_patient_status_idx
  ON investigations (patient_id, event_family, status, updated_at DESC);