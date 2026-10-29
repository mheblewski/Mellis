-- Trio / Nightscout treatments that are not insulin or carbs but explain them (owner decision 2026-10-26): temporary
-- targets and overrides (exercise), profile switches, site, sensor and reservoir changes, pump suspend / resume, notes.
-- The import used to reject them as unsupported; now they are kept here, apart from events, so no insulin or meal
-- reader sees them. The AI reads them (therapy-now.v1 and the period analyses). One row per Nightscout treatment.

CREATE TABLE IF NOT EXISTS therapy_context_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  source_record_id text NOT NULL,
  -- TEMP_TARGET, OVERRIDE, EXERCISE, PROFILE_SWITCH, SITE_CHANGE, SENSOR_CHANGE, RESERVOIR_CHANGE, PUMP_SUSPEND,
  -- PUMP_RESUME, NOTE
  kind text NOT NULL,
  -- Nightscout's eventType as uploaded.
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  duration_minutes numeric(8, 2) NULL,
  -- Only the fields that describe the event (targets, reason, profile, percentage, notes cut to 300 characters).
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT therapy_context_events_kind_check CHECK (kind IN ('TEMP_TARGET', 'OVERRIDE', 'EXERCISE', 'PROFILE_SWITCH', 'SITE_CHANGE', 'SENSOR_CHANGE', 'RESERVOIR_CHANGE', 'PUMP_SUSPEND', 'PUMP_RESUME', 'NOTE')),
  CONSTRAINT therapy_context_events_unique UNIQUE (patient_id, source_record_id)
);

CREATE INDEX IF NOT EXISTS therapy_context_events_patient_time_idx ON therapy_context_events (patient_id, occurred_at DESC);
