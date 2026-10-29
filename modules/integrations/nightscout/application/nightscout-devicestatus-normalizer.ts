import { createHash } from 'crypto';
import { canonicalJson } from '@shared/utils/canonical-json';
import { readLoopValues } from '@modules/loop-system/application/loop-status';
import { NightscoutDeviceStatusDto } from './nightscout-client';

export type NightscoutDeviceStatusNormalizationVersion = 'nightscout.devicestatus.v1';

export interface NormalizedNightscoutDeviceStatusSnapshot {
  source_system: 'NIGHTSCOUT';
  source_record_id: string | null;
  natural_key: string;
  record_type: 'DEVICE_STATUS';
  patient_id: string;
  observed_at: string;
  recorded_at: string;
  imported_at: string;
  iob: number | null;
  cob: number | null;
  normalization_version: NightscoutDeviceStatusNormalizationVersion;
  canonical_hash: string;
  provenance: Record<string, unknown>;
  raw_payload: Record<string, unknown>;
}

export type NormalizedNightscoutDeviceStatus =
  | { status: 'VALID'; statusSnapshot: NormalizedNightscoutDeviceStatusSnapshot }
  | { status: 'REJECTED'; reason: 'invalid_timestamp' | 'patient_mismatch'; source_record_id: string | null; natural_key: string; record_type: 'DEVICE_STATUS'; patient_id: string; observed_at: string | null; recorded_at: string; imported_at: string; normalization_version: NightscoutDeviceStatusNormalizationVersion; canonical_hash: string; provenance: Record<string, unknown>; raw_payload: Record<string, unknown>; };

const NORMALIZATION_VERSION: NightscoutDeviceStatusNormalizationVersion = 'nightscout.devicestatus.v1';

export function mapNightscoutTrendDirection(value: unknown): 'UP' | 'DOWN' | 'FLAT' | 'DOUBLE_UP' | 'DOUBLE_DOWN' | 'UNKNOWN' {
  switch (normalizeDirectionToken(value)) {
    case 'doubleup':
      return 'DOUBLE_UP';
    case 'singleup':
    case 'fortyfiveup':
    case 'up':
      return 'UP';
    case 'flat':
    case 'none':
      return 'FLAT';
    case 'fortyfivedown':
    case 'singledown':
    case 'down':
      return 'DOWN';
    case 'doubledown':
      return 'DOUBLE_DOWN';
    default:
      return 'UNKNOWN';
  }
}

export function normalizeNightscoutDeviceStatus(
  deviceStatus: NightscoutDeviceStatusDto,
  patientId: string,
  importedAt: string,
): NormalizedNightscoutDeviceStatus {
  const rawPayload = toPlainObject(deviceStatus);
  const sourceRecordId = pickFirstString(deviceStatus._id, deviceStatus.id, deviceStatus.eventId) ?? null;
  const observedAt = parseNightscoutTimestamp(deviceStatus.created_at ?? deviceStatus.timestamp ?? deviceStatus.dateString ?? deviceStatus.sysTime ?? deviceStatus.date);
  const recordedAt = observedAt ?? importedAt;

  const { iob_u: iob, cob_g: cob } = readLoopValues(rawPayload);

  const provenance = {
    source_fields: {
      device: pickFirstString(deviceStatus.device),
      created_at: pickFirstString(deviceStatus.created_at, deviceStatus.timestamp),
      source_patient: pickFirstString(deviceStatus.patient, deviceStatus.patientId),
      openaps_keys: {
        iob_present: iob !== null,
        cob_present: cob !== null,
      },
    },
    source_patient: pickFirstString(deviceStatus.patient, deviceStatus.patientId),
    source_record_id: sourceRecordId,
    normalization_version: NORMALIZATION_VERSION,
  };

  const canonicalHash = createHash('sha256').update(canonicalJson({
    source_system: 'NIGHTSCOUT',
    source_record_id: sourceRecordId,
    record_type: 'DEVICE_STATUS',
    patient_id: patientId,
    observed_at: observedAt,
    recorded_at: recordedAt,
    iob,
    cob,
    provenance,
    raw_payload: rawPayload,
  })).digest('hex');

  const naturalKey = sourceRecordId
    ? `nightscout:devicestatus:${sourceRecordId}`
    : `nightscout:devicestatus:fallback:${canonicalHash}:${observedAt ?? 'UNKNOWN'}`;

  const common = {
    source_record_id: sourceRecordId,
    natural_key: naturalKey,
    record_type: 'DEVICE_STATUS' as const,
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

  const sourcePatient = pickFirstString(deviceStatus.patient, deviceStatus.patientId);
  if (sourcePatient && sourcePatient !== patientId) {
    return {
      status: 'REJECTED',
      reason: 'patient_mismatch',
      observed_at: observedAt,
      ...common,
    };
  }

  return {
    status: 'VALID',
    statusSnapshot: {
      source_system: 'NIGHTSCOUT',
      source_record_id: sourceRecordId,
      natural_key: naturalKey,
      record_type: 'DEVICE_STATUS',
      patient_id: patientId,
      observed_at: observedAt,
      recorded_at: recordedAt,
      imported_at: importedAt,
      iob,
      cob,
      normalization_version: NORMALIZATION_VERSION,
      canonical_hash: canonicalHash,
      provenance,
      raw_payload: rawPayload,
    },
  };
}

function normalizeDirectionToken(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().replace(/\s+/g, '').toLowerCase();
}

function parseNightscoutTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return new Date(value).toISOString();
  }

  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') {
      const asDate = new Date(numeric);
      if (!Number.isNaN(asDate.getTime())) {
        return asDate.toISOString();
      }
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

function toPlainObject(value: NightscoutDeviceStatusDto): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

