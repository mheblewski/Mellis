-- A meal's later parts follow every dose added to the meal (meal-doses.v1, owner 2026-11-11, "Chipsy jabłkowe"): 32 g
-- described after 10 g + 1,2 j from the Bolus tab became a rest of 22 g / 2,3 j; two more doses of 10 g were added to
-- the meal, yet the rest stayed 22 g, its push came at full size and the Bolus tab still said a second part waited.
-- What the meal's doses took off a part is kept apart from what it was made for, so a dose taken off the meal gives it
-- back; a part they covered fully is CANCELLED by them and comes back the same way.

ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS doses_cover_carbs_g integer NOT NULL DEFAULT 0;
ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS doses_cover_dose_g integer NOT NULL DEFAULT 0;
ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS doses_cover_insulin_u numeric(5, 2) NOT NULL DEFAULT 0;
ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS cancelled_by_meal_doses boolean NOT NULL DEFAULT false;

-- A part the doses covered fully may hold no carbs and no dose (as one a meal change emptied, migration 077).
ALTER TABLE planned_boluses DROP CONSTRAINT IF EXISTS planned_boluses_amounts_check;
ALTER TABLE planned_boluses ADD CONSTRAINT planned_boluses_amounts_check CHECK (
  carbs_g >= 0 AND carbs_g <= 300 AND planned_insulin_u >= 0 AND planned_insulin_u <= 30
  AND (carbs_g > 0 OR (kind = 'DEFERRED_INSULIN' AND first_carbs_g > 0) OR COALESCE(dose_carbs_g, 0) > 0
       OR COALESCE(fixed_insulin_u, 0) > 0 OR cancelled_by_meal_change OR cancelled_by_meal_doses)
);
ALTER TABLE planned_boluses DROP CONSTRAINT IF EXISTS planned_boluses_doses_cover_check;
ALTER TABLE planned_boluses ADD CONSTRAINT planned_boluses_doses_cover_check CHECK (
  doses_cover_carbs_g >= 0 AND doses_cover_dose_g >= 0 AND doses_cover_insulin_u >= 0
);
