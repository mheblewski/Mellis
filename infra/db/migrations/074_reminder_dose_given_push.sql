-- A caregiver gave the dose a meal's reminder asked for (owner 2026-10-26). The reminder keeps when (dose_given_at):
-- the meal's page shows it as given, and the other caregivers got one push then ("Druga dawka podana · Opiekun Ewa
-- podał drugą dawkę (1,5 j) na posiłek o 18:05" / "WBT podane · …"), once whatever the number of workers or doses.
ALTER TABLE care_reminders ADD COLUMN IF NOT EXISTS dose_given_at timestamptz;
ALTER TABLE meal_wbt_reminders ADD COLUMN IF NOT EXISTS dose_given_at timestamptz;
