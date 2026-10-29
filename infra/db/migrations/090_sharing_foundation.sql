-- Onboarding and sharing, stage 1 (docs/product/onboarding-sharing-plan.md): the invisible foundation.
--  * sources: each patient's own Nightscout (address, auth mode, encrypted token). The worker syncs every enabled
--    source instead of NIGHTSCOUT_* env; the env values only seed the existing patient once (the worker does it at
--    start, because the encryption key lives in env, never in the database).
--  * caregiver_relationships: memberships. is_owner (several owners per patient, never zero once there is one; an
--    owner also manages sharing), permissions.glucose_alerts / ai_chat_meals, and remote bolus: granted by an owner,
--    counted only once the grantee has confirmed it on their own phone.
--  * sharing_invitations: e-mail invitations (single use, 7 days, revocable, at most 10 people per patient).
--  * beta_allowlist: the closed beta's e-mails (BETA_ALLOWLIST_ENABLED turns the check off).

-- Per-patient Nightscout ---------------------------------------------------------------------------------------------
ALTER TABLE sources ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS base_url text NULL;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS auth_mode text NULL;
-- AES-256-GCM, "v1:<iv>:<tag>:<ciphertext>" (base64), key NIGHTSCOUT_TOKEN_ENCRYPTION_KEY. Never logged, never returned.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS api_token_ciphertext text NULL;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS credentials_updated_at timestamptz NULL;
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_auth_mode_check;
ALTER TABLE sources ADD CONSTRAINT sources_auth_mode_check
  CHECK (auth_mode IS NULL OR auth_mode IN ('BEARER', 'API_SECRET_SHA1', 'ACCESS_TOKEN_JWT'));
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_token_ciphertext_check;
ALTER TABLE sources ADD CONSTRAINT sources_token_ciphertext_check
  CHECK (api_token_ciphertext IS NULL OR api_token_ciphertext LIKE 'v1:%');

UPDATE sources SET base_url = metadata->>'base_url'
WHERE source_system = 'NIGHTSCOUT' AND base_url IS NULL AND metadata ? 'base_url';

-- One Nightscout connection per patient: at most one source holds the credentials. Older extra source rows of the same
-- patient (another source_key) may exist and keep their records; they sync through the patient's one connection.
CREATE UNIQUE INDEX IF NOT EXISTS sources_one_nightscout_connection_per_patient_idx
  ON sources (patient_id) WHERE source_system = 'NIGHTSCOUT' AND api_token_ciphertext IS NOT NULL;

-- Memberships -------------------------------------------------------------------------------------------------------
ALTER TABLE caregiver_relationships ADD COLUMN IF NOT EXISTS is_owner boolean NOT NULL DEFAULT false;
ALTER TABLE caregiver_relationships ADD COLUMN IF NOT EXISTS remote_bolus_granted_by uuid NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE caregiver_relationships ADD COLUMN IF NOT EXISTS remote_bolus_granted_at timestamptz NULL;
ALTER TABLE caregiver_relationships ADD COLUMN IF NOT EXISTS remote_bolus_confirmed_at timestamptz NULL;
ALTER TABLE caregiver_relationships DROP CONSTRAINT IF EXISTS caregiver_relationships_permissions_object_check;
ALTER TABLE caregiver_relationships ADD CONSTRAINT caregiver_relationships_permissions_object_check
  CHECK (jsonb_typeof(permissions) = 'object');
-- A confirmation always belongs to a grant.
ALTER TABLE caregiver_relationships DROP CONSTRAINT IF EXISTS caregiver_relationships_remote_bolus_confirm_check;
ALTER TABLE caregiver_relationships ADD CONSTRAINT caregiver_relationships_remote_bolus_confirm_check
  CHECK (remote_bolus_confirmed_at IS NULL OR remote_bolus_granted_at IS NOT NULL);

-- Only an owner of the same patient grants remote bolus (checked whenever the grant changes).
CREATE OR REPLACE FUNCTION caregiver_relationships_check_remote_bolus_grant() RETURNS trigger AS $$
BEGIN
  IF NEW.remote_bolus_granted_by IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.remote_bolus_granted_by IS DISTINCT FROM OLD.remote_bolus_granted_by
          OR NEW.remote_bolus_granted_at IS DISTINCT FROM OLD.remote_bolus_granted_at)
     AND NOT (NEW.remote_bolus_granted_by = NEW.user_id AND NEW.is_owner)
     AND NOT EXISTS (
       SELECT 1 FROM caregiver_relationships o
       WHERE o.patient_id = NEW.patient_id AND o.user_id = NEW.remote_bolus_granted_by AND o.is_owner
     ) THEN
    RAISE EXCEPTION 'REMOTE_BOLUS_GRANTER_NOT_OWNER' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS caregiver_relationships_remote_bolus_grant_check ON caregiver_relationships;
CREATE TRIGGER caregiver_relationships_remote_bolus_grant_check BEFORE INSERT OR UPDATE ON caregiver_relationships
  FOR EACH ROW EXECUTE FUNCTION caregiver_relationships_check_remote_bolus_grant();

-- A patient that has an owner keeps at least one (checked at commit, so owners can be swapped in one transaction).
-- Deleting the patient itself removes every membership freely.
CREATE OR REPLACE FUNCTION caregiver_relationships_keep_an_owner() RETURNS trigger AS $$
BEGIN
  IF OLD.is_owner
     AND EXISTS (SELECT 1 FROM patients p WHERE p.id = OLD.patient_id)
     AND NOT EXISTS (SELECT 1 FROM caregiver_relationships o WHERE o.patient_id = OLD.patient_id AND o.is_owner) THEN
    RAISE EXCEPTION 'PATIENT_NEEDS_AN_OWNER' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS caregiver_relationships_keep_an_owner ON caregiver_relationships;
CREATE CONSTRAINT TRIGGER caregiver_relationships_keep_an_owner AFTER UPDATE OR DELETE ON caregiver_relationships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION caregiver_relationships_keep_an_owner();

-- Grants and confirmations reach the phones at once, like the permissions (045).
CREATE OR REPLACE FUNCTION caregiver_relationships_notify_permissions() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE'
     OR NEW.permissions IS DISTINCT FROM OLD.permissions
     OR NEW.is_owner IS DISTINCT FROM OLD.is_owner
     OR NEW.remote_bolus_granted_by IS DISTINCT FROM OLD.remote_bolus_granted_by
     OR NEW.remote_bolus_granted_at IS DISTINCT FROM OLD.remote_bolus_granted_at
     OR NEW.remote_bolus_confirmed_at IS DISTINCT FROM OLD.remote_bolus_confirmed_at THEN
    PERFORM glucomind_notify_event(CASE WHEN TG_OP = 'DELETE' THEN OLD.patient_id ELSE NEW.patient_id END, 'capabilities', NULL);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

-- Today's caregivers are the family: every linked caregiver becomes an owner with every permission. A remote bolus
-- switch already on stays on (granted by and confirmed by that owner), so nothing changes for them.
UPDATE caregiver_relationships
SET is_owner = true,
    permissions = permissions || '{"glucose_alerts": true, "ai_chat_meals": true}'::jsonb,
    remote_bolus_granted_by = CASE WHEN permissions->'remote_commands' = 'true'::jsonb THEN user_id ELSE remote_bolus_granted_by END,
    remote_bolus_granted_at = CASE WHEN permissions->'remote_commands' = 'true'::jsonb THEN now() ELSE remote_bolus_granted_at END,
    remote_bolus_confirmed_at = CASE WHEN permissions->'remote_commands' = 'true'::jsonb THEN now() ELSE remote_bolus_confirmed_at END,
    updated_at = now()
WHERE NOT is_owner;

-- Invitations ------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sharing_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  email text NOT NULL,
  invitee_name text NULL,
  invited_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- glucose_alerts, ai_chat_meals, manage_sharing (= becomes an owner), remote_commands (owners only).
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at timestamptz NULL,
  accepted_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz NULL,
  CONSTRAINT sharing_invitations_email_normalized_check CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  CONSTRAINT sharing_invitations_permissions_object_check CHECK (jsonb_typeof(permissions) = 'object'),
  CONSTRAINT sharing_invitations_single_outcome_check CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  CONSTRAINT sharing_invitations_accepted_by_check CHECK ((accepted_at IS NULL) = (accepted_by IS NULL))
);

-- One open invitation per patient and e-mail (a new one replaces the old one by revoking it first).
CREATE UNIQUE INDEX IF NOT EXISTS sharing_invitations_one_open_idx
  ON sharing_invitations (patient_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
-- Sign-in looks invitations up by e-mail.
CREATE INDEX IF NOT EXISTS sharing_invitations_email_idx ON sharing_invitations (email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Closed beta ------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS beta_allowlist (
  email text PRIMARY KEY,
  note text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beta_allowlist_email_normalized_check CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%')
);

-- Everyone who has signed in and is linked to a patient today keeps access.
INSERT INTO beta_allowlist (email, note)
SELECT DISTINCT lower(btrim(ai.email)), 'linked caregiver at migration 090'
FROM auth_identities ai
JOIN caregiver_relationships r ON r.user_id = ai.user_id
WHERE ai.email IS NOT NULL AND btrim(ai.email) LIKE '%_@_%'
ON CONFLICT (email) DO NOTHING;
