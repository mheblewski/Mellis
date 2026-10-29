-- Reminders set with a dose from the Bolus tab (bolus-reminders.v1, owner decision 2026-10-25). The Meals tab shows
-- only meals from the chat and the Bolus tab's doses that have a reminder; "Przypomnij" next to the dose sets them:
--  * WBT at +150 min (the meal's WBT reminder), even though such a meal has no macros;
--  * SECOND_DOSE: a care reminder of the meal, when glucose starts rising (watched 60 min, then it lapses quietly) or
--    after some minutes. It never computes a dose: there is nothing to compute it from.
-- remote_commands.reminders keeps what the caregiver asked for until the loop's entries arrive and the meal exists.

-- The array the app sends: [{kind: WBT} | {kind: SECOND_DOSE, trigger: GLUCOSE_RISING} |
-- {kind: SECOND_DOSE, trigger: AFTER_MINUTES, minutes: 5-240}], at most one of each kind.
CREATE OR REPLACE FUNCTION glucomind_valid_bolus_reminders(value jsonb) RETURNS boolean AS $$
DECLARE
  item jsonb;
  wbt integer := 0;
  second_dose integer := 0;
  minutes numeric;
BEGIN
  IF value IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) NOT BETWEEN 1 AND 2 THEN
    RETURN false;
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
    IF jsonb_typeof(item) <> 'object' THEN
      RETURN false;
    END IF;
    IF item = '{"kind": "WBT"}'::jsonb THEN
      wbt := wbt + 1;
    ELSIF item = '{"kind": "SECOND_DOSE", "trigger": "GLUCOSE_RISING"}'::jsonb THEN
      second_dose := second_dose + 1;
    ELSIF item->>'kind' = 'SECOND_DOSE' AND item->>'trigger' = 'AFTER_MINUTES' AND jsonb_typeof(item->'minutes') = 'number'
      AND (item - 'kind' - 'trigger' - 'minutes') = '{}'::jsonb THEN
      minutes := (item->>'minutes')::numeric;
      IF minutes <> trunc(minutes) OR minutes NOT BETWEEN 5 AND 240 THEN
        RETURN false;
      END IF;
      second_dose := second_dose + 1;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN wbt <= 1 AND second_dose <= 1;
END
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS reminders jsonb NULL;
ALTER TABLE remote_commands DROP CONSTRAINT IF EXISTS remote_commands_reminders_check;
ALTER TABLE remote_commands ADD CONSTRAINT remote_commands_reminders_check CHECK (
  reminders IS NULL OR (source = 'BOLUS_SCREEN' AND glucomind_valid_bolus_reminders(reminders))
);

-- A care reminder of a meal (SECOND_DOSE); the chat's own reminders keep kind NULL and no meal.
ALTER TABLE care_reminders ADD COLUMN IF NOT EXISTS meal_record_id uuid NULL REFERENCES meal_records(id) ON DELETE CASCADE;
ALTER TABLE care_reminders ADD COLUMN IF NOT EXISTS kind text NULL;
ALTER TABLE care_reminders DROP CONSTRAINT IF EXISTS care_reminders_kind_check;
ALTER TABLE care_reminders ADD CONSTRAINT care_reminders_kind_check CHECK (
  (kind IS NULL OR kind = 'SECOND_DOSE') AND (kind IS NULL OR meal_record_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS care_reminders_meal_idx ON care_reminders (meal_record_id) WHERE meal_record_id IS NOT NULL;
-- One second dose per meal: the worker creating it twice (a retry after a failed link) keeps the first.
CREATE UNIQUE INDEX IF NOT EXISTS care_reminders_second_dose_meal_idx ON care_reminders (meal_record_id) WHERE kind = 'SECOND_DOSE';

-- Description search of the Meals tab: case and Polish diacritics folded (no unaccent extension on the server).
CREATE OR REPLACE FUNCTION glucomind_fold_text(value text) RETURNS text AS $$
  SELECT lower(translate(value, 'ąćęłńóśźżĄĆĘŁŃÓŚŹŻ', 'acelnoszzACELNOSZZ'));
$$ LANGUAGE sql IMMUTABLE;

-- Both phones see a reminder change at once: the chat card it came from, and now the meal it belongs to (its page and
-- the Meals tab's list and header).
CREATE OR REPLACE FUNCTION care_reminders_notify_change() RETURNS trigger AS $$
DECLARE
  row_data care_reminders;
BEGIN
  row_data := COALESCE(NEW, OLD);
  IF row_data.conversation_id IS NOT NULL THEN
    PERFORM glucomind_notify_event(row_data.patient_id, 'conversation', row_data.conversation_id::text);
  END IF;
  IF row_data.meal_record_id IS NOT NULL THEN
    PERFORM glucomind_notify_event(row_data.patient_id, 'meal', row_data.meal_record_id::text);
    PERFORM glucomind_notify_event(row_data.patient_id, 'meals', NULL);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
