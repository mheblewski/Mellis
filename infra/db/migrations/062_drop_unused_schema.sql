-- Code audit 2026-10-21: schema from 001_init.sql that no code ever read or wrote. Checked empty in production before
-- dropping (audit_entries 0 rows, date_of_birth NULL, the JSON columns '{}', custom_instructions '').
--   - audit_entries: auditing goes to audit_events.
--   - patients.date_of_birth, age_information: the patient's age is patients.birth_year (056).
--   - patients.diabetes_profile: therapy settings come from Nightscout profiles (therapies).
--   - users.communication_preferences, custom_instructions: the caregiver's AI preferences are users.ai_* (057).
DROP TABLE IF EXISTS audit_entries;

ALTER TABLE patients
  DROP COLUMN IF EXISTS date_of_birth,
  DROP COLUMN IF EXISTS age_information,
  DROP COLUMN IF EXISTS diabetes_profile;

ALTER TABLE users
  DROP COLUMN IF EXISTS communication_preferences,
  DROP COLUMN IF EXISTS custom_instructions;
