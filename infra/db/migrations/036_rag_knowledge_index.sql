-- RAG knowledge index (stage 2: stored only, the assistant does not read it yet). Chunks of guideline and manual text
-- (ISPAD, Trio, Dexcom, SmPC) with text-embedding-3-small vectors, loaded by infra/db/rag-index-load.ts. One corpus
-- version is in rag_chunks at a time; rag_corpus_versions keeps the load history.
--
-- Needs the pgvector extension: production runs the pgvector/pgvector:pg17 image (deploy/mikrus/README.md). On a
-- Postgres without it this migration stops with the message below and the whole migrate run rolls back.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE EXCEPTION 'pgvector extension is not available on this Postgres server (036_rag_knowledge_index.sql needs it)'
      USING HINT = 'Run Postgres from the pgvector/pgvector:pg17 image (see deploy/mikrus/README.md) or install pgvector locally (brew install pgvector).';
  END IF;
END
$$;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE rag_corpus_versions (
  version text PRIMARY KEY CHECK (length(version) BETWEEN 1 AND 100),
  embedding_model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions = 1536),
  chunk_count integer NOT NULL CHECK (chunk_count >= 0),
  -- sha256 of the loaded rag-index.json and its created_at, to tell which local index a version came from.
  index_sha256 text NOT NULL,
  index_created_at timestamptz,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX rag_corpus_versions_single_active ON rag_corpus_versions (active) WHERE active;

CREATE TABLE rag_chunks (
  id text PRIMARY KEY,
  corpus_version text NOT NULL REFERENCES rag_corpus_versions(version),
  source_file text NOT NULL,
  title text NOT NULL,
  section text,
  page integer,
  page_end integer,
  kind text CHECK (kind IS NULL OR kind = 'table'),
  text text NOT NULL,
  tokens_estimate integer NOT NULL,
  -- Reference-list chunks match questions by paper-title words but carry no answer; search skips them by default.
  is_reference_list boolean NOT NULL,
  embedding vector(1536) NOT NULL,
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, title || ' ' || coalesce(section, '') || ' ' || text)
  ) STORED
);

-- ~1000 chunks: exact cosine search (ORDER BY embedding <=> $1) is a few ms, so no ivfflat/hnsw index.
CREATE INDEX rag_chunks_corpus_version_idx ON rag_chunks (corpus_version);
CREATE INDEX rag_chunks_search_tsv_idx ON rag_chunks USING gin (search_tsv);
