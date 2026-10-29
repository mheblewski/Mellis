-- Accounts that have signed in, newest first, with the patients they can access.
-- Usage (from deploy/):
--   docker compose exec -T postgres psql -U glucomind -d glucomind < sql/list-identities.sql
SELECT ai.provider_username, ai.provider_subject, ai.email, ai.last_seen_at,
       coalesce(string_agg(r.patient_id::text, ', '), '-') AS patients
FROM auth_identities ai
LEFT JOIN caregiver_relationships r ON r.user_id = ai.user_id
GROUP BY ai.id
ORDER BY ai.last_seen_at DESC;
