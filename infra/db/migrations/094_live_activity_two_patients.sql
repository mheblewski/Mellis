-- The glucose Live Activity for up to two patients on one phone (owner decision 2026-10-29). Still one row per phone;
-- patient_id stays the first (primary) patient, so rows from 088 keep working as one-patient activities.
--  * patient_ids: the patients shown, in the caregiver's order (1 or 2). A patient the person lost access to (or this
--    phone is no longer registered for) is left out at push time; the row keeps them in case access comes back.
--  * island_mode: what the Dynamic Island shows with two patients: 'both' (compact leading = one patient's glucose,
--    trailing = the other's) or 'closer' (the patient closer to danger, with IOB). One patient: island_enabled as before.
--  * island_left_patient_id: in 'both', the patient on the left (NULL = the first of patient_ids).
--  * last_readings: { patient_id: reading time } of the readings the activity shows; a push goes out when either
--    patient has a newer one.
ALTER TABLE live_activity_subscriptions
  ADD COLUMN IF NOT EXISTS patient_ids uuid[] NULL,
  ADD COLUMN IF NOT EXISTS island_mode text NOT NULL DEFAULT 'both',
  ADD COLUMN IF NOT EXISTS island_left_patient_id uuid NULL,
  ADD COLUMN IF NOT EXISTS last_readings jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE live_activity_subscriptions SET patient_ids = ARRAY[patient_id] WHERE patient_ids IS NULL;

ALTER TABLE live_activity_subscriptions
  ALTER COLUMN patient_ids SET NOT NULL,
  ADD CONSTRAINT live_activity_subscriptions_patient_ids_check
    CHECK (cardinality(patient_ids) BETWEEN 1 AND 2 AND patient_ids[1] = patient_id),
  ADD CONSTRAINT live_activity_subscriptions_island_mode_check CHECK (island_mode IN ('both', 'closer'));
