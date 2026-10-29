import { createHash } from 'crypto';
import { canonicalJson } from '@shared/utils/canonical-json';
import { NightscoutEntryDto } from './nightscout-client';

export type NightscoutNormalizationVersion = 'nightscout.entries.v1';

export interface NormalizedGlucoseReading {
  source_system: 'NIGHTSCOUT';
  source_record_id: string | null;
  natural_key: string;
  record_type: 'CGM_ENTRY';
  patient_id: string;
  observed_at: string;
  recorded_at: string;
  imported_at: string;
  glucose_value: number;
  glucose_unit: 'mg/dL';
  source_unit: 'mg/dL' | 'mmol/L' | 'UNKNOWN';
  normalization_version: NightscoutNormalizationVersion;
  canonical_hash: string;
  provenance: Record<string, unknown>;
  raw_payload: Record<string, unknown>;
}

export interface RejectedNightscoutEntry {
  status: 'REJECTED';
  reason: string;
  source_record_id: string | null;
  natural_key: string;
  record_type: 'CGM_ENTRY';
  patient_id: string;
  observed_at: string | null;
  recorded_at: string;
  imported_at: string;
  normalization_version: NightscoutNormalizationVersion;
  canonical_hash: string;
  provenance: Record<string, unknown>;
  raw_payload: Record<string, unknown>;
}

export type NormalizedNightscoutEntry =
  | { status: 'VALID'; reading: NormalizedGlucoseReading }
  | RejectedNightscoutEntry;

const NORMALIZATION_VERSION: NightscoutNormalizationVersion = 'nightscout.entries.v1';

export function normalizeNightscoutEntry(entry: NightscoutEntryDto, patientId: string, importedAt: string): NormalizedNightscoutEntry {
  const rawPayload = toPlainObject(entry);
  // Only a real record id: enteredBy names the uploader (e.g. xDrip), shared by all its entries. Without an id the
  // natural key falls back to the record's content (canonical hash + time), unique per reading.
  const sourceRecordId = pickFirstString(entry._id, entry.id, entry.eventId) ?? null;
  const glucoseValue = parseGlucoseValue(entry);
  const observedAt = nightscoutEntryObservedAt(entry);
  const recordedAt = parseNightscoutTimestamp(entry.sysTime ?? entry.created_at ?? entry.dateString ?? entry.date) ?? importedAt;
  const unit = normalizeUnit(entry);
  const provenance = {
    source_fields: {
      device: pickFirstString(entry.device),
      direction: pickFirstString(entry.direction),
      type: pickFirstString(entry.type),
      utc_offset: pickFirstString(entry.utcOffset),
    },
    source_patient: pickFirstString(entry.patient, entry.patientId),
    source_record_id: sourceRecordId,
    source_unit: unit,
    normalization_version: NORMALIZATION_VERSION,
    unit_conversion: unit === 'mmol/L' ? 'mmol/L_to_mg/dL' : 'identity',
  };

  const canonicalHash = createHash('sha256').update(canonicalJson({
    source_system: 'NIGHTSCOUT',
    source_record_id: sourceRecordId,
    record_type: 'CGM_ENTRY',
    patient_id: patientId,
    observed_at: observedAt,
    recorded_at: recordedAt,
    glucose_value: glucoseValue,
    glucose_unit: 'mg/dL',
    source_unit: unit,
    provenance,
    raw_payload: rawPayload,
  })).digest('hex');

  const naturalKey = sourceRecordId ? `nightscout:${sourceRecordId}` : `nightscout:fallback:${canonicalHash}:${observedAt ?? 'UNKNOWN'}:CGM_ENTRY`;

  const common = {
    source_record_id: sourceRecordId,
    natural_key: naturalKey,
    record_type: 'CGM_ENTRY' as const,
    patient_id: patientId,
    recorded_at: recordedAt,
    imported_at: importedAt,
    normalization_version: NORMALIZATION_VERSION,
    canonical_hash: canonicalHash,
    provenance,
    raw_payload: rawPayload,
  };

  if (!observedAt) {
    return {
      status: 'REJECTED',
      reason: 'invalid_timestamp',
      observed_at: null,
      ...common,
    };
  }

  if (glucoseValue === null) {
    return {
      status: 'REJECTED',
      reason: 'invalid_glucose_value',
      observed_at: observedAt,
      ...common,
    };
  }

  if (entry.patient && String(entry.patient) !== patientId) {
    return {
      status: 'REJECTED',
      reason: 'patient_mismatch',
      observed_at: observedAt,
      ...common,
    };
  }

  return {
    status: 'VALID',
    reading: {
      source_system: 'NIGHTSCOUT',
      source_record_id: sourceRecordId,
      natural_key: naturalKey,
      record_type: 'CGM_ENTRY',
      patient_id: patientId,
      observed_at: observedAt,
      recorded_at: recordedAt,
      imported_at: importedAt,
      glucose_value: glucoseValue,
      glucose_unit: 'mg/dL',
      source_unit: unit,
      normalization_version: NORMALIZATION_VERSION,
      canonical_hash: canonicalHash,
      provenance,
      raw_payload: rawPayload,
    },
  };
}

function parseGlucoseValue(entry: NightscoutEntryDto): number | null {
  const candidate = entry.sgv ?? entry.glucose ?? entry.value;
  const parsed = typeof candidate === 'number' ? candidate : Number(candidate);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  // Below 39 mg/dL Nightscout carries the uploader's error codes (sensor not ready, no antenna...), not glucose; above
  // 600 no CGM measures. Imported, they would be an urgent low and an L2 hypo.
  const mgdl = normalizeToMgDl(parsed, normalizeUnit(entry));
  return mgdl < MIN_CGM_MGDL || mgdl > MAX_CGM_MGDL ? null : mgdl;
}

const MIN_CGM_MGDL = 39;
const MAX_CGM_MGDL = 600;

function normalizeToMgDl(value: number, unit: 'mg/dL' | 'mmol/L' | 'UNKNOWN'): number {
  if (unit === 'mmol/L') {
    return Math.round(value * 18.0182 * 10) / 10;
  }

  return Math.round(value * 10) / 10;
}

function normalizeUnit(entry: NightscoutEntryDto): 'mg/dL' | 'mmol/L' | 'UNKNOWN' {
  const candidate = pickFirstString(entry.units, entry.unit, entry.displayUnits);
  if (!candidate) {
    return 'UNKNOWN';
  }

  const normalized = candidate.toLowerCase();
  if (normalized.includes('mmol')) {
    return 'mmol/L';
  }

  if (normalized.includes('mg')) {
    return 'mg/dL';
  }

  return 'UNKNOWN';
}

/**
 * When a Nightscout entry was observed, as ISO, or null. The one reading of an entry's time for the normalizer and
 * the sync (page order, cursors, window bounds): `date` is epoch milliseconds, also as a numeric string.
 */
export function nightscoutEntryObservedAt(entry: NightscoutEntryDto): string | null {
  return parseNightscoutTimestamp(entry.dateString ?? entry.created_at ?? entry.sysTime ?? entry.date);
}

export function parseNightscoutTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return new Date(value).toISOString();
  }

  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^[0-9]+$/.test(value.trim())) {
      return new Date(numeric).toISOString();
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return null;
}

function pickFirstString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return null;
}

function toPlainObject(value: NightscoutEntryDto): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}