-- A sign-out the phone could not send (offline) left the previous caregiver's pushes coming to it (audit 2026-10-26).
-- The phone keeps a random secret of its own and sends it with each registration; the server keeps only its hash. With
-- the token and the secret, the phone releases its rows later without a session (POST /v1/devices/release).
ALTER TABLE patient_devices ADD COLUMN IF NOT EXISTS release_secret_hash text NULL;

-- Its audit entry has no signed-in caregiver: the phone's own secret is the proof.
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_provider_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_provider_check CHECK (provider IN ('COGNITO', 'LOCAL_DEV', 'LOCAL_TOKEN', 'DEVICE_SECRET'));
