-- audit-2026-10-23: a phone registered for a patient remembers the caregiver who registered it, so a caregiver whose
-- relationship to the patient is removed stops getting that patient's pushes (glucose, alerts, the patient's name).
-- NULL for rows registered before this migration until the app registers again (they keep receiving as before).
ALTER TABLE patient_devices ADD COLUMN IF NOT EXISTS user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL;
