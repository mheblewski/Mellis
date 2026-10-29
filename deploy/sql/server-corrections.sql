-- Read-only review: where the server changed what the model wrote (server-corrections.v1). Frequent kinds point to a
-- prompt or a tool to fix, not to one more appended sentence. Local time Europe/Warsaw, newest first.
-- Part 1, answers (messages.metadata.anomaly_flags, type SERVER_CORRECTION). Kinds:
--   MEAL_WRITE_CLAIM          the text said a meal change was saved; a note says it saves only from its card
--   BOLUS_GIVEN_CLAIM         the text said insulin was given; a note says nothing was given
--   BOLUS_DOSE_WITHOUT_CARD   a "Propozycja" dose with no card; a note says it cannot be given from here
--   THERAPY_NO_READING / THERAPY_LOW / THERAPY_FALLING / THERAPY_STALE_READING
--                             a free-text dose in an analysis written from a missing, low, falling or old reading
--   OPTION_POINTER_REMOVED    "Wybierz opcję…" cut because the options were dropped
--   OPTIONS_DROPPED           the model offered options the server did not keep (fewer than two valid, cards missing)
-- Part 2, WBT screen suggestions whose dose the server bounds changed (meal_wbt_suggestions.result.server_adjustment).
-- Usage: psql ... -v days=7 -f server-corrections.sql   (days defaults to 7)
\if :{?days}
\else
  \set days 7
\endif
SET default_transaction_read_only = on;

-- How often each kind fired.
SELECT correction AS kind, count(*) AS answers
FROM messages a
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(a.metadata->'anomaly_flags') = 'array' THEN a.metadata->'anomaly_flags' ELSE '[]'::jsonb END
) AS flag
CROSS JOIN LATERAL jsonb_array_elements_text(flag->'corrections') AS correction
WHERE a.role = 'ASSISTANT'
  AND flag->>'type' = 'SERVER_CORRECTION'
  AND a.created_at >= now() - make_interval(days => :days)
GROUP BY correction
ORDER BY answers DESC;

-- Each corrected answer with its question.
SELECT
  to_char(a.created_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS time,
  CASE a.metadata->>'ai_task_type'
    WHEN 'CONVERSATION_TIME_RANGE_ANALYSIS' THEN 'ANALYSIS'
    WHEN 'CONVERSATION_DIRECT_RESPONSE' THEN 'DIRECT'
    ELSE coalesce(a.metadata->>'ai_task_type', '?')
  END AS task,
  (SELECT string_agg(value, ', ') FROM jsonb_array_elements_text(flag->'corrections')) AS corrections,
  left(regexp_replace(coalesce(u.content, '(question not found)'), '\s+', ' ', 'g'), 160) AS question,
  a.id AS message_id
FROM messages a
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(a.metadata->'anomaly_flags') = 'array' THEN a.metadata->'anomaly_flags' ELSE '[]'::jsonb END
) AS flag
LEFT JOIN messages u
  ON u.conversation_id = a.conversation_id
  AND u.id::text = a.metadata->>'user_message_id'
WHERE a.role = 'ASSISTANT'
  AND flag->>'type' = 'SERVER_CORRECTION'
  AND a.created_at >= now() - make_interval(days => :days)
ORDER BY a.created_at DESC;

-- WBT screen suggestions the bounds changed (NOT_A_NUMBER, BELOW_ZERO, ABOVE_MAX, LOW_GLUCOSE).
SELECT
  to_char(s.created_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS time,
  s.result->'server_adjustment'->>'reason' AS reason,
  s.result->'server_adjustment'->>'model_dose_units' AS model_dose_u,
  s.result->>'dose_units' AS shown_dose_u,
  s.result->'standard'->>'dose_units' AS standard_dose_u,
  s.result->'current'->>'glucose_mgdl' AS glucose_mgdl,
  s.id AS suggestion_id
FROM meal_wbt_suggestions s
WHERE s.status = 'DONE'
  AND jsonb_typeof(s.result->'server_adjustment') = 'object'
  AND s.created_at >= now() - make_interval(days => :days)
ORDER BY s.created_at DESC;
