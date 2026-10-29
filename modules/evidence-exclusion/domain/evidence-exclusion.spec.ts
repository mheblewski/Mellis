import { describe, expect, it } from 'vitest';
import { buildEvidenceEligibilityMaterialHash } from './evidence-exclusion';

describe('Evidence Exclusion dependency material', () => {
  it('is deterministic for same eligibility set regardless of input order', () => {
    const first = buildEvidenceEligibilityMaterialHash({
      patient_id: 'patient-1',
      items: [
        { target_kind: 'EVENT', target_id: 'event-2', eligibility: 'USABLE' },
        { target_kind: 'SOURCE_RECORD', target_id: 'src-1', eligibility: 'EXCLUDED' },
      ],
    });

    const second = buildEvidenceEligibilityMaterialHash({
      patient_id: 'patient-1',
      items: [
        { target_kind: 'SOURCE_RECORD', target_id: 'src-1', eligibility: 'EXCLUDED' },
        { target_kind: 'EVENT', target_id: 'event-2', eligibility: 'USABLE' },
      ],
    });

    expect(first).toBe(second);
  });

  it('changes hash when authoritative eligibility changes', () => {
    const usable = buildEvidenceEligibilityMaterialHash({
      patient_id: 'patient-1',
      items: [
        { target_kind: 'EVENT', target_id: 'event-2', eligibility: 'USABLE' },
      ],
    });

    const excluded = buildEvidenceEligibilityMaterialHash({
      patient_id: 'patient-1',
      items: [
        { target_kind: 'EVENT', target_id: 'event-2', eligibility: 'EXCLUDED' },
      ],
    });

    expect(excluded).not.toBe(usable);
  });
});
