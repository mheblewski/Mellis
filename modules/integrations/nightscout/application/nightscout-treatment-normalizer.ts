import { createHash } from 'crypto';
import { canonicalJson } from '@shared/utils/canonical-json';
import { NightscoutTreatmentDto } from './nightscout-client';

export type NightscoutTreatmentNormalizationVersion = 'nightscout.treatments.v1';
export type SupportedTreatmentEventType = 'CARB_ENTRY' | 'BOLUS' | 'SMB' | 'TEMP_BASAL';

export interface NormalizedNightscoutTreatment {
  source_system: 'NIGHTSCOUT';
  source_record_id: string;
  natural_key: string;
  record_type: 'TREATMENT';
  patient_id: string;
  occurred_at: string;
  recorded_at: string;
  imported_at: string;
  event_type: SupportedTreatmentEventType;
  normalization_version: NightscoutTreatmentNormalizationVersion;
  canonical_hash: string;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
  raw_payload: Record<string, unknown>;
}

export interface RejectedNightscoutTreatment {
  status: 'REJECTED';
  reason: string;
  source_record_id: string | null;
  natural_key: string;
  record_type: 'TREATMENT';
  patient_id: string;
  occurred_at: string | null;
  recorded_at: string;
  imported_at: string;
  normalization_version: NightscoutTreatmentNormalizationVersion;
  canonical_hash: string;
  provenance: Record<string, unknown>;
  raw_payload: Record<string, unknown>;
}

export type NormalizedNightscoutTreatmentResult =
  | { status: 'VALID'; treatment: NormalizedNightscoutTreatment }
  | RejectedNightscoutTreatment;

const NORMALIZATION_VERSION: NightscoutTreatmentNormalizationVersion = 'nightscout.treatments.v1';

export function normalizeNightscoutTreatment(
  treatment: NightscoutTreatmentDto,
  patientId: string,
  importedAt: string,
): NormalizedNightscoutTreatmentResult {
  const rawPayload = toPlainObject(treatment);
  const sourceRecordId = pickFirstString(treatment._id, treatment.id, treatment.eventId);
  const eventType = normalizeEventType(treatment);
  const occurredAt = parseNightscoutTimestamp(treatment.created_at ?? treatment.timestamp);
  const recordedAt = parseNightscoutTimestamp(treatment.created_at ?? treatment.timestamp) ?? importedAt;
  const provenance = {
    source_fields: {
      eventType: pickFirstString(treatment.eventType, treatment.eventtype, treatment.type),
      enteredBy: pickFirstString(treatment.enteredBy),
      utc_offset: treatment.utcOffset ?? null,
    },
    source_patient: pickFirstString(treatment.patient, treatment.patientId),
    source_record_id: sourceRecordId,
    normalization_version: NORMALIZATION_VERSION,
  };

  const payload = normalizePayloadByType(eventType, treatment);

  const canonicalHash = createHash('sha256').update(canonicalJson({
    source_system: 'NIGHTSCOUT',
    source_record_id: sourceRecordId,
    record_type: 'TREATMENT',
    patient_id: patientId,
    occurred_at: occurredAt,
    recorded_at: recordedAt,
    event_type: eventType,
    payload,
    provenance,
    raw_payload: rawPayload,
  })).digest('hex');

  const naturalKey = sourceRecordId
    ? `nightscout:treatment:${sourceRecordId}`
    : `nightscout:treatment:fallback:${canonicalHash}:${occurredAt ?? 'UNKNOWN'}`;

  const common = {
    source_record_id: sourceRecordId,
    natural_key: naturalKey,
    record_type: 'TREATMENT' as const,
    patient_id: patientId,
    recorded_at: recordedAt,
    imported_at: importedAt,
    normalization_version: NORMALIZATION_VERSION,
    canonical_hash: canonicalHash,
    provenance,
    raw_payload: rawPayload,
  };

  if (!sourceRecordId) {
    return {
      status: 'REJECTED',
      reason: 'missing_treatment_id',
      occurred_at: null,
      ...common,
    } as RejectedNightscoutTreatment;
  }

  if (!occurredAt) {
    return {
      status: 'REJECTED',
      reason: 'invalid_timestamp',
      occurred_at: null,
      ...common,
    } as RejectedNightscoutTreatment;
  }

  if (treatment.patient && String(treatment.patient) !== patientId) {
    return {
      status: 'REJECTED',
      reason: 'patient_mismatch',
      occurred_at: occurredAt,
      ...common,
    } as RejectedNightscoutTreatment;
  }

  if (!eventType) {
    return {
      status: 'REJECTED',
      reason: 'unsupported_event_type',
      occurred_at: occurredAt,
      ...common,
    } as RejectedNightscoutTreatment;
  }

  if (!payload) {
    return {
      status: 'REJECTED',
      reason: 'unsupported_payload',
      occurred_at: occurredAt,
      ...common,
    } as RejectedNightscoutTreatment;
  }

  return {
    status: 'VALID',
    treatment: {
      source_system: 'NIGHTSCOUT',
      source_record_id: sourceRecordId,
      natural_key: naturalKey,
      record_type: 'TREATMENT',
      patient_id: patientId,
      occurred_at: occurredAt,
      recorded_at: recordedAt,
      imported_at: importedAt,
      event_type: eventType,
      normalization_version: NORMALIZATION_VERSION,
      canonical_hash: canonicalHash,
      payload,
      provenance,
      raw_payload: rawPayload,
    },
  };
}

/**
 * Each uploader's treatment names in GlucoMind's four kinds. SMB is any bolus the loop gave by itself:
 * - Trio: "Bolus" (given by a person), "SMB", "Carb Correction", "Temp Basal".
 * - Loop: "Correction Bolus" for every bolus, `automatic: true` when Loop gave it; "Carb Correction"; "Temp Basal"
 *   (a pump suspend is a temp basal of 0 U/h with reason "suspend").
 * - AAPS and Nightscout Careportal: "Correction Bolus" / "Meal Bolus", AAPS marks its SMBs `isSMB: true`.
 * A Careportal "Meal Bolus" that also carries carbs keeps only its insulin here.
 */
const BOLUS_EVENT_TYPES = new Set(['bolus', 'correction bolus', 'meal bolus']);

function normalizeEventType(treatment: NightscoutTreatmentDto): SupportedTreatmentEventType | null {
  const raw = pickFirstString(treatment.eventType, treatment.eventtype, treatment.type);
  if (!raw) {
    return null;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'carb correction') {
    return 'CARB_ENTRY';
  }

  if (BOLUS_EVENT_TYPES.has(normalized)) {
    return treatment.automatic === true || treatment.isSMB === true ? 'SMB' : 'BOLUS';
  }

  if (normalized === 'smb') {
    return 'SMB';
  }

  if (normalized === 'temp basal') {
    return 'TEMP_BASAL';
  }

  return null;
}

function normalizePayloadByType(
  eventType: SupportedTreatmentEventType | null,
  treatment: NightscoutTreatmentDto,
): Record<string, unknown> | null {
  if (!eventType) {
    return null;
  }

  if (eventType === 'CARB_ENTRY') {
    const carbs = toFiniteNumber(treatment.carbs);
    if (carbs === null || carbs <= 0) {
      return null;
    }

    return {
      carbs,
      source_event_type: 'Carb Correction',
    };
  }

  if (eventType === 'BOLUS' || eventType === 'SMB') {
    const insulin = toFiniteNumber(treatment.insulin ?? treatment.enteredInsulin);
    if (insulin === null || insulin <= 0) {
      return null;
    }

    return {
      insulin_units: insulin,
      source_event_type: pickFirstString(treatment.eventType, treatment.eventtype, treatment.type)?.trim() ?? (eventType === 'BOLUS' ? 'Bolus' : 'SMB'),
    };
  }

  const rate = toFiniteNumber(treatment.rate);
  const absolute = toFiniteNumber(treatment.absolute);
  const duration = toFiniteNumber(treatment.duration);
  if (rate === null && absolute === null && duration === null) {
    return null;
  }

  return {
    rate,
    absolute,
    duration_minutes: duration,
    source_event_type: 'Temp Basal',
  };
}

function parseNightscoutTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function pickFirstString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return null;
}

function toPlainObject(value: NightscoutTreatmentDto): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  return null;
}
