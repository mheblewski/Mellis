-- Bolus cards in conversations (docs/product/remote-bolus-trio-plan.md W7): a dose the AI prepared for the caregiver.
-- The card holds the carbs, the dose computed by the server (carbs / ICR, rounded down to the pump step, or the
-- model's dose when it explains why), the meal it is for and the warnings at that moment. Nothing is sent from here:
-- the caregiver opens the card, can change the values, confirms and passes Face ID; the command then goes through
-- remote_commands (proposal_id), which allows one send per card.

CREATE TABLE IF NOT EXISTS bolus_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- The caregiver message the AI answered; the card is shown under that answer.
  user_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  carbs_g integer NOT NULL,
  insulin_u numeric(5, 2) NOT NULL,
  icr_g_per_u numeric(6, 2) NULL,
  icr_insulin_u numeric(5, 2) NULL,
  meal_payload jsonb NULL,
  reason text NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'PROPOSED',
  -- After this the card offers "Przelicz" instead of "Podaj bolus": glucose and IOB have moved on.
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bolus_proposals_purpose_check CHECK (purpose IN ('MEAL', 'CORRECTION', 'PRE_BOLUS')),
  CONSTRAINT bolus_proposals_status_check CHECK (status IN ('PROPOSED', 'DISCARDED')),
  CONSTRAINT bolus_proposals_amounts_check CHECK (carbs_g >= 0 AND carbs_g <= 300 AND insulin_u >= 0 AND insulin_u <= 30 AND (carbs_g > 0 OR insulin_u > 0)),
  CONSTRAINT bolus_proposals_meal_payload_check CHECK (meal_payload IS NULL OR jsonb_typeof(meal_payload) = 'object')
);

CREATE INDEX IF NOT EXISTS bolus_proposals_conversation_idx ON bolus_proposals (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS bolus_proposals_user_message_idx ON bolus_proposals (user_message_id);

DROP TRIGGER IF EXISTS bolus_proposals_live_event ON bolus_proposals;
CREATE TRIGGER bolus_proposals_live_event AFTER INSERT OR UPDATE OR DELETE ON bolus_proposals
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('conversation', 'conversation_id');

-- A command sent from a card changes the card (sent, started, meal saved): its conversation refreshes. Commands from
-- the Bolus tab have no conversation and refresh none.
CREATE OR REPLACE FUNCTION remote_commands_notify_conversation() RETURNS trigger AS $$
BEGIN
  IF NEW.conversation_id IS NOT NULL THEN
    PERFORM glucomind_notify_event(NEW.patient_id, 'conversation', NEW.conversation_id::text);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS remote_commands_conversation_live_event ON remote_commands;
CREATE TRIGGER remote_commands_conversation_live_event AFTER INSERT OR UPDATE ON remote_commands
  FOR EACH ROW EXECUTE FUNCTION remote_commands_notify_conversation();
