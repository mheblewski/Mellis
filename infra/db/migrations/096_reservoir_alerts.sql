-- Reservoir pushes (reservoir-alerts.v1, owner 2026-10-29): "Insuliny w zbiorniku zostało na ok. 8 godz." once when
-- the reservoir first turns yellow (under 24 h of insulin at the patient's average use) and once when it turns red
-- (under 8 h), not again until the reservoir is refilled.
--
-- patient_devices.reservoir_push_enabled: the switch "Zbiornik insuliny" in the phone's notification settings. On by
-- default (owner decision): a phone gets the push unless its caregiver turned it off.
-- reservoir_alert_states: one row per patient, what was already pushed for the current fill. notified_level is the
-- highest level pushed since the last refill (NULL: none); a refill (a newer "Insulin Change" than the push, or the
-- reservoir rising by 10 U or more over last_units) clears it. revision makes the claim before a push one worker's
-- (compare and set), so a restart or a second worker never pushes the same level twice.

ALTER TABLE patient_devices ADD COLUMN IF NOT EXISTS reservoir_push_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS reservoir_alert_states (
  patient_id uuid PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  notified_level text NULL,
  notified_at timestamptz NULL,
  notified_units numeric(6, 2) NULL,
  notified_hours_left numeric(6, 1) NULL,
  last_units numeric(6, 2) NULL,
  reservoir_changed_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservoir_alert_states_level_check CHECK (notified_level IS NULL OR notified_level IN ('warning', 'alarm'))
);
