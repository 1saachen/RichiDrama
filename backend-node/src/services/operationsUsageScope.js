class InvalidOperationsUsageScope extends Error {}

function attributionId(value, message) {
  if (value == null || value === '') return null;
  if (!['number', 'string'].includes(typeof value)) throw new InvalidOperationsUsageScope(message);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new InvalidOperationsUsageScope(message);
  return id;
}

function parseOperationsUsageScope(input) {
  const scope = input.ops_scope ?? '';
  if (!['', 'all', 'external', 'internal', 'pending'].includes(scope)) {
    throw new InvalidOperationsUsageScope('消耗归属筛选无效');
  }
  const customerId = attributionId(input.ops_customer_id, '归属客户筛选无效');
  const individualId = attributionId(input.ops_individual_id, '独立客户筛选无效');
  if (customerId != null && individualId != null) {
    throw new InvalidOperationsUsageScope('客户账户与独立客户筛选不能同时使用');
  }
  return { scope, customerId, individualId, enabled: !!scope || customerId != null || individualId != null };
}

function operationsUsageTables(db) {
  return new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN (
    'operations_project_ownership','operations_internal_members','customer_organizations',
    'operations_individual_customers','operations_individual_project_ownership',
    'operations_effective_members','operations_effective_projects'
  )`).pluck().all());
}

function operationsProjectAssignments(db, tables = operationsUsageTables(db)) {
  if (tables.has('operations_effective_projects')) {
    return db.prepare('SELECT * FROM operations_effective_projects').all();
  }
  const projects = tables.has('operations_project_ownership')
    ? db.prepare('SELECT drama_id,scope,organization_id,NULL individual_user_id FROM operations_project_ownership').all()
    : [];
  if (!tables.has('operations_individual_project_ownership')) return projects;
  const mappedProjects = new Set(projects.map(project => project.drama_id));
  const individuals = db.prepare(`SELECT drama_id,'external' scope,NULL organization_id,user_id individual_user_id
    FROM operations_individual_project_ownership`).all();
  return projects.concat(individuals.filter(project => !mappedProjects.has(project.drama_id)));
}

function operationsInternalMemberIds(db, tables = operationsUsageTables(db)) {
  if (tables.has('operations_effective_members')) {
    return db.prepare("SELECT user_id FROM operations_effective_members WHERE scope='internal'").pluck().all();
  }
  return tables.has('operations_internal_members')
    ? db.prepare('SELECT user_id FROM operations_internal_members').pluck().all() : [];
}

function operationsIndividualCustomers(db, tables = operationsUsageTables(db)) {
  const source = tables.has('operations_effective_members') ? 'operations_effective_members' : 'operations_individual_customers';
  if (!tables.has(source)) return [];
  const condition = source === 'operations_effective_members' ? 'WHERE c.individual_user_id IS NOT NULL' : '';
  return db.prepare(`SELECT u.id,COALESCE(NULLIF(TRIM(u.display_name),''),u.username) name
    FROM ${source} c JOIN users u ON u.id=c.user_id ${condition} ORDER BY name,u.id`).all();
}

function projectAttribution(tables, projectId) {
  if (tables.has('operations_effective_projects')) {
    const assignment = column => `(SELECT p.${column} FROM operations_effective_projects p WHERE p.drama_id=${projectId})`;
    return {
      scope: `COALESCE(${assignment('scope')},'pending')`,
      customerId: assignment('organization_id'),
      individualId: assignment('individual_user_id'),
    };
  }
  const assignment = (column) => tables.has('operations_project_ownership')
    ? `(SELECT p.${column} FROM operations_project_ownership p WHERE p.drama_id=${projectId})`
    : 'NULL';
  const individual = tables.has('operations_individual_project_ownership')
    ? `(SELECT ip.user_id FROM operations_individual_project_ownership ip WHERE ip.drama_id=${projectId})`
    : 'NULL';
  const projectScope = assignment('scope');
  return {
    scope: `COALESCE(${projectScope}, CASE WHEN ${individual} IS NOT NULL THEN 'external' ELSE 'pending' END)`,
    customerId: assignment('organization_id'),
    individualId: `CASE WHEN ${projectScope} IS NULL THEN ${individual} END`,
  };
}

function unassignedAttribution(tables) {
  const originalPayer = 'l.organization_id>0';
  const accountScope = (column) => `json_extract(CASE WHEN json_valid(${column}) THEN ${column} END,'$.account_scope')`;
  const recordedScope = accountScope('l.snapshot_json');
  const authorizationScope = `(SELECT ${accountScope('auth.snapshot_json')} FROM billing_transactions auth WHERE auth.id=l.authorization_id AND auth.type='authorization')`;
  const effectiveMembers = tables.has('operations_effective_members');
  const individualCustomer = effectiveMembers
    ? 'EXISTS (SELECT 1 FROM operations_effective_members m WHERE m.user_id=l.user_id AND m.individual_user_id IS NOT NULL)'
    : tables.has('operations_individual_customers')
      ? 'EXISTS (SELECT 1 FROM operations_individual_customers ic WHERE ic.user_id=l.user_id)' : '0';
  const individual = `(${individualCustomer} AND COALESCE(NULLIF(NULLIF(${recordedScope},''),0),${authorizationScope})='personal')`;
  const internal = effectiveMembers
    ? "EXISTS (SELECT 1 FROM operations_effective_members m WHERE m.user_id=l.user_id AND m.scope='internal')"
    : tables.has('operations_internal_members')
      ? 'EXISTS (SELECT 1 FROM operations_internal_members im WHERE im.user_id=l.user_id)' : '0';
  return {
    scope: `CASE WHEN ${originalPayer} OR ${individual} THEN 'external' WHEN ${internal} THEN 'internal' ELSE 'pending' END`,
    customerId: `CASE WHEN ${originalPayer} THEN l.organization_id END`,
    individualId: `CASE WHEN ${originalPayer} THEN NULL WHEN ${individual} THEN l.user_id END`,
  };
}

// Mirror the operations attribution precedence in cost activity. SQL applies
// the filter before aggregation and pagination, with no effect on payer IDs.
function operationsUsageFilter(db, input, { kind = 'usage', projectId = 'l.drama_id' } = {}) {
  const { scope, customerId, individualId, enabled } = parseOperationsUsageScope(input);
  const filters = Object.entries({ scope: scope && scope !== 'all' ? scope : null, customerId, individualId })
    .filter(([, value]) => value != null);
  if (!filters.length) return { enabled, where: '', params: [] };

  const tables = operationsUsageTables(db);
  const project = kind !== 'unassigned' ? projectAttribution(tables, projectId) : null;
  const unassigned = kind !== 'project' ? unassignedAttribution(tables) : null;
  const clauses = filters.map(([key]) => {
    const attribution = project && unassigned
      ? `CASE WHEN ${projectId} IS NOT NULL THEN ${project[key]} ELSE ${unassigned[key]} END`
      : (project || unassigned)[key];
    return `(${attribution})=?`;
  });
  return { enabled, where: ' AND ' + clauses.join(' AND '), params: filters.map(([, value]) => value) };
}

module.exports = {
  InvalidOperationsUsageScope, parseOperationsUsageScope, operationsUsageTables, operationsUsageFilter,
  operationsProjectAssignments, operationsInternalMemberIds, operationsIndividualCustomers,
};
