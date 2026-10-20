BEGIN;
CREATE TABLE IF NOT EXISTS live_pilot_auth (
  session_id text PRIMARY KEY REFERENCES sessions(id),
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL
);
COMMIT;
