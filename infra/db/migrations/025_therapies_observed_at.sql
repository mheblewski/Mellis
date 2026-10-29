-- 001_init.sql gained therapies.observed_at after it had already been applied. The migrator skips
-- applied versions, so databases initialised before that edit never received the column and
-- therapy profile imports fail (42703). Add it forward-only; a no-op where 001 already created it.
--
-- No backfill: observed_at is the time the profile was observed in Nightscout, which is unknown for
-- existing rows. The therapy resolver orders NULLs last, and the next profile import sets the value.
ALTER TABLE therapies
  ADD COLUMN IF NOT EXISTS observed_at timestamptz NULL;
