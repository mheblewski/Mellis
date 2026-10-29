-- New meal history (meal-history-epoch.v1, new-meal-assignment.v1, meal-description-prompt.v1, meal-record-trust.v1).
-- Additive only. Independent of 026_meal_supersession.sql; never reads or writes meal_candidates/meal_cases.
-- Creates no epoch: without a row in meal_history_epochs the new meal history stays inactive for every patient.
--
-- Invariants enforced here rather than only in application code:
-- * an epoch's boundary and rules are immutable; one active epoch per patient;
-- * a meal starts only from a LIVE CARB_ENTRY that occurred and was first stored at/after the active epoch start;
-- * a meal's identity is derived from (policy, epoch, anchor event) and never changes;
-- * every meal contains its anchor entry (deferred FK); an event belongs to at most one meal; memberships are immutable;
-- * a prompt exists only for a meal whose recorded decision was CREATE_PROMPT, never for a chained meal or while
--   prompts are disabled, at most one per meal, triggered by an entry of that meal;
-- * trusted statuses require a caregiver action; every change of trust-relevant fields is kept in revisions.

CREATE TABLE IF NOT EXISTS meal_history_epochs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  prompts_enabled_from timestamptz NULL,
  -- SHADOW records prompt decisions only; SEND leaves prompts PENDING for a dispatcher (none exists yet).
  prompt_delivery_mode text NOT NULL DEFAULT 'SHADOW',
  assignment_policy_version text NOT NULL,
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  note text NULL,
  retired_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_history_epochs_id_patient_unique UNIQUE (id, patient_id),
  CONSTRAINT meal_history_epochs_id_patient_policy_unique UNIQUE (id, patient_id, assignment_policy_version),
  CONSTRAINT meal_history_epochs_prompts_after_start CHECK (prompts_enabled_from IS NULL OR prompts_enabled_from >= starts_at),
  CONSTRAINT meal_history_epochs_delivery_mode_check CHECK (prompt_delivery_mode IN ('SHADOW', 'SEND'))
);

CREATE UNIQUE INDEX IF NOT EXISTS meal_history_epochs_one_active_per_patient
  ON meal_history_epochs (patient_id)
  WHERE retired_at IS NULL;

-- Only prompts_enabled_from and prompt_delivery_mode may change, and an active epoch may be retired once. Any other change
-- requires retiring the epoch and recording a new one.
CREATE OR REPLACE FUNCTION meal_history_epochs_guard_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id
    OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
    OR NEW.assignment_policy_version IS DISTINCT FROM OLD.assignment_policy_version
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    RAISE EXCEPTION 'MEAL_HISTORY_EPOCH_IMMUTABLE: retire epoch % and record a new one', OLD.id;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meal_history_epochs_guard_immutable ON meal_history_epochs;
CREATE TRIGGER meal_history_epochs_guard_immutable
  BEFORE UPDATE ON meal_history_epochs
  FOR EACH ROW EXECUTE FUNCTION meal_history_epochs_guard_immutable();

CREATE TABLE IF NOT EXISTS meal_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  -- meal:<assignment_policy_version>:<epoch_id>:<anchor_event_id>; fixed when the meal starts.
  meal_identity text NOT NULL,
  epoch_id uuid NOT NULL,
  assignment_policy_version text NOT NULL,
  anchor_event_id uuid NOT NULL,
  chained_to_meal_record_id uuid NULL,
  status text NOT NULL DEFAULT 'AWAITING_DESCRIPTION',
  description text NULL,
  photo_ref text NULL,
  -- Unconfirmed AI proposal ({proposal_id, carbs_g, protein_g, fat_g, ai_execution_id, proposed_at,
  -- based_on: {description, photo_ref}}); never read as fact.
  proposal jsonb NULL,
  -- Caregiver-confirmed values ({carbs|protein|fat: {grams, origin}}); only written by a caregiver action.
  confirmed_macros jsonb NULL,
  confirmed_by uuid NULL REFERENCES users(id),
  confirmed_at timestamptz NULL,
  -- Prompt decision taken when the meal started (CREATE_PROMPT or SKIP with reason), for audit.
  prompt_decision jsonb NOT NULL,
  -- Previous values of status/description/photo/proposal/confirmation, appended by trigger on every change.
  revisions jsonb NOT NULL DEFAULT '[]'::jsonb,
  trust_policy_version text NOT NULL DEFAULT 'meal-record-trust.v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_records_identity_unique UNIQUE (patient_id, meal_identity),
  CONSTRAINT meal_records_anchor_unique UNIQUE (patient_id, anchor_event_id),
  CONSTRAINT meal_records_id_patient_unique UNIQUE (id, patient_id),
  CONSTRAINT meal_records_id_patient_epoch_unique UNIQUE (id, patient_id, epoch_id),
  CONSTRAINT meal_records_id_patient_epoch_anchor_unique UNIQUE (id, patient_id, epoch_id, anchor_event_id),
  CONSTRAINT meal_records_epoch_fk FOREIGN KEY (epoch_id, patient_id, assignment_policy_version)
    REFERENCES meal_history_epochs(id, patient_id, assignment_policy_version),
  -- Like every reference to events in this schema, deleting the source event (only ever via patient deletion)
  -- removes the derived meal; NO ACTION would block the patient cascade.
  CONSTRAINT meal_records_anchor_event_fk FOREIGN KEY (patient_id, anchor_event_id) REFERENCES events(patient_id, id) ON DELETE CASCADE,
  -- A chained meal continues a meal of the same patient and epoch.
  CONSTRAINT meal_records_chained_fk FOREIGN KEY (chained_to_meal_record_id, patient_id, epoch_id)
    REFERENCES meal_records(id, patient_id, epoch_id) ON DELETE CASCADE,
  CONSTRAINT meal_records_not_chained_to_self CHECK (chained_to_meal_record_id IS NULL OR chained_to_meal_record_id <> id),
  CONSTRAINT meal_records_identity_derived CHECK (
    meal_identity = 'meal:' || assignment_policy_version || ':' || epoch_id::text || ':' || anchor_event_id::text
  ),
  CONSTRAINT meal_records_status_check CHECK (status IN ('AWAITING_DESCRIPTION', 'DESCRIBED', 'AI_PROPOSED', 'CONFIRMED', 'CORRECTED', 'CANCELLED', 'INCOMPLETE')),
  CONSTRAINT meal_records_proposal_present CHECK (status <> 'AI_PROPOSED' OR proposal ? 'proposal_id'),
  -- Trusted statuses only with a recorded caregiver action. A later CANCELLED keeps the confirmation for audit.
  CONSTRAINT meal_records_trusted_requires_caregiver CHECK (
    status NOT IN ('CONFIRMED', 'CORRECTED') OR (confirmed_macros IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
  ),
  CONSTRAINT meal_records_prompt_decision_check CHECK (prompt_decision->>'decision' IN ('CREATE_PROMPT', 'SKIP')),
  CONSTRAINT meal_records_revisions_array CHECK (jsonb_typeof(revisions) = 'array')
);

CREATE INDEX IF NOT EXISTS meal_records_patient_epoch_status_idx
  ON meal_records (patient_id, epoch_id, status);

-- A meal starts only inside an active epoch, from a LIVE CARB_ENTRY that occurred and was first stored at or after
-- the epoch start. The epoch row is share-locked so a concurrent retirement waits for this transaction.
CREATE OR REPLACE FUNCTION meal_records_guard_insert() RETURNS trigger AS $$
DECLARE
  epoch_row record;
  anchor_row record;
BEGIN
  SELECT starts_at, retired_at INTO epoch_row
  FROM meal_history_epochs
  WHERE id = NEW.epoch_id AND patient_id = NEW.patient_id
  FOR SHARE;
  IF NOT FOUND OR epoch_row.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'MEAL_RECORD_EPOCH_NOT_ACTIVE: %', NEW.epoch_id;
  END IF;

  SELECT type, occurred_at, created_at, event_ingestion_origin INTO anchor_row
  FROM events
  WHERE id = NEW.anchor_event_id AND patient_id = NEW.patient_id;
  IF NOT FOUND
    OR anchor_row.type <> 'CARB_ENTRY'
    OR anchor_row.event_ingestion_origin <> 'LIVE'
    OR anchor_row.occurred_at < epoch_row.starts_at
    OR anchor_row.created_at < epoch_row.starts_at THEN
    RAISE EXCEPTION 'MEAL_RECORD_ANCHOR_NOT_ELIGIBLE: %', NEW.anchor_event_id;
  END IF;

  IF NEW.status <> 'AWAITING_DESCRIPTION' OR NEW.proposal IS NOT NULL OR NEW.confirmed_macros IS NOT NULL
    OR NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL OR NEW.revisions <> '[]'::jsonb THEN
    RAISE EXCEPTION 'MEAL_RECORD_MUST_START_AWAITING_DESCRIPTION: %', NEW.meal_identity;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meal_records_guard_insert ON meal_records;
CREATE TRIGGER meal_records_guard_insert
  BEFORE INSERT ON meal_records
  FOR EACH ROW EXECUTE FUNCTION meal_records_guard_insert();

-- Identity, epoch, anchor, chaining and the prompt decision never change. Every change of trust-relevant fields
-- appends the previous values to revisions, so cancellations and corrections keep their history.
CREATE OR REPLACE FUNCTION meal_records_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id
    OR NEW.meal_identity IS DISTINCT FROM OLD.meal_identity
    OR NEW.epoch_id IS DISTINCT FROM OLD.epoch_id
    OR NEW.assignment_policy_version IS DISTINCT FROM OLD.assignment_policy_version
    OR NEW.anchor_event_id IS DISTINCT FROM OLD.anchor_event_id
    OR NEW.chained_to_meal_record_id IS DISTINCT FROM OLD.chained_to_meal_record_id
    OR NEW.prompt_decision IS DISTINCT FROM OLD.prompt_decision
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.revisions IS DISTINCT FROM OLD.revisions THEN
    RAISE EXCEPTION 'MEAL_RECORD_IMMUTABLE_FIELD: %', OLD.meal_identity;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.photo_ref IS DISTINCT FROM OLD.photo_ref
    OR NEW.proposal IS DISTINCT FROM OLD.proposal
    OR NEW.confirmed_macros IS DISTINCT FROM OLD.confirmed_macros
    OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
    OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    NEW.revisions := OLD.revisions || jsonb_build_array(jsonb_build_object(
      'status', OLD.status,
      'description', OLD.description,
      'photo_ref', OLD.photo_ref,
      'proposal', OLD.proposal,
      'confirmed_macros', OLD.confirmed_macros,
      'confirmed_by', OLD.confirmed_by,
      'confirmed_at', OLD.confirmed_at,
      'replaced_at', now()
    ));
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meal_records_guard_update ON meal_records;
CREATE TRIGGER meal_records_guard_update
  BEFORE UPDATE ON meal_records
  FOR EACH ROW EXECUTE FUNCTION meal_records_guard_update();

CREATE TABLE IF NOT EXISTS meal_record_entries (
  patient_id uuid NOT NULL,
  event_id uuid NOT NULL,
  meal_record_id uuid NOT NULL,
  -- Set from events.occurred_at by trigger, for meal lookup windows.
  occurred_at timestamptz NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  -- One meal per event: replays and concurrent deliveries can never assign an event twice.
  CONSTRAINT meal_record_entries_pkey PRIMARY KEY (patient_id, event_id),
  CONSTRAINT meal_record_entries_event_meal_unique UNIQUE (patient_id, event_id, meal_record_id),
  CONSTRAINT meal_record_entries_event_fk FOREIGN KEY (patient_id, event_id) REFERENCES events(patient_id, id) ON DELETE CASCADE,
  CONSTRAINT meal_record_entries_record_fk FOREIGN KEY (meal_record_id, patient_id) REFERENCES meal_records(id, patient_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS meal_record_entries_patient_occurred_idx
  ON meal_record_entries (patient_id, occurred_at);

CREATE INDEX IF NOT EXISTS meal_record_entries_record_idx
  ON meal_record_entries (meal_record_id);

-- Every meal contains its own anchor entry, checked at commit so the meal and its anchor entry can be inserted in
-- either order inside one transaction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'meal_records_anchor_entry_fk' AND conrelid = 'meal_records'::regclass
  ) THEN
    ALTER TABLE meal_records
      ADD CONSTRAINT meal_records_anchor_entry_fk
      FOREIGN KEY (patient_id, anchor_event_id, id)
      REFERENCES meal_record_entries(patient_id, event_id, meal_record_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

-- Members are qualifying-type carbohydrate entries at/after the epoch start; occurred_at always comes from events.
-- Memberships are permanent.
CREATE OR REPLACE FUNCTION meal_record_entries_guard() RETURNS trigger AS $$
DECLARE
  event_row record;
  epoch_start timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'MEAL_RECORD_ENTRY_IMMUTABLE: %', OLD.event_id;
  END IF;

  SELECT type, occurred_at INTO event_row FROM events WHERE id = NEW.event_id AND patient_id = NEW.patient_id;
  SELECT e.starts_at INTO epoch_start
  FROM meal_records r JOIN meal_history_epochs e ON e.id = r.epoch_id
  WHERE r.id = NEW.meal_record_id AND r.patient_id = NEW.patient_id;
  IF event_row.type IS DISTINCT FROM 'CARB_ENTRY' OR epoch_start IS NULL OR event_row.occurred_at < epoch_start THEN
    RAISE EXCEPTION 'MEAL_RECORD_ENTRY_NOT_ELIGIBLE: %', NEW.event_id;
  END IF;
  NEW.occurred_at := event_row.occurred_at;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meal_record_entries_guard ON meal_record_entries;
CREATE TRIGGER meal_record_entries_guard
  BEFORE INSERT OR UPDATE ON meal_record_entries
  FOR EACH ROW EXECUTE FUNCTION meal_record_entries_guard();

-- Transactional outbox for the meal description prompt: written in the same transaction as the meal.
-- SHADOW rows are terminal (RECORDED); only SEND rows ever become PENDING for a future dispatcher.
CREATE TABLE IF NOT EXISTS meal_description_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_key text NOT NULL,
  patient_id uuid NOT NULL,
  meal_record_id uuid NOT NULL,
  epoch_id uuid NOT NULL,
  anchor_event_id uuid NOT NULL,
  trigger_event_id uuid NOT NULL,
  delivery_mode text NOT NULL,
  delivery_status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error jsonb NULL,
  sent_at timestamptz NULL,
  -- Meal start + maximum prompt age: a dispatcher must never send at or after this instant.
  expires_at timestamptz NOT NULL,
  decision_audit jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_description_prompts_key_unique UNIQUE (prompt_key),
  CONSTRAINT meal_description_prompts_one_per_meal UNIQUE (meal_record_id),
  -- Epoch and anchor must be the meal's own.
  CONSTRAINT meal_description_prompts_record_fk FOREIGN KEY (meal_record_id, patient_id, epoch_id, anchor_event_id)
    REFERENCES meal_records(id, patient_id, epoch_id, anchor_event_id) ON DELETE CASCADE,
  -- The trigger event must be an entry of the same meal.
  CONSTRAINT meal_description_prompts_trigger_fk FOREIGN KEY (patient_id, trigger_event_id, meal_record_id)
    REFERENCES meal_record_entries(patient_id, event_id, meal_record_id) ON DELETE CASCADE,
  CONSTRAINT meal_description_prompts_mode_check CHECK (delivery_mode IN ('SHADOW', 'SEND')),
  CONSTRAINT meal_description_prompts_status_check CHECK (delivery_status IN ('RECORDED', 'PENDING', 'SENDING', 'SENT', 'FAILED', 'EXPIRED')),
  CONSTRAINT meal_description_prompts_shadow_is_terminal CHECK (delivery_mode <> 'SHADOW' OR delivery_status = 'RECORDED'),
  CONSTRAINT meal_description_prompts_attempts_check CHECK (attempts >= 0),
  CONSTRAINT meal_description_prompts_sent_before_expiry CHECK (sent_at IS NULL OR sent_at < expires_at)
);

CREATE INDEX IF NOT EXISTS meal_description_prompts_pending_idx
  ON meal_description_prompts (delivery_status, created_at)
  WHERE delivery_status = 'PENDING';

-- A prompt row exists only where the meal's recorded decision is CREATE_PROMPT (which already excludes chained
-- meals, non-LIVE anchors and stale meals) and while the epoch has prompts enabled. Only delivery state may change.
CREATE OR REPLACE FUNCTION meal_description_prompts_guard() RETURNS trigger AS $$
DECLARE
  record_row record;
  epoch_row record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.prompt_key IS DISTINCT FROM OLD.prompt_key
      OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
      OR NEW.meal_record_id IS DISTINCT FROM OLD.meal_record_id
      OR NEW.epoch_id IS DISTINCT FROM OLD.epoch_id
      OR NEW.anchor_event_id IS DISTINCT FROM OLD.anchor_event_id
      OR NEW.trigger_event_id IS DISTINCT FROM OLD.trigger_event_id
      OR NEW.delivery_mode IS DISTINCT FROM OLD.delivery_mode
      OR NEW.decision_audit IS DISTINCT FROM OLD.decision_audit
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'MEAL_DESCRIPTION_PROMPT_IMMUTABLE_FIELD: %', OLD.prompt_key;
    END IF;
    RETURN NEW;
  END IF;

  SELECT chained_to_meal_record_id, prompt_decision INTO record_row
  FROM meal_records WHERE id = NEW.meal_record_id AND patient_id = NEW.patient_id;
  SELECT prompts_enabled_from, prompt_delivery_mode INTO epoch_row FROM meal_history_epochs WHERE id = NEW.epoch_id AND patient_id = NEW.patient_id;
  IF record_row.chained_to_meal_record_id IS NOT NULL
    OR record_row.prompt_decision->>'decision' IS DISTINCT FROM 'CREATE_PROMPT'
    OR record_row.prompt_decision->'prompt'->>'prompt_key' IS DISTINCT FROM NEW.prompt_key
    OR epoch_row.prompts_enabled_from IS NULL THEN
    RAISE EXCEPTION 'MEAL_DESCRIPTION_PROMPT_NOT_DECIDED: %', NEW.prompt_key;
  END IF;
  -- New prompts follow the epoch's mode: SHADOW is recorded only, SEND starts PENDING. Nothing starts as sent.
  IF NEW.delivery_mode IS DISTINCT FROM epoch_row.prompt_delivery_mode
    OR NEW.delivery_status IS DISTINCT FROM (CASE WHEN NEW.delivery_mode = 'SEND' THEN 'PENDING' ELSE 'RECORDED' END)
    OR NEW.attempts <> 0 OR NEW.sent_at IS NOT NULL THEN
    RAISE EXCEPTION 'MEAL_DESCRIPTION_PROMPT_INVALID_INITIAL_STATE: %', NEW.prompt_key;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meal_description_prompts_guard ON meal_description_prompts;
CREATE TRIGGER meal_description_prompts_guard
  BEFORE INSERT OR UPDATE ON meal_description_prompts
  FOR EACH ROW EXECUTE FUNCTION meal_description_prompts_guard();
