-- Meal plan, slices 3d and 3e (owner 2026-11-05).
-- patient_notes ("Co Mellis pamięta"): what caregivers asked to remember about a patient, seen by all of them.
--   PLAN_RULE: how a place serves meals ("Podwieczorek jest zaraz po zupie"), applied when a plan is read.
--   FOOD: a food that often stays on the plate. It only suggests: a dose changes after a choice at the meal.
-- meal_plan_proposals: the rules a card offers to remember, and the remembered ones it applied.
-- meal_plan_entries: whether a bolus belongs to this meal, and whether the meal was eaten. Nothing here goes to the loop.
CREATE TABLE IF NOT EXISTS patient_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('PLAN_RULE', 'FOOD')),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 200),
  food_name text NULL,
  portion text NULL CHECK (portion IN ('NONE', 'HALF')),
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  removed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS patient_notes_one_text ON patient_notes (patient_id, kind, lower(text)) WHERE removed_at IS NULL;

ALTER TABLE meal_plan_proposals
  ADD COLUMN IF NOT EXISTS rules_to_remember jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS applied_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS rules_remembered_at timestamptz NULL;

ALTER TABLE meal_plan_entries
  ADD COLUMN IF NOT EXISTS dose_answer text NULL CHECK (dose_answer IN ('THIS_MEAL', 'OTHER')),
  ADD COLUMN IF NOT EXISTS dose_answered_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS eaten_asked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS eaten_asked_again_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS eaten_answer text NULL CHECK (eaten_answer IN ('YES', 'PART', 'NO', 'UNKNOWN')),
  ADD COLUMN IF NOT EXISTS eaten_answered_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS eaten_answered_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL;
