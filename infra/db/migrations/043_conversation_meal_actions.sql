-- Meal changes from the main chat (conversation-meal-actions.v1, docs/product/conversation-meal-actions-plan.md).
--  * meal_records.confirmed_items: what the meal consisted of (name, grams, macros, DiabCalc or estimate). It is part of
--    the caregiver-visible content: kept in revisions and counted by content_revision like the description and values.
--  * conversation_meal_actions: a change the AI prepared in a conversation. Nothing is written to the meal until a
--    caregiver taps "Zatwierdź" on its card; it records what the meal looked like when proposed, so a change prepared on
--    an outdated meal is refused (STALE) instead of overwriting the other caregiver.
--  * meal_chat_messages.origin_conversation_id: the note in the meal's own chat that a change came from a conversation.

ALTER TABLE meal_records ADD COLUMN IF NOT EXISTS confirmed_items jsonb NULL;
ALTER TABLE meal_records DROP CONSTRAINT IF EXISTS meal_records_confirmed_items_check;
ALTER TABLE meal_records ADD CONSTRAINT meal_records_confirmed_items_check
  CHECK (confirmed_items IS NULL OR jsonb_typeof(confirmed_items) = 'array');

-- 027's guard, with confirmed_items among the fields whose previous value is kept in revisions.
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
    OR NEW.confirmed_items IS DISTINCT FROM OLD.confirmed_items
    OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
    OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    NEW.revisions := OLD.revisions || jsonb_build_array(jsonb_build_object(
      'status', OLD.status,
      'description', OLD.description,
      'photo_ref', OLD.photo_ref,
      'proposal', OLD.proposal,
      'confirmed_macros', OLD.confirmed_macros,
      'confirmed_items', OLD.confirmed_items,
      'confirmed_by', OLD.confirmed_by,
      'confirmed_at', OLD.confirmed_at,
      'replaced_at', now()
    ));
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- 042's revision counter, with confirmed_items as caregiver-visible content.
CREATE OR REPLACE FUNCTION meal_records_bump_content_revision() RETURNS trigger AS $$
BEGIN
  IF NEW.description IS DISTINCT FROM OLD.description
    OR NEW.photo_ref IS DISTINCT FROM OLD.photo_ref
    OR NEW.confirmed_macros IS DISTINCT FROM OLD.confirmed_macros
    OR NEW.confirmed_items IS DISTINCT FROM OLD.confirmed_items
    OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
    OR (NEW.status = 'CANCELLED' AND OLD.status <> 'CANCELLED') THEN
    NEW.content_revision := OLD.content_revision + 1;
  ELSE
    NEW.content_revision := OLD.content_revision;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS conversation_meal_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- The caregiver message the AI answered when it prepared the change; the card is shown under that answer.
  user_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  operation text NOT NULL,
  -- What the change is about. A meal deleted by a loop-action reassignment leaves the change in place (STALE).
  meal_record_id uuid NULL REFERENCES meal_records(id) ON DELETE SET NULL,
  carb_event_id uuid NULL,
  loop_action_id uuid NULL REFERENCES loop_actions(id) ON DELETE SET NULL,
  -- The state the change sets, the state it was based on (shown as "było", restored by "Cofnij") and warnings for the card.
  payload jsonb NOT NULL,
  before jsonb NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  base_content_revision bigint NULL,
  status text NOT NULL DEFAULT 'PROPOSED',
  -- Why the AI prepared it (shown on the card), in the caregiver's language.
  reason text NULL,
  decided_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz NULL,
  -- After APPLIED: the meal revision the change produced (an undo is refused once the meal changed again).
  applied_content_revision bigint NULL,
  undone_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  undone_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_meal_actions_operation_check CHECK (operation IN (
    'REPLACE_CONTENT', 'UPDATE_MACROS', 'UPDATE_DESCRIPTION', 'SET_PURPOSE', 'DETACH_ENTRY', 'SET_WBT_REMINDER'
  )),
  CONSTRAINT conversation_meal_actions_status_check CHECK (status IN (
    'PROPOSED', 'APPLYING', 'APPLIED', 'REJECTED', 'SUPERSEDED', 'STALE', 'DISCARDED', 'UNDONE'
  )),
  CONSTRAINT conversation_meal_actions_target_check CHECK (meal_record_id IS NOT NULL OR carb_event_id IS NOT NULL OR loop_action_id IS NOT NULL),
  -- A caregiver decision (applied, rejected, undone) records who and when; the other statuses need none.
  CONSTRAINT conversation_meal_actions_decision_check CHECK ((status IN ('PROPOSED', 'APPLYING', 'SUPERSEDED', 'DISCARDED', 'STALE')) OR decided_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS conversation_meal_actions_conversation_idx ON conversation_meal_actions (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS conversation_meal_actions_open_idx ON conversation_meal_actions (patient_id, status) WHERE status = 'PROPOSED';

-- A card changing state (approved on the other phone, superseded, stale) refreshes the conversation.
DROP TRIGGER IF EXISTS conversation_meal_actions_live_event ON conversation_meal_actions;
CREATE TRIGGER conversation_meal_actions_live_event AFTER INSERT OR UPDATE OR DELETE ON conversation_meal_actions
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('conversation', 'conversation_id');

ALTER TABLE meal_chat_messages ADD COLUMN IF NOT EXISTS origin_conversation_id uuid NULL REFERENCES conversations(id) ON DELETE SET NULL;
