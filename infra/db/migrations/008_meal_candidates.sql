CREATE UNIQUE INDEX IF NOT EXISTS events_patient_id_id_unique
  ON events (patient_id, id);

CREATE TABLE IF NOT EXISTS meal_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  candidate_identity text NOT NULL,
  status text NOT NULL,
  anchor_type text NOT NULL,
  anchor_event_id text NULL,
  boundary jsonb NOT NULL DEFAULT '{}'::jsonb,
  algorithm_version text NOT NULL DEFAULT 'meal-candidate.v1',
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_candidates_unique UNIQUE (patient_id, candidate_identity),
  CONSTRAINT meal_candidates_id_patient_unique UNIQUE (id, patient_id),
  CONSTRAINT meal_candidates_status_check CHECK (status IN ('CANDIDATE', 'SUPPORTED', 'REJECTED', 'MERGED', 'DUPLICATE')),
  CONSTRAINT meal_candidates_algorithm_version_check CHECK (algorithm_version = 'meal-candidate.v1')
);

CREATE INDEX IF NOT EXISTS meal_candidates_patient_created_idx
  ON meal_candidates (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS meal_candidates_patient_status_idx
  ON meal_candidates (patient_id, status);

CREATE TABLE IF NOT EXISTS meal_candidate_associations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  event_id text NOT NULL,
  event_patient_id uuid NOT NULL,
  relation_type text NOT NULL,
  status text NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  algorithm_version text NOT NULL DEFAULT 'meal-candidate.v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_candidate_associations_unique UNIQUE (candidate_id, event_id, relation_type),
  CONSTRAINT meal_candidate_associations_candidate_fk FOREIGN KEY (candidate_id, patient_id) REFERENCES meal_candidates(id, patient_id) ON DELETE CASCADE,
  CONSTRAINT meal_candidate_associations_patient_fk FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  CONSTRAINT meal_candidate_associations_event_patient_check CHECK (event_patient_id = patient_id),
  CONSTRAINT meal_candidate_associations_status_check CHECK (status IN ('strongly_associated', 'probably_associated', 'possibly_associated', 'unresolved', 'probably_unrelated', 'unrelated')),
  CONSTRAINT meal_candidate_associations_algorithm_version_check CHECK (algorithm_version = 'meal-candidate.v1')
);

CREATE INDEX IF NOT EXISTS meal_candidate_associations_candidate_idx
  ON meal_candidate_associations (candidate_id, event_id, relation_type);

CREATE INDEX IF NOT EXISTS meal_candidate_associations_event_idx
  ON meal_candidate_associations (event_patient_id, event_id);

CREATE TABLE IF NOT EXISTS meal_candidate_hypotheses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  hypothesis_type text NOT NULL,
  status text NOT NULL,
  confidence text NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  alternatives jsonb NOT NULL DEFAULT '[]'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  algorithm_version text NOT NULL DEFAULT 'meal-candidate.v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_candidate_hypotheses_unique UNIQUE (candidate_id, hypothesis_type),
  CONSTRAINT meal_candidate_hypotheses_candidate_fk FOREIGN KEY (candidate_id, patient_id) REFERENCES meal_candidates(id, patient_id) ON DELETE CASCADE,
  CONSTRAINT meal_candidate_hypotheses_patient_fk FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  CONSTRAINT meal_candidate_hypotheses_status_check CHECK (status IN ('active', 'supported', 'weakened', 'rejected', 'superseded')),
  CONSTRAINT meal_candidate_hypotheses_confidence_check CHECK (confidence IN ('LOW', 'MODERATE', 'HIGH')),
  CONSTRAINT meal_candidate_hypotheses_algorithm_version_check CHECK (algorithm_version = 'meal-candidate.v1')
);

CREATE INDEX IF NOT EXISTS meal_candidate_hypotheses_candidate_idx
  ON meal_candidate_hypotheses (candidate_id, hypothesis_type);

CREATE INDEX IF NOT EXISTS meal_candidate_hypotheses_patient_idx
  ON meal_candidate_hypotheses (patient_id, hypothesis_type);
