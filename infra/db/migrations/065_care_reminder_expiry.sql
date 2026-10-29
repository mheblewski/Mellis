-- A reminder on a glucose threshold (GLUCOSE_ABOVE / GLUCOSE_BELOW) is an alarm: when glucose never crosses it within
-- its watching time, it lapses quietly (EXPIRED, no push) instead of reminding anyway (care-reminders.v1, 2026-10-22).

ALTER TABLE care_reminders DROP CONSTRAINT IF EXISTS care_reminders_status_check;
ALTER TABLE care_reminders ADD CONSTRAINT care_reminders_status_check CHECK (status IN ('ACTIVE', 'FIRED', 'CANCELLED', 'EXPIRED'));
