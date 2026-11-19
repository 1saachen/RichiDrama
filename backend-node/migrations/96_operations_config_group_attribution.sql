-- Leave projects, member configuration, billing and earlier reports intact.
CREATE TABLE IF NOT EXISTS operations_pending_projects (
  drama_id INTEGER PRIMARY KEY REFERENCES dramas(id),
  marked_by INTEGER REFERENCES users(id),
  marked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operations_internal_member_exclusions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  removed_by INTEGER REFERENCES users(id),
  removed_at TEXT NOT NULL
);

CREATE VIEW IF NOT EXISTS operations_effective_members AS
  SELECT user_id,
    CASE WHEN ownership_kind='internal' THEN 'internal' ELSE 'external' END scope,
    CASE WHEN ownership_kind='organization' THEN organization_id END organization_id,
    CASE WHEN ownership_kind='individual' THEN user_id END individual_user_id
  FROM (
    SELECT u.id user_id, customer.id organization_id,
      CASE
        WHEN internal.user_id IS NOT NULL THEN 'internal'
        WHEN individual.user_id IS NOT NULL THEN 'individual'
        WHEN t.name='内部漫剧' AND shared.user_id IS NULL AND removed.user_id IS NULL THEN 'internal'
        WHEN customer.id IS NOT NULL AND (
          t.name='客户组' OR (
            t.id=customer.config_tenant_id AND t.name NOT IN ('默认项目组','内部漫剧')
            AND COALESCE(t.is_new_user_default,0)=0
            AND NOT EXISTS (SELECT 1 FROM customer_organizations other
              WHERE other.id<>customer.id AND other.config_tenant_id=t.id)
          )
        ) THEN 'organization'
        WHEN t.name='客户组' AND shared.user_id IS NULL AND u.account_kind='creator' THEN 'individual'
      END ownership_kind
    FROM users u
    LEFT JOIN tenant_memberships tm ON tm.user_id=u.id
    LEFT JOIN tenants t ON t.id=tm.tenant_id AND t.status='active'
    LEFT JOIN customer_organization_memberships shared ON shared.user_id=u.id
    LEFT JOIN customer_organizations customer ON customer.id=shared.organization_id
    LEFT JOIN operations_internal_members internal ON internal.user_id=u.id
    LEFT JOIN operations_individual_customers individual ON individual.user_id=u.id
    LEFT JOIN operations_internal_member_exclusions removed ON removed.user_id=u.id
  ) evidence
  WHERE ownership_kind IS NOT NULL;

CREATE VIEW IF NOT EXISTS operations_effective_projects AS
  SELECT drama_id,scope,organization_id,NULL individual_user_id FROM operations_project_ownership
  UNION ALL
  SELECT i.drama_id,'external',NULL,i.user_id FROM operations_individual_project_ownership i
  WHERE NOT EXISTS (SELECT 1 FROM operations_project_ownership p WHERE p.drama_id=i.drama_id)
  UNION ALL
  SELECT d.id,m.scope,m.organization_id,m.individual_user_id FROM dramas d
  JOIN operations_effective_members m ON m.user_id=d.owner_user_id
  WHERE NOT EXISTS (SELECT 1 FROM operations_project_ownership p WHERE p.drama_id=d.id)
    AND NOT EXISTS (SELECT 1 FROM operations_individual_project_ownership i WHERE i.drama_id=d.id)
    AND NOT EXISTS (SELECT 1 FROM operations_pending_projects p WHERE p.drama_id=d.id);
