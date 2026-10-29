-- Meal segmentation v1: obsolete meal candidates/cases are superseded, never deleted.
-- Additive only: extends the status/state CHECK lists and adds nullable audit columns.
-- Consumers that select active meals (historical context, pattern membership) filter on
-- RECONSTRUCTED/PARTIAL and therefore exclude SUPERSEDED rows without further changes.

ALTER TABLE meal_candidates DROP CONSTRAINT IF EXISTS meal_candidates_status_check;
ALTER TABLE meal_candidates ADD CONSTRAINT meal_candidates_status_check
  CHECK (status IN ('CANDIDATE', 'SUPPORTED', 'REJECTED', 'MERGED', 'DUPLICATE', 'SUPERSEDED'));

ALTER TABLE meal_candidates
  ADD COLUMN IF NOT EXISTS segmentation_policy_version text NULL,
  ADD COLUMN IF NOT EXISTS superseded_by_identities jsonb NULL,
  ADD COLUMN IF NOT EXISTS superseded_reason text NULL,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz NULL;

ALTER TABLE meal_cases DROP CONSTRAINT IF EXISTS meal_cases_state_check;
ALTER TABLE meal_cases ADD CONSTRAINT meal_cases_state_check
  CHECK (state IN ('RECONSTRUCTING', 'RECONSTRUCTED', 'PARTIAL', 'INVALIDATED', 'SUPERSEDED'));

ALTER TABLE meal_cases
  ADD COLUMN IF NOT EXISTS superseded_by_identities jsonb NULL,
  ADD COLUMN IF NOT EXISTS superseded_reason text NULL,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz NULL;
