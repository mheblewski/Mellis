-- quiet-hours.v1 (docs-site: Powiadomienia → Godziny ciszy). "Godziny ciszy" belong to the phone, for every patient on
-- it: keyed by the app's device id, found from a push through patient_devices.push_token; minutes after local midnight in
-- the phone's own time zone. Equipment and information pushes that fall in them wait in quiet_held_pushes until they end
-- (one waiting row per phone, patient and item); the check before them runs once per local date per phone. Additive and
-- idempotent (the family build created the same tables as 925/926). Nothing here changes the loop or a dose.
CREATE TABLE IF NOT EXISTS device_quiet_hours (
  platform text NOT NULL DEFAULT 'ios',
  device_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  start_minute smallint NOT NULL DEFAULT 1320 CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL DEFAULT 420 CHECK (end_minute BETWEEN 0 AND 1439),
  time_zone text NOT NULL DEFAULT 'Europe/Warsaw',
  low_warnings boolean NOT NULL DEFAULT true,
  updated_by uuid NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, device_id)
);
CREATE TABLE IF NOT EXISTS quiet_held_pushes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  push_token text NOT NULL,
  patient_id uuid NOT NULL,
  item_key text NOT NULL,
  notification_type text NOT NULL,
  envelope jsonb NOT NULL,
  held_at timestamptz NOT NULL DEFAULT now(),
  release_after timestamptz NOT NULL,
  released_at timestamptz NULL,
  outcome text NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS quiet_held_pushes_waiting_key ON quiet_held_pushes (push_token, patient_id, item_key) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS quiet_held_pushes_waiting ON quiet_held_pushes (release_after) WHERE released_at IS NULL;
ALTER TABLE device_quiet_hours ADD COLUMN IF NOT EXISTS pre_checked_on date NULL;
