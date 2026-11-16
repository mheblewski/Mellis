-- The newest loop status and the newest current state are read several times per Bolus check (2026-11-15: a check
-- took 0.5-2 s on the server, and the phone gave up after 8 s while a few of them queued on one CPU).
--
-- 1. "The loop's newest status" (DashboardRepository.latestDeviceStatusWith: DEVICE_STATUS with openaps/loop, or with
--    pump) has no time bound. The planner cannot estimate the JSON key filter, so it read every device status of the
--    patient with its JSON and sorted them (209 ms for 48 000 rows in production). A partial index per key set matches
--    the query exactly: the newest row is the first entry (0.02 ms).
-- 2. "The newest current state" sorted all of the patient's current_states rows by as_of (14 ms for 17 000 rows).
--
-- Plain CREATE INDEX (not CONCURRENTLY): the migration runner applies every file inside one transaction. Both tables are
-- small enough for the short write lock.
CREATE INDEX IF NOT EXISTS source_records_latest_loop_status_idx ON source_records (patient_id, occurred_at DESC)
  WHERE record_type = 'DEVICE_STATUS' AND raw_payload ?| ARRAY['openaps', 'loop'];
CREATE INDEX IF NOT EXISTS source_records_latest_pump_status_idx ON source_records (patient_id, occurred_at DESC)
  WHERE record_type = 'DEVICE_STATUS' AND raw_payload ?| ARRAY['pump'];
CREATE INDEX IF NOT EXISTS current_states_patient_as_of_idx ON current_states (patient_id, as_of DESC, updated_at DESC);
