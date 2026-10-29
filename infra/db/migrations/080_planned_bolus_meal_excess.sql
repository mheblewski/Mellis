-- Carbs removed from a meal beyond what its later parts still held (audit 2026-10-26, owner: "ostrzeżenie w aplikacji
-- + push"): the insulin already given covered them, so it was too much. The grams are kept on the meal's first part
-- that follows the meal (the meal page and a push say so), and carbs that come back undo them first, so "Cofnij" never
-- adds grams to a part.

ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS meal_excess_g integer NOT NULL DEFAULT 0;
