-- Diagnostic export (diagnostics.v1): what happened on this server, for "Zgłoś problem" in the app and the server's
-- "Raport do zgłoszenia". Rows are ten-minute counts of named events. Only an allowlist of technical fields is stored
-- (modules/diagnostics/application/diagnostic-events.ts): no patient, no user, no values, no free text. Kept 14 days.
CREATE TABLE IF NOT EXISTS diagnostic_events (
  bucket_start timestamptz NOT NULL,
  source text NOT NULL,
  level text NOT NULL,
  event text NOT NULL,
  -- The fields as sorted JSON text: one row per distinct set of fields in a bucket.
  fields_key text NOT NULL,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  count integer NOT NULL,
  first_at timestamptz NOT NULL,
  last_at timestamptz NOT NULL,
  duration_ms_total bigint NULL,
  duration_ms_max integer NULL,
  CONSTRAINT diagnostic_events_level_check CHECK (level IN ('info', 'warn', 'error')),
  PRIMARY KEY (bucket_start, source, level, event, fields_key)
);

CREATE INDEX IF NOT EXISTS diagnostic_events_last_at_idx ON diagnostic_events (last_at DESC);
