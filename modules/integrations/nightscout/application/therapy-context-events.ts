/**
 * Nightscout treatments that explain insulin and glucose without being insulin or carbs (therapy-context-events.v1):
 * temporary targets and overrides, exercise, profile switches, site / sensor / reservoir changes, pump suspend and
 * resume, notes. Names as Nightscout's careportal, Trio, Loop and AAPS upload them. Only describing fields are kept.
 */

import type { NightscoutTreatmentDto } from './nightscout-client';

export const THERAPY_CONTEXT_EVENTS_VERSION = 'therapy-context-events.v1';

export type TherapyContextKind =
  | 'TEMP_TARGET' | 'OVERRIDE' | 'EXERCISE' | 'PROFILE_SWITCH' | 'SITE_CHANGE' | 'SENSOR_CHANGE' | 'RESERVOIR_CHANGE'
  | 'PUMP_SUSPEND' | 'PUMP_RESUME' | 'NOTE';

const KINDS: Record<string, TherapyContextKind> = {
  'temporary target': 'TEMP_TARGET',
  'temp target': 'TEMP_TARGET',
  'temporary override': 'OVERRIDE',
  override: 'OVERRIDE',
  exercise: 'EXERCISE',
  'profile switch': 'PROFILE_SWITCH',
  'site change': 'SITE_CHANGE',
  'cannula change': 'SITE_CHANGE',
  'pump site change': 'SITE_CHANGE',
  'sensor start': 'SENSOR_CHANGE',
  'sensor change': 'SENSOR_CHANGE',
  'insulin change': 'RESERVOIR_CHANGE',
  'reservoir change': 'RESERVOIR_CHANGE',
  'suspend pump': 'PUMP_SUSPEND',
  'pump suspend': 'PUMP_SUSPEND',
  'resume pump': 'PUMP_RESUME',
  'pump resume': 'PUMP_RESUME',
  note: 'NOTE',
  announcement: 'NOTE',
};

export interface TherapyContextEvent {
  source_record_id: string;
  kind: TherapyContextKind;
  event_type: string;
  occurred_at: string;
  duration_minutes: number | null;
  details: Record<string, unknown>;
}

/** The context event of a treatment, or null when it is none (or has no id or time). */
export function toTherapyContextEvent(treatment: NightscoutTreatmentDto): TherapyContextEvent | null {
  const eventType = [treatment.eventType, treatment.eventtype, treatment.type].find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
  if (!eventType) return null;
  const kind = KINDS[eventType.toLowerCase()];
  if (!kind) return null;
  const id = [treatment._id, treatment.id, treatment.eventId].find((value): value is string => typeof value === 'string' && value.length > 0);
  const at = Date.parse(String(treatment.created_at ?? treatment.timestamp ?? ''));
  if (!id || !Number.isFinite(at)) return null;
  const number = (value: unknown) => {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  const details = Object.fromEntries(Object.entries({
    target_top: number(treatment.targetTop),
    target_bottom: number(treatment.targetBottom),
    units: text(treatment.units, 10),
    reason: text(treatment.reason, 120),
    profile: text(treatment.profile, 80),
    percentage: number(treatment.percentage),
    insulin_needs_scale: number(treatment.insulinNeedsScaleFactor),
    ...noteFields(treatment.notes),
  }).filter(([, value]) => value !== null));
  const duration = number(treatment.duration);
  return {
    source_record_id: id,
    kind,
    event_type: eventType.slice(0, 60),
    occurred_at: new Date(at).toISOString(),
    duration_minutes: duration !== null && duration >= 0 ? Math.min(duration, 100_000) : null,
    details,
  };
}

/**
 * A note's text (at most 300 characters). Loop writes a refused remote command as its error, a line break and the
 * command's JSON: only the error is kept, with the command's `remote-address` (who sent it), so a long one-time payload
 * never reaches the model.
 */
function noteFields(value: unknown): { notes: string | null; remote_address: string | null } {
  if (typeof value !== 'string' || !value.trim()) return { notes: null, remote_address: null };
  const text = value.trim();
  const jsonStart = text.indexOf('\n{');
  if (jsonStart > 0) {
    const address = /"remote-address"\s*:\s*"([^"]{1,120})"/.exec(text.slice(jsonStart))?.[1] ?? null;
    return { notes: text.slice(0, jsonStart).trim().slice(0, 300) || null, remote_address: address };
  }
  return { notes: text.slice(0, 300), remote_address: null };
}
