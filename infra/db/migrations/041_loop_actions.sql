-- Loop actions (loop-actions.v1): every action taken in the loop app (a carb entry and/or a manual bolus from the same
-- bolus calculator use) is one item the caregiver assigns by hand: a new meal, an add-on to a meal, WBT for a meal, a
-- correction (after a meal or on its own), a pre-bolus, hypo treatment or a mistake. Replaces the automatic joining of
-- carb entries into meals (new-meal-assignment.v1) for entries after loop_action_epochs.starts_at; earlier meals stay
-- as they are. Meals themselves are still meal_records (027): a NEW_MEAL assignment creates one, MEAL_ADDITION adds the
-- carb entry to an existing one. SMBs never become actions.

CREATE TABLE IF NOT EXISTS loop_action_epochs (
  patient_id uuid PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  -- Loop events that occurred and were first stored at/after this instant become actions.
  starts_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Starts now for every patient with active meal history.
INSERT INTO loop_action_epochs (patient_id, starts_at)
SELECT patient_id, now() FROM meal_history_epochs WHERE retired_at IS NULL
ON CONFLICT (patient_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS loop_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  -- Earliest member event.
  started_at timestamptz NOT NULL,
  -- NULL until the caregiver says what the action was for.
  purpose text NULL,
  -- The meal it belongs to: created by NEW_MEAL, the target of MEAL_ADDITION / WBT, optional for CORRECTION and
  -- PRE_BOLUS (the meal that followed).
  meal_record_id uuid NULL,
  assigned_by_user_id uuid NULL REFERENCES users(id),
  assigned_at timestamptz NULL,
  -- PENDING until the push "na co to było?" is sent (SENT) or not needed (SKIPPED: assigned first, or too old).
  push_status text NOT NULL DEFAULT 'PENDING',
  push_sent_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_actions_id_patient_unique UNIQUE (id, patient_id),
  -- A deleted meal leaves its corrections and pre-boluses without a meal (MEAL_ADDITION / WBT then fail the CHECK, so a
  -- meal with add-ons cannot be deleted).
  CONSTRAINT loop_actions_meal_fk FOREIGN KEY (meal_record_id, patient_id) REFERENCES meal_records(id, patient_id) ON DELETE SET NULL (meal_record_id),
  CONSTRAINT loop_actions_purpose_check CHECK (purpose IS NULL OR purpose IN ('NEW_MEAL', 'MEAL_ADDITION', 'WBT', 'CORRECTION', 'PRE_BOLUS', 'HYPO_TREATMENT', 'IGNORED')),
  CONSTRAINT loop_actions_meal_required CHECK (purpose IS NULL OR purpose NOT IN ('NEW_MEAL', 'MEAL_ADDITION', 'WBT') OR meal_record_id IS NOT NULL),
  CONSTRAINT loop_actions_assigned_check CHECK ((purpose IS NULL) = (assigned_at IS NULL)),
  CONSTRAINT loop_actions_push_status_check CHECK (push_status IN ('PENDING', 'SENT', 'SKIPPED'))
);

CREATE INDEX IF NOT EXISTS loop_actions_patient_started_idx ON loop_actions (patient_id, started_at);
CREATE INDEX IF NOT EXISTS loop_actions_meal_idx ON loop_actions (meal_record_id) WHERE meal_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS loop_actions_push_pending_idx ON loop_actions (created_at) WHERE push_status = 'PENDING';

-- At most one carb entry and one bolus per action; an event belongs to one action.
CREATE TABLE IF NOT EXISTS loop_action_events (
  patient_id uuid NOT NULL,
  event_id uuid NOT NULL,
  loop_action_id uuid NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT loop_action_events_pkey PRIMARY KEY (patient_id, event_id),
  CONSTRAINT loop_action_events_one_per_type UNIQUE (loop_action_id, event_type),
  CONSTRAINT loop_action_events_event_fk FOREIGN KEY (patient_id, event_id) REFERENCES events(patient_id, id) ON DELETE CASCADE,
  CONSTRAINT loop_action_events_action_fk FOREIGN KEY (loop_action_id, patient_id) REFERENCES loop_actions(id, patient_id) ON DELETE CASCADE,
  CONSTRAINT loop_action_events_type_check CHECK (event_type IN ('CARB_ENTRY', 'BOLUS'))
);

CREATE INDEX IF NOT EXISTS loop_action_events_action_idx ON loop_action_events (loop_action_id);
