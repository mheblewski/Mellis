-- Deferred meal boluses (deferred-bolus.v1, docs/product/deferred-meal-bolus-plan.md, owner decision 2026-10-21): when
-- glucose is low or falling before a meal (fast carbs first, or a drop the whole meal would cover), the chat card sends
-- the meal's carbs to Trio now with no insulin and plans the whole meal dose for later. The reminder comes when glucose
-- has stopped falling (at the earliest 15 min after the meal); the dose is computed then (the meal's carbs / ICR now
-- minus the loop's extra insulin since the meal) and given as insulin alone (a MEAL_PART command with 0 g).
--
-- planned_boluses.kind: SPLIT (the second part of a split meal, migration 050) or DEFERRED_INSULIN (carbs_g 0: nothing
-- deferred but the dose; first_carbs_g holds the meal's carbs the dose is for; now_percent 100).

ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'SPLIT';
ALTER TABLE planned_boluses DROP CONSTRAINT IF EXISTS planned_boluses_kind_check;
ALTER TABLE planned_boluses ADD CONSTRAINT planned_boluses_kind_check CHECK (kind IN ('SPLIT', 'DEFERRED_INSULIN'));

ALTER TABLE planned_boluses DROP CONSTRAINT IF EXISTS planned_boluses_amounts_check;
ALTER TABLE planned_boluses ADD CONSTRAINT planned_boluses_amounts_check CHECK (
  carbs_g >= 0 AND carbs_g <= 300 AND planned_insulin_u >= 0 AND planned_insulin_u <= 30
  AND (carbs_g > 0 OR (kind = 'DEFERRED_INSULIN' AND first_carbs_g > 0))
);

ALTER TABLE planned_boluses DROP CONSTRAINT IF EXISTS planned_boluses_split_check;
ALTER TABLE planned_boluses ADD CONSTRAINT planned_boluses_split_check CHECK (
  (kind = 'SPLIT' AND now_percent BETWEEN 50 AND 95 AND delay_minutes BETWEEN 15 AND 240)
  OR (kind = 'DEFERRED_INSULIN' AND now_percent = 100 AND delay_minutes BETWEEN 5 AND 240)
);
