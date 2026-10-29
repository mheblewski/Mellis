-- Self-hosted Mellis, step 2 (docs/product/device-auth-api.md §8): an owner hands their loop remote-command settings
-- (Trio: Shared Secret + APNs key; Loop: the QR code's otpauth URL + APNs key; the answer key; the limits) to another
-- person's phone, so that person types nothing. The owner's phone encrypts the package to each of the recipient's
-- phones separately (ECIES to that phone's P-256 key) and signs it with its device key; the server keeps only the
-- ciphertext and the signature, never anything readable, and never logs them.
--  * recipient_key: which key of the target device the package is encrypted to ('bolus' = Face ID bound bolus key,
--    'device' = the device key, only while the phone has no bolus key yet).
--  * Single use: fetching marks consumed_at and drops the ciphertext and signature at once (the row stays as a receipt
--    for the owner until it expires). Expired rows are deleted (7 days).
CREATE TABLE IF NOT EXISTS remote_settings_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  to_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  loop_kind text NOT NULL CHECK (loop_kind IN ('trio', 'loop')),
  recipient_key text NOT NULL CHECK (recipient_key IN ('bolus', 'device')),
  ciphertext bytea NULL,
  sender_signature text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  CONSTRAINT remote_settings_handoffs_payload_check CHECK ((consumed_at IS NULL) = (ciphertext IS NOT NULL AND sender_signature IS NOT NULL)),
  CONSTRAINT remote_settings_handoffs_not_to_self CHECK (from_device_id <> to_device_id)
);

CREATE INDEX IF NOT EXISTS remote_settings_handoffs_to_device_idx ON remote_settings_handoffs (to_device_id) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS remote_settings_handoffs_patient_idx ON remote_settings_handoffs (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS remote_settings_handoffs_expires_idx ON remote_settings_handoffs (expires_at);
