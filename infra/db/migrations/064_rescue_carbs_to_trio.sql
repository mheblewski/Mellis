-- Rescue carbs go to Trio by default (owner decision 2026-10-22, docs/product/advisor-agent-plan.md stage 2): the
-- loop should know every carb that changes glucose. A rescue dose is sent as a carbs-only remote command (source
-- RESCUE_CARBS, purpose HYPO_TREATMENT: no meal, no "Na co to było?"), confirmed with Face ID like a bolus card. The
-- caregiver can still choose "Nie wysyłaj do Trio": then it is logged in GlucoMind only, as before.
--
-- remote_commands.rescue_alert_id / rescue_proposal_id: the alert or chat card the dose answers (none from the meals
-- tab). rescue_carb_alerts.treatment_command_id / rescue_carb_proposals.treatment_command_id: the alert or card is
-- treated by that command from the moment it is authorized (no reminder, no second log); a command Trio refused or
-- that never left gives the treatment back. treatment_event_id is the Trio carb entry once it is matched.

ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS rescue_alert_id uuid NULL REFERENCES rescue_carb_alerts(id) ON DELETE SET NULL;
ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS rescue_proposal_id uuid NULL REFERENCES rescue_carb_proposals(id) ON DELETE SET NULL;

ALTER TABLE remote_commands DROP CONSTRAINT IF EXISTS remote_commands_purpose_check;
ALTER TABLE remote_commands ADD CONSTRAINT remote_commands_purpose_check CHECK (
  (purpose IS NULL AND target_meal_record_id IS NULL AND planned_bolus_id IS NULL)
  OR (purpose = 'WBT' AND target_meal_record_id IS NOT NULL AND planned_bolus_id IS NULL)
  OR (purpose = 'MEAL_PART' AND target_meal_record_id IS NOT NULL AND planned_bolus_id IS NOT NULL)
  OR (purpose = 'HYPO_TREATMENT' AND target_meal_record_id IS NULL AND planned_bolus_id IS NULL AND insulin_u = 0 AND carbs_g > 0)
);

ALTER TABLE remote_commands DROP CONSTRAINT IF EXISTS remote_commands_source_check;
ALTER TABLE remote_commands ADD CONSTRAINT remote_commands_source_check CHECK (source IN ('BOLUS_SCREEN', 'CHAT_CARD', 'NEW_MEAL', 'WBT_SCREEN', 'PLANNED_BOLUS', 'RESCUE_CARBS'));

ALTER TABLE rescue_carb_alerts ADD COLUMN IF NOT EXISTS treatment_command_id uuid NULL REFERENCES remote_commands(id) ON DELETE SET NULL;
ALTER TABLE rescue_carb_proposals ADD COLUMN IF NOT EXISTS treatment_command_id uuid NULL REFERENCES remote_commands(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS rescue_carb_alerts_treatment_command_idx ON rescue_carb_alerts (treatment_command_id) WHERE treatment_command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS rescue_carb_proposals_treatment_command_idx ON rescue_carb_proposals (treatment_command_id) WHERE treatment_command_id IS NOT NULL;
