-- Read-only daily review: AI answers the worker flagged as claiming missing data ("nie mam danych", "brak odczytów",
-- "nie było bolusa", ...) while the database had that kind of data in the answer's window (metadata.anomaly_flags,
-- suspicious-no-data-answer.v1). One row per flagged answer, newest first, local time Europe/Warsaw.
-- Columns: time, task (ANALYSIS = time-range analysis, DIRECT = direct reply), range (analysed range type, or LAST_24H
-- for a direct reply), the caregiver's question, the answer's claim words, the event counts of the window.
-- Usage: psql ... -v days=7 -f suspicious-answers.sql   (days defaults to 1)
\if :{?days}
\else
  \set days 1
\endif
SET default_transaction_read_only = on;

SELECT
  to_char(a.created_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS time,
  CASE a.metadata->>'ai_task_type'
    WHEN 'CONVERSATION_TIME_RANGE_ANALYSIS' THEN 'ANALYSIS'
    WHEN 'CONVERSATION_DIRECT_RESPONSE' THEN 'DIRECT'
    ELSE coalesce(a.metadata->>'ai_task_type', '?')
  END AS task,
  coalesce(a.metadata->>'range_type', flag->>'window_basis') AS range,
  left(regexp_replace(coalesce(u.content, '(question not found)'), '\s+', ' ', 'g'), 160) AS question,
  (SELECT string_agg(claim->>'phrase', ', ') FROM jsonb_array_elements(flag->'claims') AS claim) AS phrases,
  (flag->'counts'->>'glucose_readings')::int AS cgm,
  (flag->'counts'->>'boluses')::int AS boluses,
  (flag->'counts'->>'smbs')::int AS smbs,
  (flag->'counts'->>'temp_basals')::int AS temp_basals,
  (flag->'counts'->>'loop_snapshots')::int AS iob_cob,
  a.id AS message_id
FROM messages a
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(a.metadata->'anomaly_flags') = 'array' THEN a.metadata->'anomaly_flags' ELSE '[]'::jsonb END
) AS flag
LEFT JOIN messages u
  ON u.conversation_id = a.conversation_id
  AND u.id::text = a.metadata->>'user_message_id'
WHERE a.role = 'ASSISTANT'
  AND a.metadata ? 'anomaly_flags'
  AND flag->>'type' = 'SUSPICIOUS_NO_DATA_ANSWER'
  AND a.created_at >= now() - make_interval(days => :days)
ORDER BY a.created_at DESC;
