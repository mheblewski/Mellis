-- Turns remote commands to the patient's loop (Trio) on or off (the remote-bolus-trio plan, W1).
-- Three switches must all be on: REMOTE_COMMANDS_ENABLED=true in .env, the patient's switch and the caregiver's switch.
-- The app re-reads them at once (live update "capabilities").
-- Usage (from deploy/):
--   docker compose exec -T postgres psql -U glucomind -d glucomind -v ON_ERROR_STOP=1 \
--     -v patient_id=<NIGHTSCOUT_PATIENT_ID> -v login=<e-mail or Cognito username> -v patient_on=true -v caregiver_on=true \
--     < sql/remote-control.sql
-- patient_on=false switches the patient off for everyone; caregiver_on=false only this caregiver.
-- The final switch stays in Trio: Remote Control off there (or a new shared secret) stops every command.

UPDATE patients
SET remote_control = jsonb_set(remote_control, '{enabled}', to_jsonb(:'patient_on'::boolean)),
    updated_at = now()
WHERE id = :'patient_id'::uuid;

-- Since migration 090 a caregiver's switch counts only when an owner granted it and the caregiver confirmed it. This
-- script turns it on only for an owner (granted and confirmed by themself); others get it through sharing (stage 2).
UPDATE caregiver_relationships r
SET permissions = jsonb_set(coalesce(r.permissions, '{}'::jsonb), '{remote_commands}', to_jsonb(:'caregiver_on'::boolean)),
    remote_bolus_granted_by = CASE WHEN :'caregiver_on'::boolean THEN r.user_id END,
    remote_bolus_granted_at = CASE WHEN :'caregiver_on'::boolean THEN now() END,
    remote_bolus_confirmed_at = CASE WHEN :'caregiver_on'::boolean THEN now() END,
    updated_at = now()
FROM auth_identities ai
WHERE ai.user_id = r.user_id
  AND ai.provider = 'COGNITO'
  AND r.patient_id = :'patient_id'::uuid
  AND (r.is_owner OR NOT :'caregiver_on'::boolean)
  AND (lower(ai.email) = lower(:'login') OR ai.provider_username = :'login' OR ai.provider_subject = :'login');

SELECT coalesce(ai.email, ai.provider_username) AS login,
       r.is_owner,
       (p.remote_control->>'enabled')::boolean AS patient_on,
       coalesce((r.permissions->>'remote_commands')::boolean, false) AND r.remote_bolus_confirmed_at IS NOT NULL AS caregiver_on
FROM caregiver_relationships r
JOIN patients p ON p.id = r.patient_id
JOIN auth_identities ai ON ai.user_id = r.user_id AND ai.provider = 'COGNITO'
WHERE r.patient_id = :'patient_id'::uuid
ORDER BY 1;
