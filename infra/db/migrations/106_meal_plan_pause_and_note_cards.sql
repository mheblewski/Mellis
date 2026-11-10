-- Meal plan, finishing touches (owner 2026-11-05).
-- meal_plan_entries.paused: skipped by "Bez przypomnień do…", so taking the pause back leaves meals skipped one by one alone.
-- patient_notes: a note the chat offers waits here unconfirmed, and nothing reads it until a caregiver confirms its card.
ALTER TABLE meal_plan_entries ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;
ALTER TABLE patient_notes
  ADD COLUMN IF NOT EXISTS proposed_user_message_id uuid NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz NULL;
UPDATE patient_notes SET confirmed_at = created_at WHERE confirmed_at IS NULL;
ALTER TABLE meal_plan_proposals ADD COLUMN IF NOT EXISTS unread jsonb NOT NULL DEFAULT '[]'::jsonb;
