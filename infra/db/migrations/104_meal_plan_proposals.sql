-- A plan read in chat waits here until a caregiver confirms its card (meal-plan.v1, slice 3c). Nothing reaches
-- meal_plan_entries, and no push is sent, before that.
CREATE TABLE IF NOT EXISTS meal_plan_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  user_message_id uuid NOT NULL,
  lead_minutes integer NOT NULL,
  macros_source text NOT NULL CHECK (macros_source IN ('FILE', 'ESTIMATED', 'NONE')),
  entries jsonb NOT NULL,
  times_to_check jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'ACCEPTED', 'SUPERSEDED', 'DISCARDED')),
  plan_id uuid NULL REFERENCES meal_plans(id) ON DELETE SET NULL,
  accepted_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz NULL,
  skipped_past integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meal_plan_proposals_conversation_idx ON meal_plan_proposals (patient_id, conversation_id, created_at);
