CREATE TABLE IF NOT EXISTS memories (
  memory_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  memory_identity text NOT NULL,
  memory_family text NOT NULL,
  semantic_version integer NOT NULL,
  status text NOT NULL,
  knowledge_status text NOT NULL,
  evidence_origin text NOT NULL,
  claim text NOT NULL DEFAULT '',
  normalized_claim text NOT NULL DEFAULT '',
  temporal_applicability text NOT NULL,
  temporal_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  therapy_compatibility text NOT NULL,
  therapy_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  algorithm_version text NOT NULL,
  policy_version text NOT NULL,
  supersedes_memory_id uuid NULL,
  last_reevaluation_run_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memories_unique_identity_version UNIQUE (patient_id, memory_identity, semantic_version),
  CONSTRAINT memories_id_patient_unique UNIQUE (memory_id, patient_id),
  CONSTRAINT memories_family_check CHECK (
    memory_family IN ('PATIENT_FACT', 'PATIENT_PREFERENCE', 'RECURRING_CONTEXT', 'CONFIRMED_BEHAVIOR')
  ),
  CONSTRAINT memories_status_check CHECK (
    status IN ('CANDIDATE', 'ACTIVE', 'UNCERTAIN', 'INVALIDATED', 'ARCHIVED')
  ),
  CONSTRAINT memories_knowledge_status_check CHECK (
    knowledge_status IN ('KNOWN', 'UNKNOWN', 'MISSING')
  ),
  CONSTRAINT memories_evidence_origin_check CHECK (
    evidence_origin IN ('OBSERVED', 'DERIVED')
  ),
  CONSTRAINT memories_temporal_applicability_check CHECK (
    temporal_applicability IN ('CURRENT', 'HISTORICAL', 'FUTURE_APPLICABLE', 'UNKNOWN')
  ),
  CONSTRAINT memories_therapy_compatibility_check CHECK (
    therapy_compatibility IN ('COMPATIBLE', 'DIFFERENT', 'UNKNOWN', 'NOT_APPLICABLE')
  ),
  CONSTRAINT memories_semantic_version_check CHECK (semantic_version >= 1),
  CONSTRAINT memories_supersedes_fk
    FOREIGN KEY (supersedes_memory_id, patient_id)
    REFERENCES memories(memory_id, patient_id)
    ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS memories_patient_status_idx
  ON memories (patient_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS memories_patient_family_idx
  ON memories (patient_id, memory_family, semantic_version DESC);

CREATE TABLE IF NOT EXISTS memory_candidates (
  candidate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  memory_family text NOT NULL,
  memory_identity text NOT NULL,
  normalized_claim text NOT NULL DEFAULT '',
  source_evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  contradiction_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy_version text NOT NULL,
  status text NOT NULL,
  promotion_reason text NOT NULL DEFAULT '',
  evaluation_run_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_candidates_unique UNIQUE (patient_id, memory_identity, normalized_claim, policy_version),
  CONSTRAINT memory_candidates_family_check CHECK (
    memory_family IN ('PATIENT_FACT', 'PATIENT_PREFERENCE', 'RECURRING_CONTEXT', 'CONFIRMED_BEHAVIOR')
  ),
  CONSTRAINT memory_candidates_status_check CHECK (
    status IN ('CREATED', 'SUPPORTED', 'CONTRADICTED', 'PROMOTED', 'REJECTED', 'INVALIDATED')
  )
);

CREATE INDEX IF NOT EXISTS memory_candidates_patient_status_idx
  ON memory_candidates (patient_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_evidence (
  memory_evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  memory_id uuid NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_patient_id uuid NOT NULL,
  source_version text NULL,
  relation_type text NOT NULL,
  evidence_summary text NOT NULL DEFAULT '',
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluated_at timestamptz NOT NULL,
  reevaluation_run_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_evidence_unique UNIQUE (memory_id, source_type, source_id, relation_type),
  CONSTRAINT memory_evidence_memory_patient_fk
    FOREIGN KEY (memory_id, patient_id)
    REFERENCES memories(memory_id, patient_id)
    ON DELETE CASCADE,
  CONSTRAINT memory_evidence_source_patient_fk
    FOREIGN KEY (source_patient_id)
    REFERENCES patients(id)
    ON DELETE CASCADE,
  CONSTRAINT memory_evidence_relation_type_check CHECK (
    relation_type IN ('SUPPORTING', 'CONTRADICTING', 'INVALIDATING')
  ),
  CONSTRAINT memory_evidence_source_patient_check CHECK (source_patient_id = patient_id)
);

CREATE INDEX IF NOT EXISTS memory_evidence_patient_idx
  ON memory_evidence (patient_id, memory_id, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS memory_contradictions (
  memory_contradiction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  memory_id uuid NOT NULL,
  contradicting_source_type text NOT NULL,
  contradicting_source_id text NOT NULL,
  contradicting_source_patient_id uuid NOT NULL,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_contradictions_unique UNIQUE (memory_id, contradicting_source_type, contradicting_source_id, reason),
  CONSTRAINT memory_contradictions_memory_patient_fk
    FOREIGN KEY (memory_id, patient_id)
    REFERENCES memories(memory_id, patient_id)
    ON DELETE CASCADE,
  CONSTRAINT memory_contradictions_source_patient_fk
    FOREIGN KEY (contradicting_source_patient_id)
    REFERENCES patients(id)
    ON DELETE CASCADE,
  CONSTRAINT memory_contradictions_status_check CHECK (
    status IN ('OPEN', 'RESOLVED', 'INVALIDATED')
  ),
  CONSTRAINT memory_contradictions_source_patient_check CHECK (contradicting_source_patient_id = patient_id)
);

CREATE INDEX IF NOT EXISTS memory_contradictions_patient_idx
  ON memory_contradictions (patient_id, memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_lifecycle_audit (
  memory_lifecycle_audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  memory_id uuid NOT NULL,
  previous_status text NOT NULL,
  new_status text NOT NULL,
  reason_code text NOT NULL,
  reason text NOT NULL,
  reevaluation_run_id uuid NOT NULL,
  algorithm_version text NOT NULL,
  policy_version text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_lifecycle_audit_memory_patient_fk
    FOREIGN KEY (memory_id, patient_id)
    REFERENCES memories(memory_id, patient_id)
    ON DELETE CASCADE,
  CONSTRAINT memory_lifecycle_audit_unique UNIQUE (memory_id, reevaluation_run_id),
  CONSTRAINT memory_lifecycle_audit_status_check CHECK (
    previous_status IN ('CANDIDATE', 'ACTIVE', 'UNCERTAIN', 'INVALIDATED', 'ARCHIVED')
    AND new_status IN ('CANDIDATE', 'ACTIVE', 'UNCERTAIN', 'INVALIDATED', 'ARCHIVED')
  )
);

CREATE INDEX IF NOT EXISTS memory_lifecycle_audit_patient_idx
  ON memory_lifecycle_audit (patient_id, memory_id, occurred_at DESC);
