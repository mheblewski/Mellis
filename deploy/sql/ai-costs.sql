-- AI cost and latency per day and source (last 14 days): the gateway's answers (ai_executions) and the meal chat and
-- WBT screen calls (ai_side_calls, migration 087). Run: docker compose exec -T postgres psql -U glucomind -d glucomind -f /dev/stdin < sql/ai-costs.sql
SELECT day, source, calls, failed, round(cost::numeric, 4) AS cost_usd, avg_latency_ms
FROM (
  SELECT date_trunc('day', created_at)::date AS day, 'side:' || kind AS source, count(*) AS calls,
         count(*) FILTER (WHERE outcome <> 'OK') AS failed, sum(cost) AS cost, round(avg(latency_ms)) AS avg_latency_ms
  FROM ai_side_calls
  WHERE created_at > now() - interval '14 days'
  GROUP BY 1, 2
  UNION ALL
  SELECT date_trunc('day', created_at)::date, 'gateway:' || task_type, count(*),
         count(*) FILTER (WHERE status <> 'succeeded'), sum(estimated_cost), round(avg(provider_latency_ms))
  FROM ai_executions
  WHERE created_at > now() - interval '14 days'
  GROUP BY 1, 2
) rows
ORDER BY day DESC, source;
