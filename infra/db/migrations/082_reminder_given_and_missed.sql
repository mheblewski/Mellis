-- Meal reminders follow one rule for "already given" (audit 2026-10-26): a second dose given before its reminder came
-- is settled as GIVEN (no push), and each dose answers at most one reminder (dose_given_action_id: the loop action that
-- answered it), so one bolus never reads as both a meal's second dose and its WBT, or as two meals' WBT. A chat
-- reminder at a time that the worker could not send within 2 h (it was down) is MISSED (owner 2026-10-26: no late
-- push, the bell says it was missed).

ALTER TABLE care_reminders DROP CONSTRAINT IF EXISTS care_reminders_status_check;
ALTER TABLE care_reminders ADD CONSTRAINT care_reminders_status_check CHECK (status IN ('ACTIVE', 'FIRED', 'CANCELLED', 'EXPIRED', 'MISSED', 'GIVEN'));

ALTER TABLE care_reminders ADD COLUMN IF NOT EXISTS dose_given_action_id uuid NULL;
ALTER TABLE meal_wbt_reminders ADD COLUMN IF NOT EXISTS dose_given_action_id uuid NULL;
