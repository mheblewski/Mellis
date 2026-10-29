-- Creates the shared patient row once (fresh database only; a restored dump already has it), and starts its meal
-- history and loop actions from now: without these two rows a patient's loop entries are not grouped and no new meals
-- are kept (audit 2026-10-23). Running it again changes nothing.
-- Usage (from deploy/):
--   docker compose exec -T postgres psql -U glucomind -d glucomind -v ON_ERROR_STOP=1 \
--     -v patient_id=<NIGHTSCOUT_PATIENT_ID> -v name='<display name>' < sql/bootstrap-patient.sql
INSERT INTO patients (id, display_name)
VALUES (:'patient_id'::uuid, :'name')
ON CONFLICT (id) DO NOTHING;

-- The meal history epoch, as production's (new-meal-assignment.v1), unless the patient has an active one.
INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by, note)
SELECT :'patient_id'::uuid, now(), 'new-meal-assignment.v1', 'bootstrap-patient.sql', 'meal history from the patient''s start'
WHERE NOT EXISTS (SELECT 1 FROM meal_history_epochs WHERE patient_id = :'patient_id'::uuid AND retired_at IS NULL);

-- Loop actions from the same moment.
INSERT INTO loop_action_epochs (patient_id, starts_at)
SELECT :'patient_id'::uuid, now()
WHERE NOT EXISTS (SELECT 1 FROM loop_action_epochs WHERE patient_id = :'patient_id'::uuid);

SELECT p.id, p.display_name,
       (SELECT starts_at FROM meal_history_epochs m WHERE m.patient_id = p.id AND m.retired_at IS NULL) AS meal_history_from,
       (SELECT starts_at FROM loop_action_epochs l WHERE l.patient_id = p.id) AS loop_actions_from
FROM patients p WHERE p.id = :'patient_id'::uuid;
