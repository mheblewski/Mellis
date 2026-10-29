-- Live updates (live-updates.v1): both caregivers see each other's changes and the answer being written without
-- refreshing.
--  * Every change the app shows is announced on the Postgres channel glucomind_events by row triggers, so no writer
--    (API, worker, Nightscout sync) can forget it. The payload is small JSON {"p": patient, "k": kind, "id": id};
--    Postgres collapses identical payloads of one transaction into one notification.
--  * reply_drafts holds the text of an answer while the model writes it (one row per conversation or meal chat).
--  * meal_records.content_revision counts caregiver-visible content changes (description, photo, confirmed values,
--    cancellation), so a save made on an outdated meal is refused instead of silently overwriting the other caregiver.
--  * New and re-queued jobs wake the worker on the glucomind_jobs channel instead of its next 2-second poll.

CREATE OR REPLACE FUNCTION glucomind_notify_event(patient uuid, kind text, entity_id text) RETURNS void AS $$
BEGIN
  IF patient IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_notify('glucomind_events', json_build_object('p', patient, 'k', kind, 'id', entity_id)::text);
END
$$ LANGUAGE plpgsql;

-- Row trigger: TG_ARGV[0] is the event kind, TG_ARGV[1] the column holding the entity id (optional).
CREATE OR REPLACE FUNCTION glucomind_notify_row_change() RETURNS trigger AS $$
DECLARE
  row_data jsonb;
BEGIN
  row_data := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  PERFORM glucomind_notify_event(
    (row_data->>'patient_id')::uuid,
    TG_ARGV[0],
    CASE WHEN TG_NARGS > 1 THEN row_data->>TG_ARGV[1] ELSE NULL END
  );
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

-- Conversations: messages, the conversation row (title, pin, delete, awaiting answer) and attached photos.
DROP TRIGGER IF EXISTS messages_live_event ON messages;
CREATE TRIGGER messages_live_event AFTER INSERT OR UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('conversation', 'conversation_id');
DROP TRIGGER IF EXISTS conversations_live_event ON conversations;
CREATE TRIGGER conversations_live_event AFTER INSERT OR UPDATE OR DELETE ON conversations
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('conversation', 'id');

-- Analysis progress steps (ai_executions.patient_id is text; correlation_id is the conversation for conversation tasks).
CREATE OR REPLACE FUNCTION ai_executions_notify_progress() RETURNS trigger AS $$
BEGIN
  IF NEW.patient_id IS NULL OR NEW.patient_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.processing_state IS DISTINCT FROM OLD.processing_state OR NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM glucomind_notify_event(NEW.patient_id::uuid, 'conversation', NEW.correlation_id);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ai_executions_live_event ON ai_executions;
CREATE TRIGGER ai_executions_live_event AFTER INSERT OR UPDATE ON ai_executions
  FOR EACH ROW EXECUTE FUNCTION ai_executions_notify_progress();

-- Meals and everything shown with them in the meals tab.
DROP TRIGGER IF EXISTS meal_records_live_event ON meal_records;
CREATE TRIGGER meal_records_live_event AFTER INSERT OR UPDATE OR DELETE ON meal_records
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('meal', 'id');
DROP TRIGGER IF EXISTS meal_record_entries_live_event ON meal_record_entries;
CREATE TRIGGER meal_record_entries_live_event AFTER INSERT OR UPDATE OR DELETE ON meal_record_entries
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('meal', 'meal_record_id');
DROP TRIGGER IF EXISTS meal_wbt_reminders_live_event ON meal_wbt_reminders;
CREATE TRIGGER meal_wbt_reminders_live_event AFTER INSERT OR UPDATE OR DELETE ON meal_wbt_reminders
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('meal', 'meal_record_id');
DROP TRIGGER IF EXISTS carb_entry_kinds_live_event ON carb_entry_kinds;
CREATE TRIGGER carb_entry_kinds_live_event AFTER INSERT OR UPDATE OR DELETE ON carb_entry_kinds
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('meals');
DROP TRIGGER IF EXISTS meal_record_entry_detachments_live_event ON meal_record_entry_detachments;
CREATE TRIGGER meal_record_entry_detachments_live_event AFTER INSERT OR UPDATE OR DELETE ON meal_record_entry_detachments
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('meals');
DROP TRIGGER IF EXISTS loop_actions_live_event ON loop_actions;
CREATE TRIGGER loop_actions_live_event AFTER INSERT OR UPDATE OR DELETE ON loop_actions
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('loop_action', 'id');
DROP TRIGGER IF EXISTS meal_chat_messages_live_event ON meal_chat_messages;
CREATE TRIGGER meal_chat_messages_live_event AFTER INSERT OR UPDATE OR DELETE ON meal_chat_messages
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('meal_chat', 'meal_record_id');

-- Hypo episodes and the notification history (the bell).
DROP TRIGGER IF EXISTS hypo_episodes_live_event ON hypo_episodes;
CREATE TRIGGER hypo_episodes_live_event AFTER INSERT OR UPDATE ON hypo_episodes
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('hypo', 'id');
DROP TRIGGER IF EXISTS notification_history_live_event ON notification_history;
CREATE TRIGGER notification_history_live_event AFTER INSERT OR UPDATE ON notification_history
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('notifications');

-- Jobs: a queued job wakes the worker; a conversation or meal chat job changing state (queued, failed, done) refreshes
-- what the app derives from it ("Ponawiam analizę", reply_pending / reply_failed).
CREATE OR REPLACE FUNCTION jobs_notify_change() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'queued' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'queued') THEN
    PERFORM pg_notify('glucomind_jobs', '');
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  IF NEW.job_type IN ('conversation.direct_response', 'conversation.time_range_analysis', 'analysis.follow_up', 'investigation.re_evaluate') THEN
    PERFORM glucomind_notify_event(NEW.patient_id, 'conversation', NEW.correlation_id::text);
  ELSIF NEW.job_type = 'meal.chat_reply' THEN
    PERFORM glucomind_notify_event(NEW.patient_id, 'meal_chat', NEW.payload->>'meal_record_id');
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS jobs_live_event ON jobs;
CREATE TRIGGER jobs_live_event AFTER INSERT OR UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_notify_change();

-- The answer being written. Deleted when the stored answer replaces it (or the job fails or is cancelled).
CREATE TABLE IF NOT EXISTS reply_drafts (
  thread_kind text NOT NULL CHECK (thread_kind IN ('CONVERSATION', 'MEAL_CHAT')),
  -- The conversation id or the meal record id.
  thread_id uuid NOT NULL,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  -- The caregiver message being answered.
  reply_to_message_id uuid NOT NULL,
  content text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_kind, thread_id)
);

CREATE OR REPLACE FUNCTION reply_drafts_notify_change() RETURNS trigger AS $$
DECLARE
  draft reply_drafts;
BEGIN
  draft := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  PERFORM glucomind_notify_event(draft.patient_id, CASE draft.thread_kind WHEN 'CONVERSATION' THEN 'conversation_draft' ELSE 'meal_chat_draft' END, draft.thread_id::text);
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS reply_drafts_live_event ON reply_drafts;
CREATE TRIGGER reply_drafts_live_event AFTER INSERT OR UPDATE OR DELETE ON reply_drafts
  FOR EACH ROW EXECUTE FUNCTION reply_drafts_notify_change();

-- Caregiver-visible content revision of a meal. AI proposals and status steps that follow them do not count: a
-- caregiver may always overwrite an AI proposal, but not the other caregiver's description or values.
ALTER TABLE meal_records ADD COLUMN IF NOT EXISTS content_revision bigint NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION meal_records_bump_content_revision() RETURNS trigger AS $$
BEGIN
  IF NEW.description IS DISTINCT FROM OLD.description
    OR NEW.photo_ref IS DISTINCT FROM OLD.photo_ref
    OR NEW.confirmed_macros IS DISTINCT FROM OLD.confirmed_macros
    OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
    OR (NEW.status = 'CANCELLED' AND OLD.status <> 'CANCELLED') THEN
    NEW.content_revision := OLD.content_revision + 1;
  ELSE
    NEW.content_revision := OLD.content_revision;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS meal_records_content_revision ON meal_records;
CREATE TRIGGER meal_records_content_revision BEFORE UPDATE ON meal_records
  FOR EACH ROW EXECUTE FUNCTION meal_records_bump_content_revision();
