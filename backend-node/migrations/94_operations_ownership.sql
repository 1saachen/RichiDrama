-- Reporting assignments do not change the projects, collaborators or ledger.
CREATE TABLE IF NOT EXISTS operations_project_ownership (
  drama_id INTEGER PRIMARY KEY REFERENCES dramas(id),
  scope TEXT NOT NULL CHECK (scope IN ('external', 'internal')),
  organization_id INTEGER REFERENCES customer_organizations(id),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'external' AND organization_id IS NOT NULL)
      OR (scope = 'internal' AND organization_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_operations_project_ownership_customer
  ON operations_project_ownership(organization_id, drama_id);

CREATE TABLE IF NOT EXISTS operations_internal_members (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  added_by INTEGER REFERENCES users(id),
  added_at TEXT NOT NULL
);
