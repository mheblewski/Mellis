CREATE UNIQUE INDEX context_questions_single_open_per_conversation_idx
  ON context_questions (conversation_id)
  WHERE status = 'OPEN';
