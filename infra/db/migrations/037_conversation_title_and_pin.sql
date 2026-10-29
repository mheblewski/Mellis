-- A conversation's name in the history list and its pin, shared by all caregivers of the patient (like deletion, 029).
-- title: written by the AI with the first answer (title_source AI) or by a caregiver (USER); a caregiver's name is never
-- replaced by the AI. NULL keeps the old fallback (the first question, or a name from the trigger).
-- pinned_at: pinned conversations are listed first, most recently pinned on top.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS title text NULL,
  ADD COLUMN IF NOT EXISTS title_source text NULL,
  ADD COLUMN IF NOT EXISTS title_updated_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS pinned_by_user_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_title_source_check') THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_title_source_check CHECK (title_source IS NULL OR title_source IN ('AI', 'USER'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS conversations_patient_pinned_idx
  ON conversations (patient_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;
