-- The glucose Live Activity (lock screen and Dynamic Island), on while its switch in a phone's settings is on: one row
-- per phone. The server keeps it current with a push for every new reading and starts a new one before iOS ends the
-- old (8 h) with the phone's push-to-start token. A phone signed out of the patient (no active patient_devices row) is
-- skipped.
CREATE TABLE live_activity_subscriptions (
  device_id text PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  -- "Dynamic Island": off leaves the island empty (iOS keeps a running activity there; it only draws nothing).
  island_enabled boolean NOT NULL DEFAULT true,
  -- ActivityKit's push-to-start token (iOS 17.2+): starts a new activity without the app.
  start_token text NULL,
  -- The running activity and its update token; cleared when the server starts a new one.
  activity_id text NULL,
  update_token text NULL,
  activity_started_at timestamptz NULL,
  -- A start sent and not yet answered with an update token: no second start until it is old.
  start_requested_at timestamptz NULL,
  -- The reading the activity shows (the newest pushed) and when the last push went out.
  last_reading_at timestamptz NULL,
  last_push_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX live_activity_subscriptions_enabled_idx ON live_activity_subscriptions (enabled, patient_id);
