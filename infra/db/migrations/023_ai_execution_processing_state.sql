ALTER TABLE ai_executions
  ADD COLUMN IF NOT EXISTS processing_state jsonb NULL;
