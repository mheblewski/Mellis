CREATE TABLE IF NOT EXISTS evidence_exclusions (
  evidence_exclusion_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  exclusion_identity text NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  reason_code text NOT NULL,
  reason_subcode text NULL,
  lifecycle_status text NOT NULL,
  origin_type text NOT NULL,
  origin_ref text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  revoked_at timestamptz NULL,
  revoked_by_actor_type text NULL,
  revoked_by_actor_id text NULL,
  revocation_reason text NOT NULL DEFAULT '',
  revocation_provenance jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_exclusions_unique_identity UNIQUE (patient_id, exclusion_identity),
  CONSTRAINT evidence_exclusions_id_patient_unique UNIQUE (evidence_exclusion_id, patient_id),
  CONSTRAINT evidence_exclusions_target_kind_check CHECK (target_kind IN ('EVENT', 'SOURCE_RECORD')),
  CONSTRAINT evidence_exclusions_reason_code_check CHECK (reason_code IN ('SENSOR_ERROR')),
  CONSTRAINT evidence_exclusions_reason_subcode_check CHECK (
    reason_subcode IS NULL OR reason_subcode IN ('PRESSURE_ON_SENSOR', 'SENSOR_WARMUP', 'SENSOR_MALFUNCTION', 'UNKNOWN_SENSOR_ERROR')
  ),
  CONSTRAINT evidence_exclusions_lifecycle_status_check CHECK (lifecycle_status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT evidence_exclusions_revocation_state_check CHECK (
    (lifecycle_status = 'ACTIVE' AND revoked_at IS NULL AND revoked_by_actor_type IS NULL AND revoked_by_actor_id IS NULL)
    OR (lifecycle_status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_by_actor_type IS NOT NULL AND revoked_by_actor_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS evidence_exclusions_patient_target_idx
  ON evidence_exclusions (patient_id, target_kind, target_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS evidence_exclusions_patient_active_idx
  ON evidence_exclusions (patient_id, lifecycle_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS evidence_exclusion_lifecycle_audit (
  evidence_exclusion_lifecycle_audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  evidence_exclusion_id uuid NOT NULL,
  previous_status text NOT NULL,
  new_status text NOT NULL,
  action text NOT NULL,
  reason_code text NOT NULL,
  reason text NOT NULL DEFAULT '',
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  origin_type text NULL,
  origin_ref text NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_exclusion_lifecycle_audit_exclusion_patient_fk
    FOREIGN KEY (evidence_exclusion_id, patient_id)
    REFERENCES evidence_exclusions(evidence_exclusion_id, patient_id)
    ON DELETE CASCADE,
  CONSTRAINT evidence_exclusion_lifecycle_audit_status_check CHECK (
    previous_status IN ('ACTIVE', 'REVOKED')
    AND new_status IN ('ACTIVE', 'REVOKED')
  ),
  CONSTRAINT evidence_exclusion_lifecycle_audit_action_check CHECK (
    action IN ('CREATED', 'REACTIVATED', 'REVOKED')
  ),
  CONSTRAINT evidence_exclusion_lifecycle_audit_reason_code_check CHECK (
    reason_code IN ('SENSOR_ERROR', 'USER_REQUESTED_REVOCATION')
  )
);

CREATE INDEX IF NOT EXISTS evidence_exclusion_lifecycle_audit_patient_idx
  ON evidence_exclusion_lifecycle_audit (patient_id, evidence_exclusion_id, occurred_at DESC);
