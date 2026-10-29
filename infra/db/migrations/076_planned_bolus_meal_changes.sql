-- A meal changed between its parts (owner 2026-10-26: "usunąłem z posiłku ok. 10 g węgli, a pozostała dawka przyjdzie
-- z powiadomieniem, a to już będzie za dużo"): the open later parts follow the meal's carbs. meal_carbs_g is the meal's
-- carbs the part's numbers were made for (null: not known yet, set at the next change); meal_change_g what the part took
-- of changes since (its push and page say so).

ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS meal_carbs_g numeric(6, 1) NULL;
ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS meal_change_g integer NOT NULL DEFAULT 0;

-- A split's later carbs may all be taken off while its dose still covers carbs sent earlier (dose_carbs_g).
ALTER TABLE planned_boluses DROP CONSTRAINT IF EXISTS planned_boluses_amounts_check;
ALTER TABLE planned_boluses ADD CONSTRAINT planned_boluses_amounts_check CHECK (
  carbs_g >= 0 AND carbs_g <= 300 AND planned_insulin_u >= 0 AND planned_insulin_u <= 30
  AND (carbs_g > 0 OR (kind = 'DEFERRED_INSULIN' AND first_carbs_g > 0) OR COALESCE(dose_carbs_g, 0) > 0)
);
