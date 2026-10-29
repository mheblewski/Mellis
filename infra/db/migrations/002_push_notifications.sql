CREATE TABLE patient_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  platform text NOT NULL,
  device_id text NOT NULL,
  push_token text NOT NULL,
  app_version text NULL,
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_devices_unique UNIQUE (patient_id, platform, device_id)
);

CREATE INDEX patient_devices_patient_platform_active_idx
  ON patient_devices (patient_id, platform, active, updated_at DESC);

CREATE TABLE push_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  question_id text NOT NULL,
  notification_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz NULL,
  last_error jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_notifications_dedupe_unique UNIQUE (dedupe_key)
);

CREATE INDEX push_notifications_patient_status_idx
  ON push_notifications (patient_id, status, created_at DESC);
