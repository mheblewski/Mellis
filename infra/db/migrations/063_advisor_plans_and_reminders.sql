-- The chat advises, the caregiver decides (owner decision 2026-10-22, docs/product/advisor-agent-plan.md).
--
-- 1. Later parts of a card (later-plan.v1): the caregiver's own plan, not the server's. planned_boluses gets what the
--    reminder waits for (trigger: AFTER_MINUTES, GLUCOSE_STOPPED_FALLING, GLUCOSE_RISING, GLUCOSE_ABOVE + threshold),
--    until when a glucose condition is waited for before the reminder comes anyway (wait_until), and how its dose is
--    computed when due (dose_carbs_g, drop_cover_g taken off, the card's insulin taken off, or a fixed dose). NULL
--    trigger: older plans (SPLIT after a time, DEFERRED_INSULIN when glucose stops falling). The split bounds of
--    split-bolus.v1 (50-95% now, 15-240 min) become recommendations: any share now, up to 24 h later.
-- 2. Simple reminders the chat sets (care_reminders): a note, at a time or on a glucose condition, pushed to every
--    caregiver; no dose, nothing sent to the loop.
-- 3. correction-up.v1 is gone: bolus_proposals.correction_up is dropped (a correction is computed only on request).
--    bolus_proposals.card_advice (card-advice.v1): what the card says about the caregiver's plan without changing it:
--    {risk {min_mgdl, min_in_minutes, level, baseline_min_mgdl}, correction {dose_u, breakdown, applied}, ...}.

ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS trigger text NULL;
ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS threshold_mgdl integer NULL;
ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS dose_carbs_g integer NULL;
ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS fixed_insulin_u numeric(5, 2) NULL;
ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS drop_cover_g integer NULL;
ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS subtract_first_insulin boolean NOT NULL DEFAULT false;
ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS wait_until timestamptz NULL;

ALTER TABLE planned_boluses DROP CONSTRAINT IF EXISTS planned_boluses_trigger_check;
ALTER TABLE planned_boluses ADD CONSTRAINT planned_boluses_trigger_check CHECK (
  (trigger IS NULL OR trigger IN ('AFTER_MINUTES', 'GLUCOSE_STOPPED_FALLING', 'GLUCOSE_RISING', 'GLUCOSE_ABOVE'))
  AND (trigger IS DISTINCT FROM 'GLUCOSE_ABOVE' OR threshold_mgdl BETWEEN 70 AND 400)
  AND (dose_carbs_g IS NULL OR dose_carbs_g BETWEEN 0 AND 300)
  AND (fixed_insulin_u IS NULL OR fixed_insulin_u BETWEEN 0 AND 30)
  AND (drop_cover_g IS NULL OR drop_cover_g >= 0)
);

ALTER TABLE planned_boluses DROP CONSTRAINT IF EXISTS planned_boluses_split_check;
ALTER TABLE planned_boluses ADD CONSTRAINT planned_boluses_split_check CHECK (
  (kind = 'SPLIT' AND now_percent BETWEEN 1 AND 99 AND delay_minutes BETWEEN 0 AND 1440)
  OR (kind = 'DEFERRED_INSULIN' AND now_percent = 100 AND delay_minutes BETWEEN 0 AND 1440)
);

CREATE TABLE IF NOT EXISTS care_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  conversation_id uuid NULL REFERENCES conversations(id) ON DELETE SET NULL,
  user_message_id text NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  note text NOT NULL,
  trigger text NOT NULL,
  -- AT_TIME: when; glucose triggers: checked from then on.
  due_at timestamptz NOT NULL,
  threshold_mgdl integer NULL,
  -- Glucose triggers: the reminder comes anyway then, saying the condition was not met.
  wait_until timestamptz NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  fired_at timestamptz NULL,
  -- READY (the condition was met or the time came) or FORCED (waited until wait_until).
  fired_reason text NULL,
  fired_glucose_mgdl integer NULL,
  cancelled_at timestamptz NULL,
  cancelled_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT care_reminders_note_check CHECK (char_length(note) BETWEEN 1 AND 300),
  CONSTRAINT care_reminders_trigger_check CHECK (
    trigger IN ('AT_TIME', 'GLUCOSE_STOPPED_FALLING', 'GLUCOSE_RISING', 'GLUCOSE_ABOVE', 'GLUCOSE_BELOW')
    AND (trigger NOT IN ('GLUCOSE_ABOVE', 'GLUCOSE_BELOW') OR threshold_mgdl BETWEEN 40 AND 400)
    AND (trigger = 'AT_TIME' OR wait_until IS NOT NULL)
  ),
  CONSTRAINT care_reminders_status_check CHECK (status IN ('ACTIVE', 'FIRED', 'CANCELLED')),
  CONSTRAINT care_reminders_fired_reason_check CHECK (fired_reason IS NULL OR fired_reason IN ('READY', 'FORCED'))
);

CREATE INDEX IF NOT EXISTS care_reminders_active_idx ON care_reminders (due_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS care_reminders_conversation_idx ON care_reminders (conversation_id, created_at);

-- Both phones see a reminder change at once (the chat card it came from).
CREATE OR REPLACE FUNCTION care_reminders_notify_change() RETURNS trigger AS $$
DECLARE
  row_data care_reminders;
BEGIN
  row_data := COALESCE(NEW, OLD);
  IF row_data.conversation_id IS NOT NULL THEN
    PERFORM glucomind_notify_event(row_data.patient_id, 'conversation', row_data.conversation_id::text);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS care_reminders_live_event ON care_reminders;
CREATE TRIGGER care_reminders_live_event AFTER INSERT OR UPDATE OR DELETE ON care_reminders
  FOR EACH ROW EXECUTE FUNCTION care_reminders_notify_change();

ALTER TABLE bolus_proposals DROP CONSTRAINT IF EXISTS bolus_proposals_correction_up_check;
ALTER TABLE bolus_proposals DROP COLUMN IF EXISTS correction_up;

ALTER TABLE bolus_proposals ADD COLUMN IF NOT EXISTS card_advice jsonb NULL;
ALTER TABLE bolus_proposals DROP CONSTRAINT IF EXISTS bolus_proposals_card_advice_check;
ALTER TABLE bolus_proposals ADD CONSTRAINT bolus_proposals_card_advice_check
  CHECK (card_advice IS NULL OR jsonb_typeof(card_advice) = 'object');
