-- Delivery of a rescue carb alert's push and of its one reminder (owner decision 2026-10-26). A push that reached no
-- phone (every device failed, no device opted in, or the device list failed) was lost: the alert stayed NOTIFIED and
-- only the reminder 15 min later could reach anyone (for < 54 not even that). Now each push counts its send attempts and
-- records when one reached a phone; the worker sends an undelivered push again on its next evaluations (every 45 s at
-- most, for 30 min, same alert id: one notification on the phone, one bell entry) until it is delivered or the alert
-- is declined, treated or closed.
--
-- Alerts pushed before this migration count as delivered (their delivery is unknown; no late resends).

ALTER TABLE rescue_carb_alerts ADD COLUMN IF NOT EXISTS alert_push_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE rescue_carb_alerts ADD COLUMN IF NOT EXISTS alert_last_push_attempt_at timestamptz NULL;
ALTER TABLE rescue_carb_alerts ADD COLUMN IF NOT EXISTS alert_delivered_at timestamptz NULL;
ALTER TABLE rescue_carb_alerts ADD COLUMN IF NOT EXISTS reminder_push_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE rescue_carb_alerts ADD COLUMN IF NOT EXISTS reminder_last_push_attempt_at timestamptz NULL;
ALTER TABLE rescue_carb_alerts ADD COLUMN IF NOT EXISTS reminder_delivered_at timestamptz NULL;

UPDATE rescue_carb_alerts
SET alert_push_attempts = CASE WHEN notified_at IS NOT NULL AND alert_push_attempts = 0 THEN 1 ELSE alert_push_attempts END,
    alert_last_push_attempt_at = COALESCE(alert_last_push_attempt_at, notified_at),
    alert_delivered_at = COALESCE(alert_delivered_at, notified_at),
    reminder_push_attempts = CASE WHEN reminder_sent_at IS NOT NULL AND reminder_push_attempts = 0 THEN 1 ELSE reminder_push_attempts END,
    reminder_last_push_attempt_at = COALESCE(reminder_last_push_attempt_at, reminder_sent_at),
    reminder_delivered_at = COALESCE(reminder_delivered_at, reminder_sent_at)
WHERE notified_at IS NOT NULL OR reminder_sent_at IS NOT NULL;
