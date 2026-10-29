import { createHash } from 'node:crypto';
import { canonicalJson } from '@shared/utils/canonical-json';

export type EvidenceExclusionTargetKind = 'EVENT' | 'SOURCE_RECORD';
export type EvidenceExclusionReasonCode = 'SENSOR_ERROR';
export type EvidenceExclusionReasonSubcode =
  | 'PRESSURE_ON_SENSOR'
  | 'SENSOR_WARMUP'
  | 'SENSOR_MALFUNCTION'
  | 'UNKNOWN_SENSOR_ERROR';
export type EvidenceExclusionLifecycleStatus = 'ACTIVE' | 'REVOKED';
export type EvidenceAuthoritativeEligibility = 'USABLE' | 'EXCLUDED';

export const EVIDENCE_EXCLUSION_TARGET_KINDS: EvidenceExclusionTargetKind[] = ['EVENT', 'SOURCE_RECORD'];
export const EVIDENCE_EXCLUSION_REASON_CODES: EvidenceExclusionReasonCode[] = ['SENSOR_ERROR'];
export const EVIDENCE_EXCLUSION_REASON_SUBCODES: EvidenceExclusionReasonSubcode[] = [
  'PRESSURE_ON_SENSOR',
  'SENSOR_WARMUP',
  'SENSOR_MALFUNCTION',
  'UNKNOWN_SENSOR_ERROR',
];

export interface EvidenceExclusionRecord {
  evidence_exclusion_id: string;
  patient_id: string;
  exclusion_identity: string;
  target_kind: EvidenceExclusionTargetKind;
  target_id: string;
  reason_code: EvidenceExclusionReasonCode;
  reason_subcode: EvidenceExclusionReasonSubcode | null;
  lifecycle_status: EvidenceExclusionLifecycleStatus;
  origin_type: string;
  origin_ref: string;
  actor_type: string;
  actor_id: string;
  provenance: Record<string, unknown>;
  revoked_at: string | null;
  revoked_by_actor_type: string | null;
  revoked_by_actor_id: string | null;
  revocation_reason: string;
  revocation_provenance: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export function isEvidenceExclusionTargetKind(value: string): value is EvidenceExclusionTargetKind {
  return EVIDENCE_EXCLUSION_TARGET_KINDS.includes(value as EvidenceExclusionTargetKind);
}

export function isEvidenceExclusionReasonCode(value: string): value is EvidenceExclusionReasonCode {
  return EVIDENCE_EXCLUSION_REASON_CODES.includes(value as EvidenceExclusionReasonCode);
}

export function isEvidenceExclusionReasonSubcode(value: string): value is EvidenceExclusionReasonSubcode {
  return EVIDENCE_EXCLUSION_REASON_SUBCODES.includes(value as EvidenceExclusionReasonSubcode);
}

export function buildEvidenceExclusionIdentity(input: {
  patient_id: string;
  target_kind: EvidenceExclusionTargetKind;
  target_id: string;
  reason_code: EvidenceExclusionReasonCode;
  reason_subcode?: EvidenceExclusionReasonSubcode | null;
  origin_type: string;
  origin_ref: string;
}): string {
  const payload = canonicalJson({
    identity_version: 'evidence-exclusion.v1',
    patient_id: input.patient_id,
    target_kind: input.target_kind,
    target_id: input.target_id,
    reason_code: input.reason_code,
    reason_subcode: input.reason_subcode ?? null,
    origin_type: input.origin_type,
    origin_ref: input.origin_ref,
  });

  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export interface EvidenceEligibilityMaterialItem {
  target_kind: EvidenceExclusionTargetKind;
  target_id: string;
  eligibility: EvidenceAuthoritativeEligibility;
}

export function buildEvidenceEligibilityMaterialHash(input: {
  patient_id: string;
  items: EvidenceEligibilityMaterialItem[];
}): string {
  const normalizedItems = input.items
    .map((item) => ({
      target_kind: item.target_kind,
      target_id: item.target_id,
      eligibility: item.eligibility,
    }))
    .sort((left, right) => {
      const leftKey = `${left.target_kind}:${left.target_id}:${left.eligibility}`;
      const rightKey = `${right.target_kind}:${right.target_id}:${right.eligibility}`;
      return leftKey.localeCompare(rightKey);
    });

  const payload = canonicalJson({
    material_version: 'evidence-eligibility.v1',
    patient_id: input.patient_id,
    items: normalizedItems,
  });

  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}
