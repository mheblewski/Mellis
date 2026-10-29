ALTER TABLE conversations
  ALTER COLUMN episode_id DROP NOT NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS origin text;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS trigger_type text;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS trigger_id uuid REFERENCES triggers(id) ON DELETE SET NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS client_request_id text;

UPDATE conversations c
SET origin = CASE
  WHEN c.conversation_type = 'TRIGGER_INITIATED' THEN 'SYSTEM'
  ELSE 'USER'
END
WHERE c.origin IS NULL;

UPDATE conversations c
SET trigger_type = t.type,
    trigger_id = t.id
FROM triggers t
WHERE c.trigger_type IS NULL
  AND c.episode_id = t.episode_id;

ALTER TABLE conversations
  ALTER COLUMN origin SET DEFAULT 'SYSTEM';

ALTER TABLE conversations
  ALTER COLUMN origin SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'conversations_origin_check'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_origin_check
      CHECK (origin IN ('SYSTEM', 'USER'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'conversations_patient_client_request_unique'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_patient_client_request_unique UNIQUE (patient_id, client_request_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS conversations_patient_updated_idx
  ON conversations (patient_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS conversations_trigger_id_idx
  ON conversations (trigger_id)
  WHERE trigger_id IS NOT NULL;
