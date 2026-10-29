-- Self-hosted Mellis, stages 2 and 3 (docs/product/community-self-hosted-plan.md, docs/product/device-auth-api.md).
--  * Phones registered before migration 070 have no user (sharing audit #22, ported from 094): they get the only
--    member's id, or stop getting pushes until the app registers again (it does at its next start).
--  * sharing_invitations: e-mail optional. AUTH_MODE=device invites a person by a one-time code (device_pairing_codes),
--    not by e-mail; the Cognito path still writes e-mails.
--  * devices: a paired phone (AUTH_MODE=device) with two Secure Enclave P-256 public keys: the device key signs session
--    challenges, the bolus key (Face ID bound on the phone) signs every remote command and the remote bolus confirmation.
--  * device_pairing_codes: one-time codes (SHA-256 stored) that pair a phone into a person: the first owner (setup),
--    another phone of the same person, an invitation, or `reset-owner` on the server.
--  * device_challenges / device_sessions: single-use server nonces and short-lived session tokens (SHA-256 stored).
--  * server_setup: one row. completed_at = the first owner's phone paired; from then on the setup code is void. A server
--    that already has owners (today's Cognito production) starts completed. The recovery code is stored as SHA-256.
--  * remote_commands.device_authorization: the signed payload and confirmation text a device-mode command came with.

-- Sharing audit #22 -------------------------------------------------------------------------------------------------
UPDATE patient_devices d
SET user_id = (SELECT r.user_id FROM caregiver_relationships r WHERE r.patient_id = d.patient_id LIMIT 1), updated_at = now()
WHERE d.user_id IS NULL
  AND (SELECT count(DISTINCT r.user_id) FROM caregiver_relationships r WHERE r.patient_id = d.patient_id) = 1;
UPDATE patient_devices SET active = false, updated_at = now() WHERE user_id IS NULL AND active;

-- Invitations without e-mail ------------------------------------------------------------------------------------------
ALTER TABLE sharing_invitations ALTER COLUMN email DROP NOT NULL;
ALTER TABLE sharing_invitations DROP CONSTRAINT IF EXISTS sharing_invitations_email_normalized_check;
ALTER TABLE sharing_invitations ADD CONSTRAINT sharing_invitations_email_normalized_check
  CHECK (email IS NULL OR (email = lower(btrim(email)) AND email LIKE '%_@_%'));
ALTER TABLE sharing_invitations DROP CONSTRAINT IF EXISTS sharing_invitations_email_or_name_check;
ALTER TABLE sharing_invitations ADD CONSTRAINT sharing_invitations_email_or_name_check
  CHECK (email IS NOT NULL OR NULLIF(btrim(invitee_name), '') IS NOT NULL);

-- Devices -------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  platform text NOT NULL DEFAULT 'ios',
  -- base64 of the X9.63 uncompressed P-256 point (65 bytes, SecKeyCopyExternalRepresentation).
  public_key text NOT NULL,
  bolus_public_key text NOT NULL,
  -- The app's own device id (POST /v1/patients/:id/devices): its push rows stop when the device is revoked.
  client_device_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NULL,
  revoked_at timestamptz NULL,
  revoked_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT devices_platform_check CHECK (platform IN ('ios')),
  CONSTRAINT devices_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT devices_keys_differ_check CHECK (public_key <> bolus_public_key),
  CONSTRAINT devices_public_key_unique UNIQUE (public_key),
  CONSTRAINT devices_bolus_public_key_unique UNIQUE (bolus_public_key)
);
CREATE INDEX IF NOT EXISTS devices_user_active_idx ON devices (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS device_pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL,
  purpose text NOT NULL,
  -- The person the phone pairs into (every purpose but INVITATION, which creates the person).
  user_id uuid NULL REFERENCES users(id) ON DELETE CASCADE,
  invitation_id uuid NULL REFERENCES sharing_invitations(id) ON DELETE CASCADE,
  created_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL,
  used_by_device_id uuid NULL REFERENCES devices(id) ON DELETE SET NULL,
  CONSTRAINT device_pairing_codes_hash_unique UNIQUE (code_hash),
  CONSTRAINT device_pairing_codes_purpose_check CHECK (purpose IN ('SETUP_OWNER', 'ADD_DEVICE', 'INVITATION', 'RESET_OWNER')),
  CONSTRAINT device_pairing_codes_target_check CHECK (
    (purpose = 'INVITATION' AND invitation_id IS NOT NULL AND user_id IS NULL)
    OR (purpose <> 'INVITATION' AND user_id IS NOT NULL AND invitation_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS device_pairing_codes_user_idx ON device_pairing_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS device_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  patient_id uuid NULL REFERENCES patients(id) ON DELETE CASCADE,
  nonce text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL,
  CONSTRAINT device_challenges_purpose_check CHECK (purpose IN ('SESSION', 'REMOTE_BOLUS', 'REMOTE_BOLUS_CONFIRM')),
  CONSTRAINT device_challenges_patient_check CHECK ((purpose = 'SESSION') = (patient_id IS NULL))
);
CREATE INDEX IF NOT EXISTS device_challenges_expires_idx ON device_challenges (expires_at);

CREATE TABLE IF NOT EXISTS device_sessions (
  token_hash text PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS device_sessions_device_idx ON device_sessions (device_id);
CREATE INDEX IF NOT EXISTS device_sessions_expires_idx ON device_sessions (expires_at);

-- Server setup --------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS server_setup (
  id boolean PRIMARY KEY DEFAULT true,
  completed_at timestamptz NULL,
  recovery_code_hash text NULL,
  recovery_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT server_setup_single_row_check CHECK (id)
);
INSERT INTO server_setup (id, completed_at)
SELECT true, CASE WHEN EXISTS (SELECT 1 FROM caregiver_relationships WHERE is_owner) THEN now() END
ON CONFLICT (id) DO NOTHING;

-- Signed remote commands ----------------------------------------------------------------------------------------------
ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS device_authorization jsonb NULL;

-- Audit rows of the device path -------------------------------------------------------------------------------------
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_provider_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_provider_check
  CHECK (provider IN ('COGNITO', 'LOCAL_DEV', 'LOCAL_TOKEN', 'DEVICE_SECRET', 'DEVICE', 'SETUP_CODE', 'RECOVERY_CODE', 'SERVER_CLI'));
