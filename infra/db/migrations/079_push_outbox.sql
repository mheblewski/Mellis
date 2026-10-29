-- Reminder pushes that must reach the caregiver (push-outbox.v1, audit 2026-10-26): a WBT reminder, a later bolus part,
-- a chat or Bolus tab reminder and "dawka podana" are marked sent before their push goes out, so a push that failed for
-- a passing reason (APNs 5xx, a timeout, no phone registered at that minute) was lost for good. The outbox keeps the
-- push (the PushNotificationService request without the device token) and tries again per phone until every phone has
-- it or it expires.
CREATE TABLE IF NOT EXISTS push_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  notification_type text NOT NULL,
  request jsonb NOT NULL,
  exclude_user_id uuid NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  last_error_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_outbox_dedupe_unique UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS push_outbox_due_idx ON push_outbox (next_attempt_at) WHERE completed_at IS NULL;

-- The phones a queued push reached: a retry sends only to the others.
CREATE TABLE IF NOT EXISTS push_outbox_deliveries (
  outbox_id uuid NOT NULL REFERENCES push_outbox(id) ON DELETE CASCADE,
  push_token text NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outbox_id, push_token)
);
