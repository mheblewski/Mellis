-- The value card of an answer in its draft (chat-metric-card.v1), so the card shows before the answer's text.
ALTER TABLE reply_drafts ADD COLUMN IF NOT EXISTS metric_card JSONB;
