-- The knowledge base shipped in the app image (knowledge/, built on each server by `mellis-admin knowledge-build`):
--   * a chunk may have no vector: a server without an OpenAI key builds and searches full text (BM25) only;
--   * a corpus version may have no embedding model / dimensions (such a BM25-only build);
--   * each chunk keeps where it came from (url, licence, mode, publisher) so an answer links to the original;
--   * rag_corpus_versions.source tells a shipped-knowledge build from a loaded rag-index.json (production's own corpus),
--     so knowledge-build never replaces a corpus it did not build.
-- Existing rows (the production corpus v7) keep their vectors and get NULL metadata and source 'index-file'.
--
-- 036 needs pgvector; local test databases without it mark 036 applied without running it, so there is no rag_chunks
-- table to change here. Every real server runs 036 (pgvector image), so the block below always runs there.
DO $$
BEGIN
  IF to_regclass('rag_chunks') IS NULL OR to_regclass('rag_corpus_versions') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE rag_chunks ALTER COLUMN embedding DROP NOT NULL;
  ALTER TABLE rag_chunks
    ADD COLUMN url text CHECK (url IS NULL OR url ~ '^https?://'),
    ADD COLUMN licence text,
    ADD COLUMN source_mode text CHECK (source_mode IS NULL OR source_mode IN ('SHIP_TEXT', 'SUMMARY_ONLY')),
    ADD COLUMN publisher text;

  ALTER TABLE rag_corpus_versions ALTER COLUMN embedding_model DROP NOT NULL;
  ALTER TABLE rag_corpus_versions ALTER COLUMN dimensions DROP NOT NULL;
  ALTER TABLE rag_corpus_versions
    ADD COLUMN source text NOT NULL DEFAULT 'index-file' CHECK (source IN ('index-file', 'shipped-knowledge')),
    -- A version either has vectors for every chunk (embedding_model set) or for none.
    ADD CONSTRAINT rag_corpus_versions_embedding_pair CHECK ((embedding_model IS NULL) = (dimensions IS NULL));
END
$$;
