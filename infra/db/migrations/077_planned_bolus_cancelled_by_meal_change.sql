-- A later part a meal change emptied is cancelled by that change and comes back when the change is undone (owner
-- 2026-10-26: "jak cofnąłem zmianę posiłku, to się nie przywróciło"). It keeps the emptied numbers (a split's later carbs
-- may be 0) and the meal's carbs it follows.

ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS cancelled_by_meal_change boolean NOT NULL DEFAULT false;

ALTER TABLE planned_boluses DROP CONSTRAINT IF EXISTS planned_boluses_amounts_check;
ALTER TABLE planned_boluses ADD CONSTRAINT planned_boluses_amounts_check CHECK (
  carbs_g >= 0 AND carbs_g <= 300 AND planned_insulin_u >= 0 AND planned_insulin_u <= 30
  AND (carbs_g > 0 OR (kind = 'DEFERRED_INSULIN' AND first_carbs_g > 0) OR COALESCE(dose_carbs_g, 0) > 0 OR cancelled_by_meal_change)
);
