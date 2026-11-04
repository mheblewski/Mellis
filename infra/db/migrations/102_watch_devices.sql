-- Apple Watch app (watch-glance.v1, widget-push.v1). The caregiver's phone creates a watch device with a read-only gmw_
-- token and hands the token to its paired watch; the token is stored as sha256 and works only on /v1/watch/*.
CREATE TABLE watch_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The watch's own label; null when the phone sent none.
  device text NULL CHECK (device IS NULL OR char_length(device) <= 40),
  patient_ids uuid[] NOT NULL CHECK (cardinality(patient_ids) BETWEEN 1 AND 4),
  -- sha256 (hex) of the gmw_ token.
  token_hash text NOT NULL UNIQUE,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NULL
);

CREATE INDEX watch_devices_user_idx ON watch_devices (user_id) WHERE revoked_at IS NULL;

-- WidgetKit push tokens of the complications; the worker sends `content-changed` on each new reading. Apple budgets
-- these pushes, so at most one goes out per token in 4 minutes (widget-push.v1).
CREATE TABLE watch_push_tokens (
  token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  watch_device_id uuid NOT NULL REFERENCES watch_devices(id) ON DELETE CASCADE,
  -- The app's bundle id without the `.push-type.widgets` suffix.
  topic text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  platform text NOT NULL CHECK (platform IN ('watchos', 'ios')),
  patient_ids uuid[] NOT NULL CHECK (cardinality(patient_ids) BETWEEN 1 AND 4),
  -- The token's last push for any patient (the at-most-one-per-4-min rule).
  last_pushed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX watch_push_tokens_user_idx ON watch_push_tokens (user_id);
CREATE INDEX watch_push_tokens_watch_device_idx ON watch_push_tokens (watch_device_id);

-- Per token and patient: the last reading the worker decided on, and what the last push showed.
CREATE TABLE watch_push_state (
  token text NOT NULL REFERENCES watch_push_tokens(token) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  last_reading_at timestamptz NULL,
  -- A reading held back only by the token's 4-min rule: retried on later ticks, its skip logged once.
  deferred_reading_at timestamptz NULL,
  last_pushed_at timestamptz NULL,
  last_value numeric NULL,
  last_level text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token, patient_id)
);
