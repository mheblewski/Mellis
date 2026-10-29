-- Gives one Cognito account access to the shared patient as an owner (every permission except remote bolus, which
-- sql/remote-control.sql turns on). Stage 2 of the onboarding-sharing plan replaces this with invitations.
-- The account must have signed in to the app once (the API creates the user and its auth_identities row on the first authenticated request).
-- `login` matches the stored e-mail or the Cognito username (access tokens carry only the username, which is often
-- the Cognito sub); run sql/list-identities.sql to see what is stored.
-- Usage (from deploy/), once per caregiver:
--   docker compose exec -T postgres psql -U glucomind -d glucomind -v ON_ERROR_STOP=1 \
--     -v patient_id=<NIGHTSCOUT_PATIENT_ID> -v login=<e-mail or Cognito username> < sql/link-caregiver.sql
INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type, permissions, is_owner)
SELECT ai.user_id, :'patient_id'::uuid, 'primary_caregiver', '{"glucose_alerts": true, "ai_chat_meals": true}'::jsonb, true
FROM auth_identities ai
WHERE ai.provider = 'COGNITO'
  AND (lower(ai.email) = lower(:'login') OR ai.provider_username = :'login' OR ai.provider_subject = :'login')
ON CONFLICT (user_id, patient_id, relationship_type) DO UPDATE SET updated_at = now();

SELECT coalesce(ai.email, ai.provider_username) AS login, r.user_id, r.patient_id, r.relationship_type, r.is_owner
FROM caregiver_relationships r
JOIN auth_identities ai ON ai.user_id = r.user_id AND ai.provider = 'COGNITO'
WHERE r.patient_id = :'patient_id'::uuid
ORDER BY 1;
