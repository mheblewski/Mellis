CREATE TABLE IF NOT EXISTS auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_subject text NOT NULL,
  provider_username text NULL,
  email text NULL,
  full_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_identities_provider_check CHECK (provider IN ('COGNITO')),
  CONSTRAINT auth_identities_unique_provider_subject UNIQUE (provider, provider_subject),
  CONSTRAINT auth_identities_unique_user_provider UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS auth_identities_user_idx
  ON auth_identities (user_id);

CREATE INDEX IF NOT EXISTS auth_identities_email_idx
  ON auth_identities (email)
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  outcome text NOT NULL,
  provider text NOT NULL,
  provider_subject text NULL,
  user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  request_path text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_outcome_check CHECK (outcome IN ('ALLOW', 'DENY')),
  CONSTRAINT audit_events_provider_check CHECK (provider IN ('COGNITO'))
);

CREATE INDEX IF NOT EXISTS audit_events_created_at_idx
  ON audit_events (created_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_user_idx
  ON audit_events (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
