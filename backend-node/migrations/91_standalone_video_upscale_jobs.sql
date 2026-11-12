CREATE TABLE IF NOT EXISTS standalone_video_upscale_jobs (
  id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_media_json TEXT NOT NULL,
  target_resolution TEXT,
  status TEXT NOT NULL CHECK (status IN ('ready','queued','submitting','processing','completed','failed','reconciliation')),
  authorization_id TEXT,
  config_id INTEGER,
  config_fingerprint TEXT,
  provider_task_id TEXT,
  provider_request_id TEXT,
  submitted_at TEXT,
  output_path TEXT,
  output_media_json TEXT,
  error_msg TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_standalone_upscale_owner
  ON standalone_video_upscale_jobs(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_standalone_upscale_status
  ON standalone_video_upscale_jobs(status, lease_until);
