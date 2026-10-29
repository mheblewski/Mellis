-- Self-hosted Mellis, step 1 (docs/product/device-auth-api.md):
--  * devices.bolus_public_key is optional: a phone pairs with its device key alone, so a phone without Face ID or
--    Touch ID pairs too. The Face ID bound bolus key is registered later, when the person confirms a remote bolus grant
--    (POST /v1/me/devices/bolus-key), signed by both keys over a BOLUS_KEY challenge. bolus_key_registered_at says when
--    (phones paired with both keys before this migration: their pairing time).
--  * device_challenges: purpose BOLUS_KEY, like SESSION without a patient.
ALTER TABLE devices ALTER COLUMN bolus_public_key DROP NOT NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS bolus_key_registered_at timestamptz NULL;
UPDATE devices SET bolus_key_registered_at = created_at WHERE bolus_public_key IS NOT NULL AND bolus_key_registered_at IS NULL;

ALTER TABLE device_challenges DROP CONSTRAINT IF EXISTS device_challenges_purpose_check;
ALTER TABLE device_challenges ADD CONSTRAINT device_challenges_purpose_check
  CHECK (purpose IN ('SESSION', 'REMOTE_BOLUS', 'REMOTE_BOLUS_CONFIRM', 'BOLUS_KEY'));
ALTER TABLE device_challenges DROP CONSTRAINT IF EXISTS device_challenges_patient_check;
ALTER TABLE device_challenges ADD CONSTRAINT device_challenges_patient_check
  CHECK ((purpose IN ('SESSION', 'BOLUS_KEY')) = (patient_id IS NULL));
