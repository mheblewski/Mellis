-- Rescue carbs logged by hand from the meals tab ("+" → "Dosłodzenie"), without an alert's card: stored the same way
-- (GlucoMind only, never in Nightscout or the loop, kind HYPO_TREATMENT). An open alert that already sent its push takes
-- them as its treatment, so no reminder follows; that treatment's source is MANUAL.

ALTER TABLE rescue_carb_alerts DROP CONSTRAINT IF EXISTS rescue_carb_alerts_treatment_source_check;
ALTER TABLE rescue_carb_alerts ADD CONSTRAINT rescue_carb_alerts_treatment_source_check
  CHECK (treatment_source IS NULL OR treatment_source IN ('ALERT', 'CHAT_CARD', 'MANUAL'));
