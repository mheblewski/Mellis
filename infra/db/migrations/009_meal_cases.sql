CREATE TABLE IF NOT EXISTS meal_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  meal_case_identity text NOT NULL,
  candidate_id uuid NOT NULL,
  candidate_identity text NOT NULL,
  event_family text NOT NULL DEFAULT 'MEAL',
  state text NOT NULL,
  meal_start timestamptz NULL,
  meal_end timestamptz NULL,
  boundary_status text NOT NULL,
  anchor_type text NOT NULL,
  anchor_event_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  intake_carbohydrate_amount numeric NULL,
  intake_carbohydrate_status text NOT NULL,
  intake_staged boolean NOT NULL DEFAULT false,
  intake_source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  glucose_outcome_status text NOT NULL,
  glucose_outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  insulin_strategy jsonb NOT NULL DEFAULT '{}'::jsonb,
  iob_value numeric NULL,
  iob_status text NOT NULL,
  cob_value numeric NULL,
  cob_status text NOT NULL,
  therapy_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  activity_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  other_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  algorithm_version text NOT NULL,
  reconstruction_version text NOT NULL,
  reconstructed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_cases_unique_reconstruction UNIQUE (patient_id, candidate_identity, reconstruction_version),
  CONSTRAINT meal_cases_candidate_fk FOREIGN KEY (candidate_id, patient_id) REFERENCES meal_candidates(id, patient_id) ON DELETE CASCADE,
  CONSTRAINT meal_cases_state_check CHECK (state IN ('RECONSTRUCTING', 'RECONSTRUCTED', 'PARTIAL', 'INVALIDATED')),
  CONSTRAINT meal_cases_boundary_status_check CHECK (boundary_status IN ('KNOWN', 'ESTIMATED', 'UNCERTAIN')),
  CONSTRAINT meal_cases_intake_status_check CHECK (intake_carbohydrate_status IN ('KNOWN', 'UNKNOWN', 'MISSING')),
  CONSTRAINT meal_cases_iob_status_check CHECK (iob_status IN ('KNOWN', 'UNKNOWN', 'MISSING')),
  CONSTRAINT meal_cases_cob_status_check CHECK (cob_status IN ('KNOWN', 'UNKNOWN', 'MISSING')),
  CONSTRAINT meal_cases_glucose_outcome_status_check CHECK (glucose_outcome_status IN ('KNOWN', 'UNKNOWN', 'MISSING', 'INSUFFICIENT_DATA')),
  CONSTRAINT meal_cases_algorithm_version_check CHECK (algorithm_version = 'meal-case.v1'),
  CONSTRAINT meal_cases_event_family_check CHECK (event_family = 'MEAL')
);

CREATE INDEX IF NOT EXISTS meal_cases_patient_state_idx
  ON meal_cases (patient_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS meal_cases_patient_candidate_idx
  ON meal_cases (patient_id, candidate_identity);

CREATE TABLE IF NOT EXISTS meal_case_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_case_id uuid NOT NULL REFERENCES meal_cases(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  fact_key text NOT NULL,
  fact_name text NOT NULL,
  value jsonb NOT NULL DEFAULT 'null'::jsonb,
  value_type text NOT NULL,
  knowledge_status text NOT NULL,
  evidence_origin text NOT NULL,
  source_type text NOT NULL,
  source_ref text NOT NULL,
  source_event_id uuid NULL REFERENCES events(id) ON DELETE SET NULL,
  source_question_id text NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_case_facts_unique UNIQUE (meal_case_id, fact_key, source_ref),
  CONSTRAINT meal_case_facts_knowledge_status_check CHECK (knowledge_status IN ('KNOWN', 'UNKNOWN', 'MISSING')),
  CONSTRAINT meal_case_facts_evidence_origin_check CHECK (evidence_origin IN ('OBSERVED', 'DERIVED'))
);

CREATE INDEX IF NOT EXISTS meal_case_facts_patient_idx
  ON meal_case_facts (patient_id, fact_key);

CREATE TABLE IF NOT EXISTS meal_case_hypotheses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_case_id uuid NOT NULL REFERENCES meal_cases(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  hypothesis_type text NOT NULL,
  status text NOT NULL,
  confidence text NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  alternatives jsonb NOT NULL DEFAULT '[]'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  algorithm_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_case_hypotheses_unique UNIQUE (meal_case_id, hypothesis_type, confidence),
  CONSTRAINT meal_case_hypotheses_status_check CHECK (status IN ('active', 'supported', 'weakened', 'rejected', 'superseded')),
  CONSTRAINT meal_case_hypotheses_confidence_check CHECK (confidence IN ('LOW', 'MODERATE', 'HIGH')),
  CONSTRAINT meal_case_hypotheses_algorithm_version_check CHECK (algorithm_version = 'meal-case.v1')
);

CREATE INDEX IF NOT EXISTS meal_case_hypotheses_patient_idx
  ON meal_case_hypotheses (patient_id, hypothesis_type);
