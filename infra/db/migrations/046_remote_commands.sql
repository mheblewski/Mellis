-- Remote commands to the patient's Trio (docs/product/remote-bolus-trio-plan.md §4): one row per meal or bolus a
-- caregiver confirmed. The server authorizes the command (switches, safety checks, one command at a time), the phone
-- sends it to Trio and reports APNs's and Trio's answers, the worker matches the loop's carb entry and bolus from
-- Nightscout and creates the meal. No secret is stored: the Trio shared secret and APNs keys stay on the phone.

CREATE TABLE IF NOT EXISTS remote_commands (
  -- Also the command_id sent to Trio.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  device_id text NOT NULL,
  source text NOT NULL,
  -- Where the values came from: a chat card (proposal) in a conversation, or none (the Bolus tab).
  conversation_id uuid NULL REFERENCES conversations(id) ON DELETE SET NULL,
  proposal_id uuid NULL,
  carbs_g integer NOT NULL,
  insulin_u numeric(5, 2) NOT NULL,
  bolus_step numeric(4, 2) NOT NULL,
  icr_g_per_u numeric(6, 2) NULL,
  icr_insulin_u numeric(5, 2) NULL,
  -- The meal the carbs are for (description, items, macros); the meal record is created from it when the loop's
  -- carb entry arrives. Null for a bolus without carbs.
  meal_payload jsonb NULL,
  -- Glucose, IOB, COB and last bolus the caregiver saw when confirming, and the warnings they acknowledged.
  context jsonb NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy_version text NOT NULL,
  status text NOT NULL DEFAULT 'AUTHORIZED',
  -- APNs's refusal or Trio's last answer, as received (the app shows the Polish text in status_message).
  trio_message text NULL,
  status_message text NULL,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  send_deadline timestamptz NOT NULL,
  sent_at timestamptz NULL,
  answered_at timestamptz NULL,
  -- The loop action (carb entry and/or bolus in Nightscout) the command produced, and the meal created from it.
  loop_action_id uuid NULL REFERENCES loop_actions(id) ON DELETE SET NULL,
  meal_record_id uuid NULL REFERENCES meal_records(id) ON DELETE SET NULL,
  matched_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT remote_commands_source_check CHECK (source IN ('BOLUS_SCREEN', 'CHAT_CARD', 'NEW_MEAL')),
  CONSTRAINT remote_commands_status_check CHECK (status IN (
    'AUTHORIZED', 'EXPIRED', 'SENT', 'SEND_FAILED', 'TRIO_ACCEPTED', 'SUCCEEDED', 'PARTIAL', 'REJECTED', 'NO_REPLY'
  )),
  CONSTRAINT remote_commands_amounts_check CHECK (carbs_g >= 0 AND carbs_g <= 300 AND insulin_u >= 0 AND insulin_u <= 30 AND (carbs_g > 0 OR insulin_u > 0)),
  CONSTRAINT remote_commands_meal_payload_check CHECK (meal_payload IS NULL OR jsonb_typeof(meal_payload) = 'object')
);

-- One command of a patient at a time waits for Trio: a second caregiver (or a double tap) cannot send another.
CREATE UNIQUE INDEX IF NOT EXISTS remote_commands_one_in_flight_idx ON remote_commands (patient_id)
  WHERE status IN ('AUTHORIZED', 'SENT', 'TRIO_ACCEPTED');
-- A chat card gives one dose: its proposal can be sent once (a failed or expired send can be retried).
CREATE UNIQUE INDEX IF NOT EXISTS remote_commands_one_per_proposal_idx ON remote_commands (proposal_id)
  WHERE proposal_id IS NOT NULL AND status NOT IN ('EXPIRED', 'SEND_FAILED');
CREATE INDEX IF NOT EXISTS remote_commands_patient_idx ON remote_commands (patient_id, authorized_at DESC);
CREATE INDEX IF NOT EXISTS remote_commands_unmatched_idx ON remote_commands (patient_id, authorized_at)
  WHERE loop_action_id IS NULL AND status IN ('SENT', 'TRIO_ACCEPTED', 'SUCCEEDED', 'PARTIAL', 'NO_REPLY');

-- Both phones see a command's progress at once (the Bolus tab, a chat card).
DROP TRIGGER IF EXISTS remote_commands_live_event ON remote_commands;
CREATE TRIGGER remote_commands_live_event AFTER INSERT OR UPDATE ON remote_commands
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('remote_command', 'id');
