-- Split meal boluses (docs/product/split-bolus-plan.md): for a meal high in fat or protein the chat card gives part of
-- the meal's carbs and their insulin now and plans the rest for later (e.g. 70% now, 30% after 60 min). The carbs are
-- split too: Trio's SMBs would cover carbs entered at once, so the deferred carbs go to Trio only with the second part,
-- whose dose is recomputed at that time (deferred carbs / ICR valid then, minus what the loop added above basal).
--
-- bolus_proposals.split: the card's split as the server computed it ({now_percent, later_after_minutes, total_carbs_g,
-- total_insulin_u, later_carbs_g, later_insulin_u}); remote_commands.split_plan copies it when the first part is sent.
-- planned_boluses: one row per planned second part, created when the first part's meal is saved. The worker pushes
-- a reminder to every caregiver at due_at; either caregiver gives it (a remote command with planned_bolus_id, one per
-- plan) or skips it; a manual bolus assigned to the meal as an addition settles it too.

ALTER TABLE bolus_proposals ADD COLUMN IF NOT EXISTS split jsonb NULL;
ALTER TABLE bolus_proposals DROP CONSTRAINT IF EXISTS bolus_proposals_split_check;
ALTER TABLE bolus_proposals ADD CONSTRAINT bolus_proposals_split_check CHECK (split IS NULL OR jsonb_typeof(split) = 'object');

ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS split_plan jsonb NULL;

CREATE TABLE IF NOT EXISTS planned_boluses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  meal_record_id uuid NOT NULL REFERENCES meal_records(id) ON DELETE CASCADE,
  -- Where the plan came from: the chat card and the command that gave the first part.
  proposal_id uuid NULL REFERENCES bolus_proposals(id) ON DELETE SET NULL,
  conversation_id uuid NULL REFERENCES conversations(id) ON DELETE SET NULL,
  first_command_id uuid NULL REFERENCES remote_commands(id) ON DELETE SET NULL,
  first_carbs_g integer NOT NULL,
  first_insulin_u numeric(5, 2) NOT NULL,
  -- The deferred carbs and the dose estimated for them when the card was made (recomputed when due).
  carbs_g integer NOT NULL,
  planned_insulin_u numeric(5, 2) NOT NULL,
  icr_g_per_u numeric(6, 2) NULL,
  now_percent integer NOT NULL,
  delay_minutes integer NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED',
  notified_at timestamptz NULL,
  -- Who gave or skipped it and when; the command or loop action that gave it.
  resolved_at timestamptz NULL,
  resolved_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  given_command_id uuid NULL REFERENCES remote_commands(id) ON DELETE SET NULL,
  given_loop_action_id uuid NULL REFERENCES loop_actions(id) ON DELETE SET NULL,
  given_insulin_u numeric(5, 2) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT planned_boluses_status_check CHECK (status IN ('SCHEDULED', 'NOTIFIED', 'GIVEN', 'SKIPPED', 'EXPIRED', 'CANCELLED')),
  CONSTRAINT planned_boluses_amounts_check CHECK (carbs_g > 0 AND carbs_g <= 300 AND planned_insulin_u >= 0 AND planned_insulin_u <= 30),
  CONSTRAINT planned_boluses_split_check CHECK (now_percent BETWEEN 50 AND 95 AND delay_minutes BETWEEN 15 AND 240)
);

-- One open plan per meal (a second card for the same meal replaces nothing: it is refused).
CREATE UNIQUE INDEX IF NOT EXISTS planned_boluses_one_open_per_meal_idx ON planned_boluses (meal_record_id)
  WHERE status IN ('SCHEDULED', 'NOTIFIED');
CREATE UNIQUE INDEX IF NOT EXISTS planned_boluses_first_command_idx ON planned_boluses (first_command_id) WHERE first_command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS planned_boluses_due_idx ON planned_boluses (due_at) WHERE status IN ('SCHEDULED', 'NOTIFIED');
CREATE INDEX IF NOT EXISTS planned_boluses_proposal_idx ON planned_boluses (proposal_id) WHERE proposal_id IS NOT NULL;

-- The second part is sent like the WBT window's dose: a command with its own purpose for the meal it belongs to.
ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS planned_bolus_id uuid NULL REFERENCES planned_boluses(id) ON DELETE SET NULL;

ALTER TABLE remote_commands DROP CONSTRAINT IF EXISTS remote_commands_purpose_check;
ALTER TABLE remote_commands ADD CONSTRAINT remote_commands_purpose_check CHECK (
  (purpose IS NULL AND target_meal_record_id IS NULL AND planned_bolus_id IS NULL)
  OR (purpose = 'WBT' AND target_meal_record_id IS NOT NULL AND planned_bolus_id IS NULL)
  OR (purpose = 'MEAL_PART' AND target_meal_record_id IS NOT NULL AND planned_bolus_id IS NOT NULL)
);

ALTER TABLE remote_commands DROP CONSTRAINT IF EXISTS remote_commands_source_check;
ALTER TABLE remote_commands ADD CONSTRAINT remote_commands_source_check CHECK (source IN ('BOLUS_SCREEN', 'CHAT_CARD', 'NEW_MEAL', 'WBT_SCREEN', 'PLANNED_BOLUS'));

-- A planned part is given once (a failed, expired or refused send can be retried).
CREATE UNIQUE INDEX IF NOT EXISTS remote_commands_one_per_planned_bolus_idx ON remote_commands (planned_bolus_id)
  WHERE planned_bolus_id IS NOT NULL AND status NOT IN ('EXPIRED', 'SEND_FAILED', 'REJECTED', 'PARTIAL');

-- Both phones see a plan change at once: the meal page and its card, the meals list, the chat card it came from.
CREATE OR REPLACE FUNCTION planned_boluses_notify_change() RETURNS trigger AS $$
DECLARE
  row_data planned_boluses;
BEGIN
  row_data := COALESCE(NEW, OLD);
  PERFORM glucomind_notify_event(row_data.patient_id, 'meal', row_data.meal_record_id::text);
  PERFORM glucomind_notify_event(row_data.patient_id, 'meals', NULL);
  IF row_data.conversation_id IS NOT NULL THEN
    PERFORM glucomind_notify_event(row_data.patient_id, 'conversation', row_data.conversation_id::text);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS planned_boluses_live_event ON planned_boluses;
CREATE TRIGGER planned_boluses_live_event AFTER INSERT OR UPDATE OR DELETE ON planned_boluses
  FOR EACH ROW EXECUTE FUNCTION planned_boluses_notify_change();

-- A command for a planned part refreshes its meal (the card's button disappears on the other phone while it is sent).
CREATE OR REPLACE FUNCTION remote_commands_notify_meals() RETURNS trigger AS $$
BEGIN
  IF NEW.meal_record_id IS NOT NULL OR NEW.follows_command_id IS NOT NULL OR NEW.planned_bolus_id IS NOT NULL THEN
    PERFORM glucomind_notify_event(NEW.patient_id, 'meals', NULL);
  END IF;
  IF NEW.planned_bolus_id IS NOT NULL AND NEW.target_meal_record_id IS NOT NULL THEN
    PERFORM glucomind_notify_event(NEW.patient_id, 'meal', NEW.target_meal_record_id::text);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
