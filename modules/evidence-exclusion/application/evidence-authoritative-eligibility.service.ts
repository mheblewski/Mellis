import type { PoolClient } from 'pg';
import type {
  EvidenceEligibilityResolution,
  EvidenceExclusionRepository,
  EvidenceTargetRef,
} from './evidence-exclusion.repository';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AuthoritativeEvidenceEligibilityInput {
  patient_id: string;
  event_ids?: string[];
  source_record_ids?: string[];
}

export interface AuthoritativeEvidenceEligibilityResult {
  patient_id: string;
  resolutions: EvidenceEligibilityResolution[];
  excluded_event_ids: string[];
  excluded_source_record_ids: string[];
}

export class EvidenceAuthoritativeEligibilityService {
  constructor(private readonly repository: EvidenceExclusionRepository) {}

  async resolve(input: AuthoritativeEvidenceEligibilityInput, txClient?: PoolClient): Promise<AuthoritativeEvidenceEligibilityResult> {
    const eventIds = dedupeUuids(input.event_ids ?? []);
    const directSourceRecordIds = dedupeUuids(input.source_record_ids ?? []);

    const eventSourceLinks = eventIds.length > 0
      ? await this.repository.listEventSourceRecordLinks({ patient_id: input.patient_id, event_ids: eventIds }, txClient)
      : [];

    const linkedSourceRecordIds = dedupeUuids(eventSourceLinks.map((item) => item.source_record_id));
    const allSourceRecordIds = dedupeUuids([...directSourceRecordIds, ...linkedSourceRecordIds]);

    const targets: EvidenceTargetRef[] = [
      ...eventIds.map((target_id) => ({ target_kind: 'EVENT' as const, target_id })),
      ...allSourceRecordIds.map((target_id) => ({ target_kind: 'SOURCE_RECORD' as const, target_id })),
    ];

    if (targets.length === 0) {
      return {
        patient_id: input.patient_id,
        resolutions: [],
        excluded_event_ids: [],
        excluded_source_record_ids: [],
      };
    }

    const activeExcludedTargets = await this.repository.listActiveExclusionTargets({
      patient_id: input.patient_id,
      targets,
    }, txClient);

    const excludedEvents = new Set<string>();
    const excludedSourceRecords = new Set<string>();

    for (const target of activeExcludedTargets) {
      if (target.target_kind === 'EVENT') {
        excludedEvents.add(target.target_id);
      } else {
        excludedSourceRecords.add(target.target_id);
      }
    }

    for (const link of eventSourceLinks) {
      if (excludedSourceRecords.has(link.source_record_id)) {
        excludedEvents.add(link.event_id);
      }
    }

    const resolutions: EvidenceEligibilityResolution[] = [
      ...eventIds.map((eventId) => {
        const authoritativeEligibility: EvidenceEligibilityResolution['authoritative_eligibility'] = excludedEvents.has(eventId) ? 'EXCLUDED' : 'USABLE';
        return {
          patient_id: input.patient_id,
          target_kind: 'EVENT' as const,
          target_id: eventId,
          authoritative_eligibility: authoritativeEligibility,
          active_exclusion_id: null,
        };
      }),
      ...allSourceRecordIds.map((sourceRecordId) => {
        const authoritativeEligibility: EvidenceEligibilityResolution['authoritative_eligibility'] = excludedSourceRecords.has(sourceRecordId) ? 'EXCLUDED' : 'USABLE';
        return {
          patient_id: input.patient_id,
          target_kind: 'SOURCE_RECORD' as const,
          target_id: sourceRecordId,
          authoritative_eligibility: authoritativeEligibility,
          active_exclusion_id: null,
        };
      }),
    ];

    return {
      patient_id: input.patient_id,
      resolutions,
      excluded_event_ids: [...excludedEvents].sort(),
      excluded_source_record_ids: [...excludedSourceRecords].sort(),
    };
  }
}

function dedupeUuids(input: string[]): string[] {
  const seen = new Set<string>();

  for (const value of input) {
    if (typeof value !== 'string') {
      continue;
    }

    const normalized = value.trim();
    if (!UUID_REGEX.test(normalized)) {
      continue;
    }

    seen.add(normalized.toLowerCase());
  }

  return [...seen].sort();
}
