-- What the caregiver was notified about, so a push dismissed by accident on the phone can still be opened from the
-- bell in the app. One row per logical notification (not per device): dedupe_key is the same for every device of the
-- patient. payload is the APNs "gluco" dictionary, which the app routes exactly like a tapped push.
CREATE TABLE IF NOT EXISTS notification_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,
  notification_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  payload jsonb NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_history_dedupe_unique UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS notification_history_patient_sent_idx
  ON notification_history (patient_id, sent_at DESC);
