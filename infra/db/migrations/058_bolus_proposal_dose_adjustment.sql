-- A meal bolus lowered for a falling glucose (docs/product/meal-dose-forecast-plan.md, owner decision 2026-10-21): when
-- Trio forecasts glucose below target, part of the meal's carbs covers the drop and the chat card's insulin is only for
-- the rest (0 U when the meal covers the whole drop); the carbs still go to Trio.
--
-- bolus_proposals.dose_adjustment: how the server lowered the dose ({policy_version, basis, glucose_mgdl,
-- forecast_low_mgdl, target_mgdl, isf_mgdl_per_u, icr_g_per_u, trio_carbs_req_g, covered_carbs_g, dose_before_u, dose_u,
-- reduced_by_u, summary}); NULL: the dose is carbs / ICR (or the model's own).

ALTER TABLE bolus_proposals ADD COLUMN IF NOT EXISTS dose_adjustment jsonb NULL;
ALTER TABLE bolus_proposals DROP CONSTRAINT IF EXISTS bolus_proposals_dose_adjustment_check;
ALTER TABLE bolus_proposals ADD CONSTRAINT bolus_proposals_dose_adjustment_check
  CHECK (dose_adjustment IS NULL OR jsonb_typeof(dose_adjustment) = 'object');
