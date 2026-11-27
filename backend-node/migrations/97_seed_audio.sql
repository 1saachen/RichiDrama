CREATE TABLE IF NOT EXISTS seed_audio_local_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_key TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seed_audio_jobs (
  id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'finalizing', 'completed', 'failed', 'pending_reconciliation')),
  key_updated_at TEXT NOT NULL,
  authorization_id TEXT REFERENCES billing_transactions(id),
  provider_request_id TEXT,
  duration_ms INTEGER,
  local_path TEXT,
  output_asset_id INTEGER REFERENCES assets(id),
  error_msg TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_user_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_seed_audio_jobs_owner_created
  ON seed_audio_jobs (owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_seed_audio_jobs_recovery
  ON seed_audio_jobs (status, lease_until);
