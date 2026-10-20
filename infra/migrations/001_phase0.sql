BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  name text NOT NULL,
  scenario text NOT NULL,
  seed integer NOT NULL,
  include_comment_intent boolean NOT NULL DEFAULT true,
  status text NOT NULL CHECK (status IN ('created', 'running', 'stopped', 'completed')),
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  stopped_at timestamptz
);

CREATE TABLE IF NOT EXISTS live_events (
  event_id text PRIMARY KEY,
  dedupe_key text,
  tenant_id text NOT NULL,
  session_id text NOT NULL REFERENCES sessions(id),
  event_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL,
  source text NOT NULL,
  kind text NOT NULL,
  schema_version integer NOT NULL,
  provisional boolean NOT NULL,
  payload jsonb NOT NULL,
  metadata jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS live_events_session_dedupe_key
  ON live_events(session_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS live_events_session_time ON live_events(session_id, event_at, event_id);

CREATE TABLE IF NOT EXISTS product_rounds (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS advices (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS advice_feedback (
  id text PRIMARY KEY, advice_id text NOT NULL REFERENCES advices(id), payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS advice_executions (
  id text PRIMARY KEY, advice_id text NOT NULL REFERENCES advices(id), payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS advice_outcomes (
  id text PRIMARY KEY, advice_id text NOT NULL REFERENCES advices(id), payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS detected_events (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS case_cards (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), payload jsonb NOT NULL, embedding vector(1536)
);
CREATE TABLE IF NOT EXISTS model_runs (
  id text PRIMARY KEY, session_id text REFERENCES sessions(id), payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS source_health_logs (
  id bigserial PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), source_id text NOT NULL,
  checked_at timestamptz NOT NULL, payload jsonb NOT NULL
);
COMMIT;

