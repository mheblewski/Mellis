-- Rescue carb cards in any conversation, not only an alert's: the chat may prepare "Dosłodzenie Y g" when the caregiver
-- says they gave (or will give) fast carbs for a low. Such a card has no alert; confirming it logs the carbs like
-- "+" → "Dosłodzenie" in the meals tab (GlucoMind only, never Nightscout or the loop) and keeps what was logged on the
-- card itself.

ALTER TABLE rescue_carb_proposals ALTER COLUMN alert_id DROP NOT NULL;
ALTER TABLE rescue_carb_proposals ADD COLUMN IF NOT EXISTS treatment_event_id uuid NULL;
ALTER TABLE rescue_carb_proposals ADD COLUMN IF NOT EXISTS treatment_carbs_g numeric(5, 1) NULL;
ALTER TABLE rescue_carb_proposals ADD COLUMN IF NOT EXISTS treated_at timestamptz NULL;
ALTER TABLE rescue_carb_proposals ADD COLUMN IF NOT EXISTS treated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL;
