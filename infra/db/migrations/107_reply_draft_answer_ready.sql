-- Cards right after the text (cards-after-text.v1): the answer being written is finished and its cards are being
-- prepared. Holds the answer's options ({"answer_options": [...]}); NULL while the text is still written. The app shows
-- the cards already prepared under the finished text, read-only until the answer is stored.
ALTER TABLE reply_drafts ADD COLUMN IF NOT EXISTS answer_ready jsonb;
