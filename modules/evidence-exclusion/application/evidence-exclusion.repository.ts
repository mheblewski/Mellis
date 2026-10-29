import type { PoolClient } from 'pg';
import type {
  EvidenceAuthoritativeEligibility,
  EvidenceExclusionRecord,
  EvidenceExclusionTargetKind,
} from '@modules/evidence-exclusion/domain/evidence-exclusion';

export interface EvidenceEligibilityResolution {
  patient_id: string;
  target_kind: EvidenceExclusionTargetKind;
  target_id: string;
  authoritative_eligibility: EvidenceAuthoritativeEligibility;
  active_exclusion_id: string | null;
}

export interface EvidenceTargetRef {
  target_kind: EvidenceExclusionTargetKind;
  target_id: string;
}

export interface EventSourceRecordLink {
  event_id: string;
  source_record_id: string;
}

export interface EvidenceExclusionRepository {
  withTransaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T>;
  assertTargetOwnedByPatient(args: { patient_id: string; target_kind: EvidenceExclusionTargetKind; target_id: string }, txClient?: PoolClient): Promise<void>;
  getByIdentity(args: { patient_id: string; exclusion_identity: string }, txClient?: PoolClient): Promise<EvidenceExclusionRecord | null>;
  getById(args: { patient_id: string; evidence_exclusion_id: string }, txClient?: PoolClient): Promise<EvidenceExclusionRecord | null>;
  resolveAuthoritativeEligibility(args: { patient_id: string; target_kind: EvidenceExclusionTargetKind; target_id: string }, txClient?: PoolClient): Promise<EvidenceEligibilityResolution>;
  listEventSourceRecordLinks(args: { patient_id: string; event_ids: string[] }, txClient?: PoolClient): Promise<EventSourceRecordLink[]>;
  listActiveExclusionTargets(args: { patient_id: string; targets: EvidenceTargetRef[] }, txClient?: PoolClient): Promise<EvidenceTargetRef[]>;
}
