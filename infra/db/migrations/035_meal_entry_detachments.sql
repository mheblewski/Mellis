-- Carb entries taken out of a meal they had joined (new meal history, 027). A later entry joins a nearby meal
-- automatically; when that meal turns out not to be a meal (its first entry is marked as correction carbs, hypo
-- treatment, WBT or deleted) or the caregiver says the entry was a separate meal, its membership row is removed and the
-- entry starts its own meal (to_meal_identity) when it can. Removing the membership is the only change to
-- meal_record_entries outside intake; this log keeps it auditable and stops intake from assigning the entry again.
CREATE TABLE IF NOT EXISTS meal_record_entry_detachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL,
  event_id uuid NOT NULL,
  from_meal_identity text NOT NULL,
  -- NULL when the entry could not start a meal (not LIVE, or the meal's epoch is no longer active).
  to_meal_identity text NULL,
  -- CAREGIVER: detached by hand; ANCHOR_NOT_A_MEAL: the meal's first entry was marked as something other than a meal.
  reason text NOT NULL,
  detached_by_user_id uuid NULL,
  detached_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_record_entry_detachments_event_fk FOREIGN KEY (patient_id, event_id) REFERENCES events(patient_id, id) ON DELETE CASCADE,
  CONSTRAINT meal_record_entry_detachments_reason_check CHECK (reason IN ('CAREGIVER', 'ANCHOR_NOT_A_MEAL'))
);

CREATE INDEX IF NOT EXISTS meal_record_entry_detachments_event_idx ON meal_record_entry_detachments (patient_id, event_id);
