-- Glucose pushes (glucose-alerts.v1, owner 2026-11-02): "Powiadomienia o glikemii" in the phone's notification settings.
-- Low (< 70), falling under 80, rising over 160 / 180 / 250, very fast changes (two arrows) and no readings for 10 min.
--
-- patient_devices.glucose_alerts_enabled: the section's main switch, off by default (owner decision): a phone gets no
-- glucose push until its caregiver turns it on. glucose_alert_kinds_off: the kinds turned off inside the section
-- (low, falling, rising, high, very_high, fast, no_data); empty = all on. glucose_alert_low_repeat_minutes and
-- glucose_alert_repeat_minutes: "Powtarzaj co" for a low and for the other kinds (5, 10, 15, 20, 30 or 60 minutes).
-- glucose_alert_states: one row per patient. last_reading_at is the newest reading already judged (a reading is judged
-- once); sent maps each phone (push token) to when each kind was last pushed to it; no_data_sent_at is the last "Brak
-- danych" push. revision makes the claim before a push one worker's (compare and set).
--
-- Pump battery pushes (battery-alerts.v1, owner 2026-11-02), in "Powiadomienia o sprzęcie" next to the reservoir: once
-- under 25% and once under 15%, not again until the battery is charged or replaced (a rise of 10 points or more).
-- patient_devices.battery_push_enabled: the switch "Bateria pompy", on by default like "Zbiornik insuliny".
-- battery_alert_states: one row per patient, the highest level pushed since the last charge and the lowest percent seen
-- since (the base for "charged").

ALTER TABLE patient_devices ADD COLUMN IF NOT EXISTS glucose_alerts_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE patient_devices ADD COLUMN IF NOT EXISTS glucose_alert_kinds_off text[] NOT NULL DEFAULT '{}';
ALTER TABLE patient_devices ADD COLUMN IF NOT EXISTS glucose_alert_low_repeat_minutes integer NOT NULL DEFAULT 15
  CONSTRAINT patient_devices_glucose_alert_low_repeat_check CHECK (glucose_alert_low_repeat_minutes IN (5, 10, 15, 20, 30, 60));
ALTER TABLE patient_devices ADD COLUMN IF NOT EXISTS glucose_alert_repeat_minutes integer NOT NULL DEFAULT 30
  CONSTRAINT patient_devices_glucose_alert_repeat_check CHECK (glucose_alert_repeat_minutes IN (5, 10, 15, 20, 30, 60));

CREATE TABLE IF NOT EXISTS glucose_alert_states (
  patient_id uuid PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  last_reading_at timestamptz NULL,
  sent jsonb NOT NULL DEFAULT '{}'::jsonb,
  no_data_sent_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE patient_devices ADD COLUMN IF NOT EXISTS battery_push_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS battery_alert_states (
  patient_id uuid PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  notified_level text NULL,
  notified_at timestamptz NULL,
  last_percent numeric(5, 1) NULL,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT battery_alert_states_level_check CHECK (notified_level IS NULL OR notified_level IN ('warning', 'critical'))
);
