-- The WBT reminder's time follows its meal (audit 2026-10-26): every write sets remind_at to 2.5 h after the meal's
-- start, or later when a split bolus's second part postponed it. The postponement is kept on its own (not_before), so
-- the time can move earlier when an earlier entry joins the meal and still never comes before that part.
ALTER TABLE meal_wbt_reminders ADD COLUMN IF NOT EXISTS not_before timestamptz;

-- Rows already later than 2.5 h after their meal were postponed: that time is their floor from now on.
UPDATE meal_wbt_reminders w
SET not_before = w.remind_at
FROM (
  SELECT patient_id, meal_record_id, min(occurred_at) AS started_at
  FROM meal_record_entries
  GROUP BY patient_id, meal_record_id
) s
WHERE w.patient_id = s.patient_id AND w.meal_record_id = s.meal_record_id
  AND w.status = 'SCHEDULED' AND w.not_before IS NULL
  AND w.remind_at > s.started_at + interval '150 minutes';

-- Why a reminder was skipped: STALE when the worker found it too late to send (a server outage), null otherwise (WBT
-- carbs already in the loop, a cancelled meal). The meal page says which.
ALTER TABLE meal_wbt_reminders ADD COLUMN IF NOT EXISTS skip_reason text;

-- MISSED (owner decision 2026-10-26): protein or fat came after the reminder's time had long passed (beyond the
-- worker's stale window): no push, the meal page asks to check whether WBT is still needed.
ALTER TABLE meal_wbt_reminders DROP CONSTRAINT IF EXISTS meal_wbt_reminders_status_check;
ALTER TABLE meal_wbt_reminders ADD CONSTRAINT meal_wbt_reminders_status_check CHECK (status IN ('SCHEDULED', 'SENT', 'SKIPPED', 'MISSED'));
ALTER TABLE meal_wbt_reminders DROP CONSTRAINT IF EXISTS meal_wbt_reminders_skip_reason_check;
ALTER TABLE meal_wbt_reminders ADD CONSTRAINT meal_wbt_reminders_skip_reason_check CHECK (skip_reason IS NULL OR skip_reason IN ('STALE'));
