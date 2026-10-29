-- "Nie podaję" on a rescue carb alert (docs/product/rescue-carbs-plan.md): the caregiver decided not to give carbs
-- (e.g. after talking it through in the alert's chat). The alert stays open as before, but sends no reminder; only a
-- worse level than the one announced (a real low after a predicted one, or below 55) starts a new alert. Logging carbs
-- later is still possible and wins (the alert becomes TREATED).

ALTER TABLE rescue_carb_alerts ADD COLUMN IF NOT EXISTS declined_at timestamptz NULL;
ALTER TABLE rescue_carb_alerts ADD COLUMN IF NOT EXISTS declined_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL;
