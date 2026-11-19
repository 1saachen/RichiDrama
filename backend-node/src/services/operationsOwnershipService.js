'use strict';

const { audit } = require('./billingService');
const { operationsInternalMemberIds } = require('./operationsUsageScope');

const CUSTOMERS = `
  SELECT o.id,o.name,o.status,o.config_tenant_id,t.name config_tenant_name,
    CASE
      WHEN t.id IS NULL OR t.status <> 'active' THEN 'missing'
      WHEN t.name = '默认项目组' OR t.is_new_user_default = 1
        OR EXISTS (SELECT 1 FROM customer_organizations other WHERE other.config_tenant_id=t.id AND other.id<>o.id)
        OR EXISTS (
          SELECT 1 FROM tenant_memberships tm
          WHERE tm.tenant_id=t.id AND NOT EXISTS (
            SELECT 1 FROM customer_organization_memberships cm WHERE cm.organization_id=o.id AND cm.user_id=tm.user_id
          )
        ) THEN 'shared'
      ELSE 'dedicated'
    END config_group_state
  FROM customer_organizations o LEFT JOIN tenants t ON t.id=o.config_tenant_id`;

const INDIVIDUAL_USERS = `
  SELECT u.id,u.username,u.display_name,t.id config_tenant_id,t.name config_tenant_name
  FROM users u LEFT JOIN tenant_memberships tm ON tm.user_id=u.id
  LEFT JOIN tenants t ON t.id=tm.tenant_id`;

const INDIVIDUAL_ELIGIBILITY = `
  u.account_kind='creator' AND u.is_active=1
  AND NOT EXISTS (SELECT 1 FROM customer_organization_memberships m WHERE m.user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM operations_effective_members m WHERE m.user_id=u.id AND m.scope='internal')`;

function positiveId(value, error) {
  const id = Number(value);
  if (!['string', 'number'].includes(typeof value) || !Number.isSafeInteger(id) || id <= 0) throw new Error(error);
  return id;
}

function individualCustomer(row) {
  return {
    id: row.id,
    name: row.display_name || row.username,
    config_tenant_id: row.config_tenant_id,
    config_tenant_name: row.config_tenant_name,
    members: [{ id: row.id, username: row.username, display_name: row.display_name }],
    projects: [],
  };
}

function tree(db) {
  const customers = db.prepare(`${CUSTOMERS} ORDER BY o.id`).all()
    .map(row => ({ ...row, members: [], projects: [] }));
  const byId = new Map(customers.map(customer => [customer.id, customer]));
  const memberRows = db.prepare(`
    SELECT m.organization_id,u.id,u.username,u.display_name,m.role membership_role
    FROM customer_organization_memberships m
    JOIN users u ON u.id=m.user_id ORDER BY u.id`).all();
  for (const { organization_id, ...member } of memberRows) byId.get(organization_id)?.members.push(member);

  const individualCustomers = db.prepare(`
    ${INDIVIDUAL_USERS} JOIN operations_effective_members m ON m.individual_user_id=u.id ORDER BY u.id
  `).all().map(individualCustomer);
  const individualById = new Map(individualCustomers.map(customer => [customer.id, customer]));

  const internal = {
    members: db.prepare(`
      SELECT u.id,u.username,u.display_name FROM operations_effective_members m
      JOIN users u ON u.id=m.user_id WHERE m.scope='internal' ORDER BY u.id`).all(),
    projects: [],
  };
  const pending = { projects: [] };
  const rows = db.prepare(`
    SELECT d.id,d.title,p.scope,p.organization_id,p.individual_user_id FROM dramas d
    LEFT JOIN operations_effective_projects p ON p.drama_id=d.id
    WHERE d.deleted_at IS NULL ORDER BY d.id DESC`).all();
  for (const { scope, organization_id, individual_user_id, ...project } of rows) {
    const group = individualById.get(individual_user_id) || (scope === 'internal' ? internal : byId.get(organization_id)) || pending;
    group.projects.push(project);
  }
  return {
    customers, individual_customers: individualCustomers, internal, pending,
    available_users: db.prepare(`
      SELECT u.id,u.username,u.display_name FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM operations_individual_customers i WHERE i.user_id=u.id)
      ORDER BY u.id
    `).all(),
    available_individual_users: db.prepare(`
      ${INDIVIDUAL_USERS} WHERE ${INDIVIDUAL_ELIGIBILITY}
      AND NOT EXISTS (SELECT 1 FROM operations_effective_members m WHERE m.individual_user_id=u.id) ORDER BY u.id
    `).all(),
  };
}

function addIndividualCustomer(db, actorId, userId) {
  const id = positiveId(userId, '无效的独立客户账号 ID');
  return db.transaction(() => {
    const row = db.prepare(`
      ${INDIVIDUAL_USERS} LEFT JOIN operations_individual_customers i ON i.user_id=u.id
      WHERE u.id=? AND (i.user_id IS NOT NULL OR (${INDIVIDUAL_ELIGIBILITY}))
    `).get(id);
    if (!row) throw new Error('请选择未加入共享客户账户或内部漫剧的有效创作账号');
    const insert = db.prepare(`
      INSERT INTO operations_individual_customers(user_id,added_by,added_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO NOTHING
    `).run(id, actorId, new Date().toISOString());
    if (insert.changes) audit(db, actorId, 'operations.individual_customer.add', 'user', id, {});
    return { user_id: id };
  }).immediate();
}

function setProject(db, actorId, dramaId, input) {
  const id = positiveId(dramaId, '无效的项目 ID');
  const scope = input.scope;
  if (!['external', 'internal', 'pending'].includes(scope)) throw new Error('请选择项目归属');
  const hasOrganization = input.organization_id != null;
  const hasIndividual = input.individual_user_id != null;
  if (scope === 'external' && hasOrganization === hasIndividual) throw new Error('请选择一个外部客户');
  if (scope !== 'external' && (hasOrganization || hasIndividual)) throw new Error('客户账号仅适用于外部客户归属');
  const organizationId = hasOrganization ? positiveId(input.organization_id, '请选择客户账户') : null;
  const individualId = hasIndividual ? positiveId(input.individual_user_id, '请选择独立客户') : null;
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM dramas WHERE id=? AND deleted_at IS NULL').get(id)) throw new Error('项目不存在');
    if (organizationId && !db.prepare('SELECT 1 FROM customer_organizations WHERE id=?').get(organizationId)) {
      throw new Error('客户账户不存在');
    }
    if (individualId && !db.prepare('SELECT 1 FROM operations_individual_customers WHERE user_id=?').get(individualId)) {
      if (!db.prepare('SELECT 1 FROM operations_effective_members WHERE individual_user_id=?').get(individualId)) {
        throw new Error('独立客户不存在');
      }
      addIndividualCustomer(db, actorId, individualId);
    }
    const before = db.prepare(`SELECT scope,organization_id,individual_user_id
      FROM operations_effective_projects WHERE drama_id=?`).get(id) || { scope: 'pending', organization_id: null };
    const next = { scope, organization_id: organizationId, ...(individualId ? { individual_user_id: individualId } : {}) };
    const explicit = db.prepare(`SELECT 1 FROM operations_project_ownership WHERE drama_id=@id
      UNION ALL SELECT 1 FROM operations_individual_project_ownership WHERE drama_id=@id
      UNION ALL SELECT 1 FROM operations_pending_projects WHERE drama_id=@id LIMIT 1`).get({ id });
    if (explicit && before.scope === next.scope && before.organization_id === next.organization_id &&
      (before.individual_user_id || null) === individualId) return { id, ...next };

    const at = new Date().toISOString();
    if (individualId || scope === 'pending') db.prepare('DELETE FROM operations_project_ownership WHERE drama_id=?').run(id);
    else db.prepare(`
      INSERT INTO operations_project_ownership(drama_id,scope,organization_id,updated_by,updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(drama_id) DO UPDATE SET scope=excluded.scope,
      organization_id=excluded.organization_id,updated_by=excluded.updated_by,updated_at=excluded.updated_at
    `).run(id, scope, organizationId, actorId, at);

    if (individualId) db.prepare(`
      INSERT INTO operations_individual_project_ownership(drama_id,user_id,updated_by,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(drama_id) DO UPDATE SET user_id=excluded.user_id,updated_by=excluded.updated_by,updated_at=excluded.updated_at
    `).run(id, individualId, actorId, at);
    else db.prepare('DELETE FROM operations_individual_project_ownership WHERE drama_id=?').run(id);

    if (scope === 'pending') db.prepare(`
      INSERT INTO operations_pending_projects(drama_id,marked_by,marked_at) VALUES (?,?,?)
      ON CONFLICT(drama_id) DO NOTHING
    `).run(id, actorId, at);
    else db.prepare('DELETE FROM operations_pending_projects WHERE drama_id=?').run(id);

    audit(db, actorId, 'operations.project_ownership.set', 'drama', id, { before, after: next });
    return { id, ...next };
  }).immediate();
}

function replaceInternalMembers(db, actorId, userIds) {
  if (!Array.isArray(userIds)) throw new Error('成员列表无效');
  const next = new Set(userIds.map(value => positiveId(value, '成员列表无效')));
  if (next.size !== userIds.length) throw new Error('成员列表有重复账号');
  return db.transaction(() => {
    const existingUser = db.prepare('SELECT 1 FROM users WHERE id=?');
    const independent = db.prepare('SELECT 1 FROM operations_individual_customers WHERE user_id=?');
    for (const id of next) {
      if (!existingUser.get(id)) throw new Error('成员不存在');
      if (independent.get(id)) throw new Error('已标记为独立客户的账号不能归入内部漫剧');
    }
    const current = new Set(operationsInternalMemberIds(db));
    const added = [...next].filter(id => !current.has(id));
    const removed = [...current].filter(id => !next.has(id));
    if (added.length || removed.length) {
      const remove = db.prepare('DELETE FROM operations_internal_members WHERE user_id=?');
      const exclude = db.prepare(`INSERT INTO operations_internal_member_exclusions(user_id,removed_by,removed_at) VALUES (?,?,?)
        ON CONFLICT(user_id) DO NOTHING`);
      const reinstate = db.prepare('DELETE FROM operations_internal_member_exclusions WHERE user_id=?');
      const insert = db.prepare('INSERT INTO operations_internal_members(user_id,added_by,added_at) VALUES (?,?,?)');
      const at = new Date().toISOString();
      for (const id of removed) {
        remove.run(id);
        exclude.run(id, actorId, at);
      }
      for (const id of added) {
        reinstate.run(id);
        insert.run(id, actorId, at);
      }
      audit(db, actorId, 'operations.internal_members.replace', 'operations_internal', null, { added, removed });
    }
    return { user_ids: [...next].sort((a, b) => a - b) };
  }).immediate();
}

function cloneBindings(db, sourceId, targetId, actorId, at) {
  db.prepare(`
    INSERT INTO tenant_ai_config_bindings (tenant_id,service_type,ai_config_id,is_active,priority,is_default,created_at,updated_at)
    SELECT ?,service_type,ai_config_id,is_active,priority,is_default,?,? FROM tenant_ai_config_bindings
    WHERE tenant_id=? ORDER BY id
  `).run(targetId, at, at, sourceId);
  db.prepare(`
    INSERT INTO tenant_sd2_config_bindings (tenant_id,ai_config_id,is_active,created_at,updated_at)
    SELECT ?,ai_config_id,is_active,?,? FROM tenant_sd2_config_bindings WHERE tenant_id=? ORDER BY id
  `).run(targetId, at, at, sourceId);
  db.prepare(`
    INSERT INTO tenant_price_book_bindings (tenant_id,price_book_id,active_at,created_by,updated_at)
    SELECT ?,price_book_id,active_at,?,? FROM tenant_price_book_bindings WHERE tenant_id=?
  `).run(targetId, actorId, at, sourceId);
  db.prepare(`
    INSERT INTO tenant_provider_price_book_bindings (tenant_id,provider,price_book_id,active_at,created_by,updated_at)
    SELECT ?,provider,price_book_id,active_at,?,? FROM tenant_provider_price_book_bindings WHERE tenant_id=? ORDER BY rowid
  `).run(targetId, actorId, at, sourceId);
}

function ensureCustomerConfigGroup(db, actorId, organizationId) {
  const id = positiveId(organizationId, '无效的客户账户 ID');
  return db.transaction(() => {
    const selectCustomer = db.prepare(`${CUSTOMERS} WHERE o.id=?`);
    const customer = selectCustomer.get(id);
    if (!customer) throw new Error('客户账户不存在');
    if (customer.config_group_state === 'dedicated') return customer;
    const members = db.prepare(`
      SELECT m.user_id,m.role organization_role,tm.role tenant_role,t.id effective_tenant_id
      FROM customer_organization_memberships m LEFT JOIN tenant_memberships tm ON tm.user_id=m.user_id
      LEFT JOIN tenants t ON t.id=tm.tenant_id AND t.status='active' WHERE m.organization_id=?
    `).all(id);
    const effectiveIds = new Set(members.map(member => member.effective_tenant_id));
    if (effectiveIds.size > 1) throw new Error('该客户成员当前使用不同配置组，请先核对成员配置');
    const sourceId = members.length ? members[0].effective_tenant_id : customer.config_tenant_id;
    const source = db.prepare("SELECT id,uses_legacy_global_configs FROM tenants WHERE id=? AND status='active'").get(sourceId);

    const baseName = `${customer.name} · 专属配置组 #${id}`;
    let name = baseName;
    let suffix = 2;
    const hasName = db.prepare('SELECT 1 FROM tenants WHERE name=?');
    while (hasName.get(name)) name = `${baseName}-${suffix++}`;
    const at = new Date().toISOString();
    const targetId = Number(db.prepare(`
      INSERT INTO tenants(name,status,uses_legacy_global_configs,created_by,created_at,updated_at)
      VALUES (?,'active',?,?,?,?)
    `).run(name, source?.uses_legacy_global_configs || 0, actorId, at, at).lastInsertRowid);
    // Copy bindings to the same approved configuration IDs, never credentials or
    // model and price overrides. The new grouping only affects future requests.
    if (source) cloneBindings(db, source.id, targetId, actorId, at);
    const bindMember = db.prepare(`
      INSERT INTO tenant_memberships(tenant_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET tenant_id=excluded.tenant_id,updated_at=excluded.updated_at
    `);
    for (const member of members) {
      const role = member.tenant_role || (member.organization_role === 'organization_admin' ? 'tenant_admin' : 'creator');
      bindMember.run(targetId, member.user_id, role, at, at);
    }
    db.prepare('UPDATE customer_organizations SET config_tenant_id=?,updated_at=? WHERE id=?').run(targetId, at, id);
    audit(db, actorId, 'operations.customer_config_group.allocate', 'customer_organization', id, {
      previous_tenant_id: customer.config_tenant_id, source_tenant_id: source?.id ?? null, config_tenant_id: targetId,
    });
    return selectCustomer.get(id);
  }).immediate();
}

module.exports = { tree, addIndividualCustomer, setProject, replaceInternalMembers, ensureCustomerConfigGroup };
