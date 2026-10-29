-- Code audit 2026-10-21.
--
-- 1. Glucose, carb and insulin reads filter the patient's events by type and time (current state, dashboard, answers);
--    without this index each of them scanned every event of the patient. Plain CREATE INDEX (not CONCURRENTLY): the
--    migration runner applies every file inside one transaction.
CREATE INDEX IF NOT EXISTS events_patient_type_occurred_idx ON events (patient_id, type, occurred_at DESC);

-- 2. Audit events name the provider that authenticated the request: COGNITO in production, LOCAL_DEV (AUTH_MODE=
--    disabled) or LOCAL_TOKEN (AUTH_MODE=local_token) on a developer's machine. Until now every row said COGNITO.
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_provider_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_provider_check CHECK (provider IN ('COGNITO', 'LOCAL_DEV', 'LOCAL_TOKEN'));
