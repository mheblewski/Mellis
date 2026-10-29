ALTER TABLE investigations
  ALTER COLUMN event_id DROP NOT NULL;

ALTER TABLE investigations
  ALTER COLUMN episode_id DROP NOT NULL;

ALTER TABLE investigations
  ALTER COLUMN trigger_id DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'investigations'::regclass
      AND conname = 'investigations_event_family_check'
  ) THEN
    ALTER TABLE investigations DROP CONSTRAINT investigations_event_family_check;
  END IF;
END
$$;

ALTER TABLE investigations
  ADD CONSTRAINT investigations_event_family_check
  CHECK (event_family IN ('HYPO', 'USER'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'investigations'::regclass
      AND conname = 'investigations_event_patient_fk'
  ) THEN
    ALTER TABLE investigations DROP CONSTRAINT investigations_event_patient_fk;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'investigations'::regclass
      AND conname = 'investigations_episode_event_patient_fk'
  ) THEN
    ALTER TABLE investigations DROP CONSTRAINT investigations_episode_event_patient_fk;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'investigations'::regclass
      AND conname = 'investigations_trigger_episode_event_patient_fk'
  ) THEN
    ALTER TABLE investigations DROP CONSTRAINT investigations_trigger_episode_event_patient_fk;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'investigations'::regclass
      AND conname = 'investigations_conversation_episode_patient_fk'
  ) THEN
    ALTER TABLE investigations DROP CONSTRAINT investigations_conversation_episode_patient_fk;
  END IF;
END
$$;

ALTER TABLE investigations
  ADD CONSTRAINT investigations_conversation_patient_fk
  FOREIGN KEY (conversation_id, patient_id)
  REFERENCES conversations(id, patient_id)
  ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'investigations'::regclass
      AND conname = 'investigations_patient_conversation_unique'
  ) THEN
    ALTER TABLE investigations
      ADD CONSTRAINT investigations_patient_conversation_unique UNIQUE (patient_id, conversation_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS investigations_patient_conversation_idx
  ON investigations (patient_id, conversation_id);
