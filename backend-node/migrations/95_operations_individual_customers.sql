-- Explicit reporting classifications for customers who pay with personal credit.
CREATE TABLE IF NOT EXISTS operations_individual_customers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  added_by INTEGER REFERENCES users(id),
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operations_individual_project_ownership (
  drama_id INTEGER PRIMARY KEY REFERENCES dramas(id),
  user_id INTEGER NOT NULL REFERENCES operations_individual_customers(user_id),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operations_individual_project_ownership_user
  ON operations_individual_project_ownership(user_id, drama_id);
