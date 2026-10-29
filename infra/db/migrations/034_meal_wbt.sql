-- WBT (fat-protein units) follow-up of a meal: a reminder 2.5 h after the meal to give insulin for its protein and fat,
-- and the AI dose suggestions asked for it.
CREATE TABLE IF NOT EXISTS meal_wbt_reminders (
  patient_id uuid NOT NULL,
  meal_record_id uuid NOT NULL,
  enabled boolean NOT NULL,
  -- AUTO: set from the meal's macros (thresholds); MANUAL: the caregiver's choice, never overwritten by AUTO.
  source text NOT NULL,
  remind_at timestamptz NOT NULL,
  -- SCHEDULED until due; then SENT, or SKIPPED (WBT carbs already logged, or too late to remind).
  status text NOT NULL DEFAULT 'SCHEDULED',
  sent_at timestamptz NULL,
  set_by_user_id uuid NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_wbt_reminders_pkey PRIMARY KEY (patient_id, meal_record_id),
  CONSTRAINT meal_wbt_reminders_record_fk FOREIGN KEY (meal_record_id, patient_id) REFERENCES meal_records(id, patient_id) ON DELETE CASCADE,
  CONSTRAINT meal_wbt_reminders_source_check CHECK (source IN ('AUTO', 'MANUAL')),
  CONSTRAINT meal_wbt_reminders_status_check CHECK (status IN ('SCHEDULED', 'SENT', 'SKIPPED'))
);

CREATE INDEX IF NOT EXISTS meal_wbt_reminders_due_idx ON meal_wbt_reminders (remind_at) WHERE enabled AND status = 'SCHEDULED';

CREATE TABLE IF NOT EXISTS meal_wbt_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL,
  meal_record_id uuid NOT NULL,
  -- PENDING while the AI answers (job meal.wbt_suggestion), then DONE or FAILED.
  status text NOT NULL DEFAULT 'PENDING',
  result jsonb NULL,
  requested_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_wbt_suggestions_record_fk FOREIGN KEY (meal_record_id, patient_id) REFERENCES meal_records(id, patient_id) ON DELETE CASCADE,
  CONSTRAINT meal_wbt_suggestions_status_check CHECK (status IN ('PENDING', 'DONE', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS meal_wbt_suggestions_record_idx ON meal_wbt_suggestions (meal_record_id, created_at DESC);
