-- Opt-in metadata only. Existing generations and billing records are unchanged.
CREATE TABLE IF NOT EXISTS video_draft_tasks (
  generation_id INTEGER PRIMARY KEY REFERENCES video_generations(id),
  stage TEXT NOT NULL CHECK(stage IN ('draft', 'final')),
  source_generation_id INTEGER UNIQUE REFERENCES video_generations(id),
  request_key TEXT NOT NULL UNIQUE,
  config_id INTEGER NOT NULL,
  config_fingerprint TEXT NOT NULL,
  has_video_input INTEGER NOT NULL DEFAULT 0,
  has_audio_input INTEGER NOT NULL DEFAULT 0,
  provider_draft INTEGER,
  provider_created_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
