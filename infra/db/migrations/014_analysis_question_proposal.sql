ALTER TABLE analyses
  ADD COLUMN IF NOT EXISTS question jsonb NULL,
  ADD COLUMN IF NOT EXISTS proposal jsonb NULL;
