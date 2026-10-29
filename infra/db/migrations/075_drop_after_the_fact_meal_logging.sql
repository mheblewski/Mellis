-- The after-the-fact meal logging is retired (owner 2026-10-26); both phones get an app without it at the same deploy,
-- so nothing is kept for older builds. Gone, with their data:
--  * "Na co to było?" for loop actions: its push, "Pomiń" and the 24 h auto-skip (loop_actions.push_status,
--    push_sent_at, skipped_at, skipped_by_user_id);
--  * the meal description prompt and its push "Co było w tym posiłku?" (meal_description_prompts, the prompt fields of
--    meal_history_epochs and meal_records.prompt_decision; meals start from loop actions, nothing joins entries itself);
--  * the after-hypo form and its push (patient_devices.hypo_report_push_enabled, the bell entries and push rows of the
--    hypo_report question; the facts it saved stay in patient_context);
--  * the legacy meal_candidates -> meal_cases -> patterns pipeline, the memory engine and two unused shadow tables
--    (evidence_exclusion_lifecycle_audit, compact_delivery_rollout_state), and the finished jobs of their job types.
-- Kept: loop_action_epochs/loop_action_events/loop_actions (grouping, the reconciler, the chat's SET_PURPOSE, WBT, with
-- assigned_by_user_id/assigned_at), meal_history_epochs with its guard, meal_records, meal_record_entries,
-- meal_record_entry_detachments, carb_entry_kinds, hypo_episodes/triggers, context_questions/investigations/
-- push_notifications/patient_context (the chat's own clarifying question), evidence_exclusions, notification_history.

-- Legacy pipeline: patterns first (they point at meal cases), then meal cases, then the candidates they came from.
DROP TABLE IF EXISTS pattern_lifecycle_audit;
DROP TABLE IF EXISTS pattern_cases;
DROP TABLE IF EXISTS patterns;
DROP TABLE IF EXISTS meal_case_facts;
DROP TABLE IF EXISTS meal_case_hypotheses;
DROP TABLE IF EXISTS meal_cases;
DROP TABLE IF EXISTS meal_candidate_associations;
DROP TABLE IF EXISTS meal_candidate_hypotheses;
DROP TABLE IF EXISTS meal_candidates;

-- Memory engine: everything that points at memories, then memories.
DROP TABLE IF EXISTS memory_lifecycle_audit;
DROP TABLE IF EXISTS memory_contradictions;
DROP TABLE IF EXISTS memory_evidence;
DROP TABLE IF EXISTS memory_candidates;
DROP TABLE IF EXISTS memories;

DROP TABLE IF EXISTS evidence_exclusion_lifecycle_audit;
DROP TABLE IF EXISTS compact_delivery_rollout_state;

-- Meal description prompts and the prompt fields that decided them.
DROP TABLE IF EXISTS meal_description_prompts;
DROP FUNCTION IF EXISTS meal_description_prompts_guard();

-- 043's guard without prompt_decision (it reads every NEW/OLD field it names, so it must not name a dropped column).
CREATE OR REPLACE FUNCTION meal_records_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id
    OR NEW.meal_identity IS DISTINCT FROM OLD.meal_identity
    OR NEW.epoch_id IS DISTINCT FROM OLD.epoch_id
    OR NEW.assignment_policy_version IS DISTINCT FROM OLD.assignment_policy_version
    OR NEW.anchor_event_id IS DISTINCT FROM OLD.anchor_event_id
    OR NEW.chained_to_meal_record_id IS DISTINCT FROM OLD.chained_to_meal_record_id
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

-- Their CHECK constraints (meal_records_prompt_decision_check, meal_history_epochs_prompts_after_start,
-- meal_history_epochs_delivery_mode_check) go with the columns.
ALTER TABLE meal_records DROP COLUMN IF EXISTS prompt_decision;
ALTER TABLE meal_history_epochs DROP COLUMN IF EXISTS prompts_enabled_from;
ALTER TABLE meal_history_epochs DROP COLUMN IF EXISTS prompt_delivery_mode;

-- "Na co to było?": its push state and "Pomiń" / the 24 h auto-skip.
DROP INDEX IF EXISTS loop_actions_push_pending_idx;
ALTER TABLE loop_actions DROP CONSTRAINT IF EXISTS loop_actions_push_status_check;
ALTER TABLE loop_actions DROP COLUMN IF EXISTS push_status;
ALTER TABLE loop_actions DROP COLUMN IF EXISTS push_sent_at;
ALTER TABLE loop_actions DROP COLUMN IF EXISTS skipped_at;
ALTER TABLE loop_actions DROP COLUMN IF EXISTS skipped_by_user_id;

-- The after-hypo form's push switch ("Podsumowanie po hipo", migration 055).
ALTER TABLE patient_devices DROP COLUMN IF EXISTS hypo_report_push_enabled;

-- Bell entries and push rows of the retired requests: the app can no longer open them.
DELETE FROM notification_history
WHERE notification_type IN ('meal_description', 'loop_action')
   OR (notification_type = 'conversation_question' AND payload->>'questionId' = 'hypo_report');
DELETE FROM push_notifications WHERE question_id = 'hypo_report';

-- Finished jobs of the retired job types. A queued or running one is left alone: the worker no longer knows the type
-- and finishes it as a no-op.
DELETE FROM jobs
WHERE job_type IN (
    'meal-candidate.rebuild_from_event',
    'pattern.reevaluate',
    'memory.reevaluate',
    'meal-history.intake_carb_entry',
    'meal-history.dispatch_description_prompt'
  )
  AND status NOT IN ('queued', 'running');

-- The dose-news scan of the worker (processReminderDoseNews, remindersAwaitingDoseNews) every 30 s: only reminders
-- that fired and wait for their dose.
CREATE INDEX IF NOT EXISTS care_reminders_second_dose_awaiting_idx
  ON care_reminders (fired_at)
  WHERE kind = 'SECOND_DOSE' AND status = 'FIRED' AND dose_given_at IS NULL;
CREATE INDEX IF NOT EXISTS meal_wbt_reminders_sent_awaiting_idx
  ON meal_wbt_reminders (sent_at)
  WHERE status = 'SENT' AND dose_given_at IS NULL;
