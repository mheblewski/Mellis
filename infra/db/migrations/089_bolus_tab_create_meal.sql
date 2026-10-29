-- "Zapisz jako posiłek" in the Bolus tab (owner decision 2026-10-27): a dose from the Bolus tab becomes a meal of the
-- Meals journal when the caregiver ticks it, not only when a reminder is set with it (073). The box is ticked by
-- itself while a reminder is set; the app sends the flag either way, older builds send only reminders.
ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS create_meal boolean NOT NULL DEFAULT false;
ALTER TABLE remote_commands DROP CONSTRAINT IF EXISTS remote_commands_create_meal_bolus_tab_chk;
ALTER TABLE remote_commands ADD CONSTRAINT remote_commands_create_meal_bolus_tab_chk
  CHECK (NOT create_meal OR (source = 'BOLUS_SCREEN' AND carbs_g > 0));
