-- Retrying a chat card's dose after Trio refused it (docs/product/remote-bolus-trio-plan.md W7): a card may be sent
-- again when its last command was REJECTED (nothing stored in Trio) or PARTIAL (the carbs stored, the bolus refused).
-- follows_command_id links the retry to the failed command, so a bolus-only retry joins the same meal; the server
-- refuses carbs in a retry after PARTIAL (they are in Trio already).

ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS follows_command_id uuid NULL REFERENCES remote_commands(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS remote_commands_one_per_proposal_idx;
CREATE UNIQUE INDEX IF NOT EXISTS remote_commands_one_per_proposal_idx ON remote_commands (proposal_id)
  WHERE proposal_id IS NOT NULL AND status NOT IN ('EXPIRED', 'SEND_FAILED', 'REJECTED', 'PARTIAL');

-- The meal page shows a refused bolus and its retry: commands of a meal (and retries) refresh the meals.
CREATE OR REPLACE FUNCTION remote_commands_notify_meals() RETURNS trigger AS $$
BEGIN
  IF NEW.meal_record_id IS NOT NULL OR NEW.follows_command_id IS NOT NULL THEN
    PERFORM glucomind_notify_event(NEW.patient_id, 'meals', NULL);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS remote_commands_meals_live_event ON remote_commands;
CREATE TRIGGER remote_commands_meals_live_event AFTER INSERT OR UPDATE ON remote_commands
  FOR EACH ROW EXECUTE FUNCTION remote_commands_notify_meals();
