-- "Jest nowa wersja" (release-check.v1): what the worker's daily look at the project's GitHub Releases found, one row
-- for the server. The app reads it through GET /v1/app-config. safety_notified_version is the release the one push about
-- a safety fix went out for (compare and set, so a restart or a second worker does not send it again).

CREATE TABLE IF NOT EXISTS server_release_check (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  latest_version text NOT NULL,
  notes_url text NULL,
  safety_version text NULL,
  safety_notified_version text NULL,
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
