ALTER TABLE meal_cases
  ADD CONSTRAINT meal_cases_id_patient_unique UNIQUE (id, patient_id);

CREATE TABLE IF NOT EXISTS patterns (
  pattern_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  pattern_identity text NOT NULL,
  pattern_family text NOT NULL,
  pattern_semantic_version integer NOT NULL,
  pattern_status text NOT NULL,
  normalized_condition_signature jsonb NOT NULL DEFAULT '{}'::jsonb,
  normalized_outcome_definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary text NOT NULL DEFAULT '',
  required_dimensions jsonb NOT NULL DEFAULT '[]'::jsonb,
  algorithm_version text NOT NULL,
  policy_version text NOT NULL,
  supersedes_pattern_id uuid NULL,
  superseded_by_pattern_id uuid NULL,
  last_reevaluation_run_id uuid NULL,
  support_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  counterexample_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  therapy_compatibility text NOT NULL,
  therapy_compatibility_policy_version text NOT NULL,
  temporal_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patterns_unique_identity_version UNIQUE (patient_id, pattern_identity, pattern_semantic_version),
  CONSTRAINT patterns_id_patient_unique UNIQUE (pattern_id, patient_id),
  CONSTRAINT patterns_family_check CHECK (
    pattern_family IN (
      'MEAL_GLUCOSE_OUTCOME',
      'MEAL_DELAYED_EXCURSION',
      'MEAL_ACTIVITY_INTERACTION',
      'MEAL_INSULIN_TIMING_RELATION'
    )
  ),
  CONSTRAINT patterns_status_check CHECK (pattern_status IN ('CANDIDATE', 'ACTIVE', 'WEAKENED', 'INVALIDATED', 'ARCHIVED')),
  CONSTRAINT patterns_semantic_version_check CHECK (pattern_semantic_version >= 1),
  CONSTRAINT patterns_therapy_compatibility_check CHECK (therapy_compatibility IN ('compatible', 'different', 'unknown')),
  CONSTRAINT patterns_supersedes_pattern_fk
    FOREIGN KEY (supersedes_pattern_id, patient_id)
    REFERENCES patterns(pattern_id, patient_id)
    ON DELETE NO ACTION,
  CONSTRAINT patterns_superseded_by_pattern_fk
    FOREIGN KEY (superseded_by_pattern_id, patient_id)
    REFERENCES patterns(pattern_id, patient_id)
    ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS patterns_patient_status_idx
  ON patterns (patient_id, pattern_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS patterns_patient_family_idx
  ON patterns (patient_id, pattern_family, pattern_semantic_version DESC);

CREATE TABLE IF NOT EXISTS pattern_cases (
  pattern_case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  pattern_id uuid NOT NULL,
  meal_case_id uuid NOT NULL,
  relation_type text NOT NULL,
  dimension_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome_id text NOT NULL,
  outcome_version text NOT NULL,
  outcome_state text NOT NULL,
  outcome_value text NULL,
  outcome_provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_version text NULL,
  evaluated_at timestamptz NOT NULL,
  algorithm_version text NOT NULL,
  policy_version text NOT NULL,
  reevaluation_run_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pattern_cases_unique_relation UNIQUE (pattern_id, meal_case_id, relation_type),
  CONSTRAINT pattern_cases_pattern_patient_fk
    FOREIGN KEY (pattern_id, patient_id)
    REFERENCES patterns(pattern_id, patient_id)
    ON DELETE CASCADE,
  CONSTRAINT pattern_cases_meal_case_patient_fk
    FOREIGN KEY (meal_case_id, patient_id)
    REFERENCES meal_cases(id, patient_id)
    ON DELETE CASCADE,
  CONSTRAINT pattern_cases_relation_type_check CHECK (relation_type IN ('SUPPORTING', 'COUNTEREXAMPLE')),
  CONSTRAINT pattern_cases_outcome_state_check CHECK (outcome_state IN ('KNOWN', 'UNKNOWN', 'MISSING', 'INSUFFICIENT_DATA'))
);

CREATE INDEX IF NOT EXISTS pattern_cases_patient_idx
  ON pattern_cases (patient_id, pattern_id, meal_case_id);

CREATE INDEX IF NOT EXISTS pattern_cases_pattern_idx
  ON pattern_cases (pattern_id, relation_type, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS pattern_lifecycle_audit (
  pattern_lifecycle_audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  pattern_id uuid NOT NULL,
  previous_status text NOT NULL,
  new_status text NOT NULL,
  reason_code text NOT NULL,
  reason text NOT NULL,
  reevaluation_run_id uuid NOT NULL,
  algorithm_version text NOT NULL,
  policy_version text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pattern_lifecycle_audit_pattern_patient_fk
    FOREIGN KEY (pattern_id, patient_id)
    REFERENCES patterns(pattern_id, patient_id)
    ON DELETE CASCADE,
  CONSTRAINT pattern_lifecycle_audit_unique UNIQUE (pattern_id, reevaluation_run_id),
  CONSTRAINT pattern_lifecycle_audit_status_check CHECK (
    previous_status IN ('CANDIDATE', 'ACTIVE', 'WEAKENED', 'INVALIDATED', 'ARCHIVED')
    AND new_status IN ('CANDIDATE', 'ACTIVE', 'WEAKENED', 'INVALIDATED', 'ARCHIVED')
  )
);

CREATE INDEX IF NOT EXISTS pattern_lifecycle_audit_patient_idx
  ON pattern_lifecycle_audit (patient_id, pattern_id, occurred_at DESC);