-- WBT given from the WBT window (docs/product/remote-bolus-trio-plan.md): the carbs-equivalent and the bolus go to
-- Trio like any command, and the loop action they become is assigned as WBT of the meal the window was opened for
-- (no new meal). purpose is NULL for every other command (a meal or a correction, decided from the amounts).

ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS purpose text NULL;
ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS target_meal_record_id uuid NULL REFERENCES meal_records(id) ON DELETE SET NULL;

ALTER TABLE remote_commands DROP CONSTRAINT IF EXISTS remote_commands_purpose_check;
ALTER TABLE remote_commands ADD CONSTRAINT remote_commands_purpose_check CHECK (
  (purpose IS NULL AND target_meal_record_id IS NULL) OR (purpose = 'WBT' AND target_meal_record_id IS NOT NULL)
);

ALTER TABLE remote_commands DROP CONSTRAINT IF EXISTS remote_commands_source_check;
ALTER TABLE remote_commands ADD CONSTRAINT remote_commands_source_check CHECK (source IN ('BOLUS_SCREEN', 'CHAT_CARD', 'NEW_MEAL', 'WBT_SCREEN'));
