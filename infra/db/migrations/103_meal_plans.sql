-- Meal plan (meal-plan.v1, owner 2026-11-05): meals known ahead from a menu or a timetable, with a push before each.
-- Kept apart from meal_records and events on purpose: nothing that reads meals sees a meal that has not happened.
--
-- meal_plans: one per added plan; lead_minutes is the reminder's lead, shared by all phones.
-- meal_plan_entries: a MEAL or a MOVEMENT at planned_at. status PLANNED, SKIPPED ("Pomiń ten obiad") or REMOVED.
--   reminder_sent_at and missed_sent_at are compare-and-set claims, so two workers never send twice.
-- patient_devices.meal_plan_push_enabled: the switch "Przed posiłkami", per phone, on by default.

CREATE TABLE IF NOT EXISTS meal_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  created_by_user_id uuid NULL,
  lead_minutes integer NOT NULL DEFAULT 20 CHECK (lead_minutes BETWEEN 5 AND 60),
  removed_at timestamptz NULL,
  removed_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meal_plan_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('MEAL', 'MOVEMENT')),
  title text NOT NULL,
  planned_at timestamptz NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'SKIPPED', 'REMOVED')),
  changed_by_user_id uuid NULL,
  reminder_sent_at timestamptz NULL,
  missed_sent_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meal_plan_entries_patient_time ON meal_plan_entries (patient_id, planned_at);
CREATE INDEX IF NOT EXISTS meal_plan_entries_due ON meal_plan_entries (planned_at) WHERE status = 'PLANNED' AND kind = 'MEAL';

ALTER TABLE patient_devices ADD COLUMN IF NOT EXISTS meal_plan_push_enabled boolean NOT NULL DEFAULT true;

DROP TRIGGER IF EXISTS meal_plan_entries_live_event ON meal_plan_entries;
CREATE TRIGGER meal_plan_entries_live_event AFTER INSERT OR UPDATE OR DELETE ON meal_plan_entries
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('meals');
