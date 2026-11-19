const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/services/authService');
const ai = require('../src/services/aiConfigService');
const billing = require('../src/services/billingService');
const organizations = require('../src/services/customerOrganizationService');
const tenants = require('../src/services/tenantService');
const { modelCatalogFixture } = require('./helpers/modelCatalogFixture');
const { seedCostActivity } = require('./helpers/costActivityFixture');

async function login(fixture, username) {
  const result = await fixture.request('POST', '/auth/login', { username, password: 'fixture-password' });
  assert.equal(result.status, 200);
  return result.cookie;
}

async function request(fixture, cookie, method, suffix = '', body) {
  const result = await fixture.request(method, '/admin/ownership' + suffix, body, cookie);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.data;
}

function ledgerRows(db) {
  return {
    accounts: db.prepare('SELECT * FROM organization_billing_accounts ORDER BY organization_id').all(),
    transactions: db.prepare('SELECT * FROM billing_transactions ORDER BY id').all(),
    usage: db.prepare('SELECT * FROM billing_usage_logs ORDER BY id').all(),
  };
}

test('admin can assign customer and internal projects; unknown projects and historical ledger survive restart', async () => {
  const fixture = await modelCatalogFixture();
  try {
    const { db, admin } = fixture;
    const member = auth.createUser(db, { username: 'external-member', password: 'fixture-password' }, admin.id);
    const internal = auth.createUser(db, { username: 'internal-member', password: 'fixture-password' }, admin.id);
    const sourceTenant = tenants.tenantForUser(db, member.id);
    const customer = organizations.saveOrganization(db, admin.id, { name: '客户甲', config_tenant_id: sourceTenant.id });
    organizations.replaceMembers(db, customer.id, [member.id]);
    seedCostActivity(db, member.id);
    const createProject = db.prepare('INSERT INTO dramas(id,title,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?)');
    createProject.run(74, '内部项目', internal.id, '2026-09-01', '2026-09-01');
    createProject.run(75, '待核项目', member.id, '2026-09-01', '2026-09-01');
    const ledger = ledgerRows(db);
    const authorizations = db.prepare('SELECT id,owner_user_id FROM dramas ORDER BY id').all();
    const memberCookie = await login(fixture, member.username);
    const adminCookie = await login(fixture, admin.username);
    assert.equal((await fixture.request('GET', '/admin/ownership')).status, 401);
    assert.equal((await fixture.request('GET', '/admin/ownership', undefined, memberCookie)).status, 403);
    assert.equal((await fixture.request('PUT', '/admin/ownership/projects/73', { scope: 'internal' }, memberCookie)).status, 403);
    let tree = await request(fixture, adminCookie, 'GET');
    assert.deepEqual(tree.pending.projects.map(project => project.id), [75, 74, 73]);
    assert.equal(tree.customers[0].members[0].id, member.id);
    assert.equal(tree.customers[0].config_group_state, 'shared');
    assert.deepEqual(tree.customers[0].projects, []);
    assert.deepEqual(tree.internal.members, []);

    const missingCustomer = await fixture.request('PUT', '/admin/ownership/projects/73', { scope: 'external', organization_id: 999 }, adminCookie);
    assert.equal(missingCustomer.status, 400);
    assert.equal((await fixture.request('PUT', '/admin/ownership/internal-members', { user_ids: [internal.id, 999] }, adminCookie)).status, 400);
    await request(fixture, adminCookie, 'PUT', '/projects/73', { scope: 'external', organization_id: customer.id });
    await request(fixture, adminCookie, 'PUT', '/projects/74', { scope: 'internal' });
    await request(fixture, adminCookie, 'PUT', '/internal-members', { user_ids: [internal.id] });
    await request(fixture, adminCookie, 'PUT', '/projects/75', { scope: 'external', organization_id: customer.id });
    await request(fixture, adminCookie, 'PUT', '/projects/75', { scope: 'pending' });
    tree = await request(fixture, adminCookie, 'GET');
    assert.deepEqual(tree.customers[0].projects.map(project => project.id), [73]);
    assert.deepEqual(tree.internal.projects, [{ id: 74, title: '内部项目' }]);
    assert.deepEqual(tree.internal.members.map(user => user.id), [internal.id]);
    assert.deepEqual(tree.pending.projects, [{ id: 75, title: '待核项目' }]);
    assert.deepEqual(ledgerRows(db), ledger);
    assert.deepEqual(db.prepare('SELECT id,owner_user_id FROM dramas ORDER BY id').all(), authorizations);

    await fixture.restart();
    assert.deepEqual(await request(fixture, adminCookie, 'GET'), tree);
    assert.deepEqual(ledgerRows(fixture.db), ledger);
  } finally {
    await fixture.close();
  }
});

test('existing config groups can classify costs without rewriting history and explicit choices survive restart', async () => {
  const fixture = await modelCatalogFixture();
  try {
    const { db, admin } = fixture;
    const internalGroup = tenants.writeTenant(db, admin.id, { name: '内部漫剧' });
    const customerGroup = tenants.writeTenant(db, admin.id, { name: '客户组' });
    const createUser = username => auth.createUser(db, { username, password: 'fixture-password' }, admin.id);
    const internal = createUser('legacy-internal-creator');
    const independent = createUser('legacy-personal-customer');
    const shared = createUser('legacy-shared-member');
    const unknown = createUser('legacy-unclassified-creator');
    tenants.setMember(db, internalGroup.id, internal.id, 'creator');
    tenants.setMember(db, customerGroup.id, independent.id, 'creator');
    const customer = organizations.saveOrganization(db, admin.id, { name: '原共享客户', config_tenant_id: customerGroup.id });
    organizations.replaceMembers(db, customer.id, [shared.id]);
    seedCostActivity(db, internal.id, 73);
    const createProject = db.prepare('INSERT INTO dramas(id,title,owner_user_id,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?)');
    const at = '2026-09-01T00:00:00.000Z';
    createProject.run(74, '归档内部项目', internal.id, at, at, at);
    createProject.run(75, '共享客户项目', shared.id, at, at, null);
    createProject.run(76, '独立客户项目', independent.id, at, at, null);
    createProject.run(77, '未知项目', unknown.id, at, at, null);
    const ledger = ledgerRows(db);
    const projectRows = db.prepare('SELECT * FROM dramas ORDER BY id').all();
    const configRows = db.prepare('SELECT * FROM tenant_memberships ORDER BY user_id').all();
    const cookie = await login(fixture, admin.username);
    const getCosts = async query => {
      const result = await fixture.request('GET', '/admin/costs/' + query, undefined, cookie);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body.data;
    };

    const unscoped = await getCosts('activity');
    let tree = await request(fixture, cookie, 'GET');
    assert.deepEqual(tree.internal.members.map(row => row.id), [internal.id]);
    assert.deepEqual(tree.internal.projects.map(row => row.id), [73]);
    assert.deepEqual(tree.customers[0].projects.map(row => row.id), [75]);
    assert.deepEqual(tree.individual_customers[0].projects.map(row => row.id), [76]);
    assert.deepEqual(tree.pending.projects.map(row => row.id), [77]);
    assert.deepEqual((await getCosts('filter-options?ops_scope=internal&scoped_usage=1')).projects.map(row => row.id), [74, 73]);
    const scoped = await getCosts('activity?ops_scope=internal');
    assert.ok(scoped.calls.total > 0);
    assert.deepEqual(scoped.summary, unscoped.summary);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM operations_project_ownership').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM operations_internal_members').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM operations_individual_customers').get().n, 0);

    await request(fixture, cookie, 'PUT', '/projects/73', { scope: 'pending' });
    assert.deepEqual((await getCosts('activity?ops_scope=pending')).summary, unscoped.summary);
    await request(fixture, cookie, 'PUT', '/internal-members', { user_ids: [independent.id] });
    const internalOptions = await getCosts('filter-options?ops_scope=internal&scoped_usage=1');
    assert.deepEqual(internalOptions.projects.map(row => row.id), [76]);
    await request(fixture, cookie, 'PUT', '/internal-members', { user_ids: [] });
    await request(fixture, cookie, 'PUT', '/projects/77', { scope: 'external', individual_user_id: independent.id });
    tree = await request(fixture, cookie, 'GET');
    assert.deepEqual(tree.pending.projects.map(row => row.id), [73]);
    assert.deepEqual(tree.individual_customers[0].projects.map(row => row.id), [77, 76]);
    assert.deepEqual((await getCosts('activity')).summary, unscoped.summary);

    await fixture.restart();
    assert.deepEqual(await request(fixture, cookie, 'GET'), tree);
    assert.deepEqual((await getCosts('activity?ops_scope=pending')).summary, unscoped.summary);
    assert.deepEqual(ledgerRows(fixture.db), ledger);
    assert.deepEqual(fixture.db.prepare('SELECT * FROM dramas ORDER BY id').all(), projectRows);
    assert.deepEqual(fixture.db.prepare('SELECT * FROM tenant_memberships ORDER BY user_id').all(), configRows);
  } finally {
    await fixture.close();
  }
});

test('an explicit group allocation preserves configuration bindings, roles and payer history and is idempotent', async () => {
  const fixture = await modelCatalogFixture();
  try {
    const { db, admin, config, book } = fixture;
    const memberA = auth.createUser(db, { username: 'config-member-a', password: 'fixture-password' }, admin.id);
    const memberB = auth.createUser(db, { username: 'config-member-b', password: 'fixture-password' }, admin.id);
    const source = tenants.writeTenant(db, admin.id, { name: '既有共享配置组' });
    tenants.replaceBindings(db, source.id, {
      ai_configs: [{ id: config.id, is_default: true, priority: 5 }],
      price_book_bindings: [{ provider: '', price_book_id: book.id }],
    });
    const customerA = organizations.saveOrganization(db, admin.id, { name: '配置客户 A', config_tenant_id: source.id });
    const customerB = organizations.saveOrganization(db, admin.id, { name: '配置客户 B', config_tenant_id: source.id });
    organizations.replaceMembers(db, customerA.id, [{ user_id: memberA.id, role: 'organization_admin' }]);
    organizations.replaceMembers(db, customerB.id, [memberB.id]);
    const missingId = Number(db.prepare('INSERT INTO customer_organizations (name,config_tenant_id,created_at,updated_at) VALUES (?,?,?,?)')
      .run('配置待补客户', 999, '2026-09-01', '2026-09-01').lastInsertRowid);
    seedCostActivity(db, memberA.id);
    const ledger = ledgerRows(db);
    const configIds = tenantId => ai.listConfigs(db, 'image', { tenant_id: tenantId, scene_defaults: false }).map(item => [item.id, item.is_default, item.priority]);
    const beforeConfigs = configIds(source.id);
    const beforePrice = tenants.priceBookForUser(db, memberA.id, config.provider);
    const cookie = await login(fixture, admin.username);
    const initial = await request(fixture, cookie, 'GET');
    assert.deepEqual(initial.customers.map(customer => customer.config_group_state), ['shared', 'shared', 'missing']);
    const path = `/customers/${customerA.id}/config-group`;
    const result = await request(fixture, cookie, 'POST', path);
    assert.notEqual(result.config_tenant_id, source.id);
    assert.equal(result.config_group_state, 'dedicated');
    assert.ok(result.config_tenant_name.includes(customerA.name));
    assert.deepEqual(configIds(result.config_tenant_id), beforeConfigs);
    assert.deepEqual(tenants.priceBookForUser(db, memberA.id, config.provider), beforePrice);
    assert.equal(tenants.tenantForUser(db, memberA.id).membership_role, 'tenant_admin');
    assert.equal(tenants.tenantForUser(db, memberB.id).id, source.id);
    assert.equal(billing.payerAccount(db, memberA.id).organization_id, customerA.id);
    assert.deepEqual(ledgerRows(db), ledger);

    const groupCount = db.prepare('SELECT COUNT(*) n FROM tenants').get().n;
    assert.deepEqual(await request(fixture, cookie, 'POST', path), result);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tenants').get().n, groupCount);
    const allocation = await request(fixture, cookie, 'POST', `/customers/${missingId}/config-group`);
    assert.equal(allocation.config_group_state, 'dedicated');
    assert.deepEqual(configIds(allocation.config_tenant_id), []);
    const tree = await request(fixture, cookie, 'GET');

    await fixture.restart();
    assert.deepEqual(await request(fixture, cookie, 'GET'), tree);
    assert.deepEqual(tenants.priceBookForUser(fixture.db, memberA.id, config.provider), beforePrice);
    assert.deepEqual(ledgerRows(fixture.db), ledger);
  } finally {
    await fixture.close();
  }
});

test('an individual customer keeps personal billing and config and can explicitly own a project', async () => {
  const fixture = await modelCatalogFixture();
  try {
    const { db, admin } = fixture;
    const individual = auth.createUser(db, {
      username: 'individual-customer',
      display_name: '独立客户测试',
      password: 'fixture-password',
    }, admin.id);
    const sharedMember = auth.createUser(db, { username: 'shared-member', password: 'fixture-password' }, admin.id);
    const internal = auth.createUser(db, { username: 'internal-creator', password: 'fixture-password' }, admin.id);
    const configTenant = tenants.writeTenant(db, admin.id, { name: '测试客户组' });
    tenants.setMember(db, configTenant.id, individual.id, 'creator');
    const organization = organizations.saveOrganization(db, admin.id, { name: '共享客户测试', config_tenant_id: configTenant.id });
    organizations.replaceMembers(db, organization.id, [sharedMember.id]);
    seedCostActivity(db, individual.id);
    billing.adjustBalance(db, admin.id, individual.id, 20, 'isolated individual customer');
    const cookie = await login(fixture, admin.username);
    const individualCookie = await login(fixture, individual.username);
    const path = `/individual-customers/${individual.id}`;
    assert.equal((await fixture.request('PUT', '/admin/ownership' + path)).status, 401);
    assert.equal((await fixture.request('PUT', '/admin/ownership' + path, undefined, individualCookie)).status, 403);
    await request(fixture, cookie, 'PUT', '/internal-members', { user_ids: [internal.id] });

    let tree = await request(fixture, cookie, 'GET');
    assert.deepEqual(tree.individual_customers, []);
    assert.deepEqual(tree.available_individual_users.map(user => user.id), [individual.id]);
    for (const user of [admin, internal, sharedMember]) {
      assert.equal((await fixture.request('PUT', `/admin/ownership/individual-customers/${user.id}`, undefined, cookie)).status, 400);
    }
    assert.equal((await fixture.request('PUT', '/admin/ownership/projects/73', {
      scope: 'external', individual_user_id: individual.id,
    }, cookie)).status, 400);

    const financials = ledgerRows(db);
    const balances = db.prepare('SELECT * FROM billing_accounts ORDER BY user_id').all();
    const memberRows = db.prepare('SELECT * FROM tenant_memberships ORDER BY user_id').all();
    const sharedRows = db.prepare('SELECT * FROM customer_organization_memberships ORDER BY user_id').all();
    const payer = billing.payerAccount(db, individual.id);
    assert.equal(payer.account_scope, 'personal');
    assert.deepEqual(await request(fixture, cookie, 'PUT', path), { user_id: individual.id });
    assert.deepEqual(await request(fixture, cookie, 'PUT', path), { user_id: individual.id });
    assert.equal(db.prepare(`
      SELECT COUNT(*) n FROM billing_audit_logs WHERE action='operations.individual_customer.add' AND target_id=?
    `).get(String(individual.id)).n, 1);
    assert.equal((await fixture.request('PUT', '/admin/ownership/internal-members', { user_ids: [individual.id] }, cookie)).status, 400);
    assert.equal((await fixture.request('PUT', '/admin/ownership/projects/73', {
      scope: 'external', organization_id: organization.id, individual_user_id: individual.id,
    }, cookie)).status, 400);

    const assignment = { scope: 'external', individual_user_id: individual.id };
    await request(fixture, cookie, 'PUT', '/projects/73', { scope: 'external', organization_id: organization.id });
    await request(fixture, cookie, 'PUT', '/projects/73', assignment);
    await request(fixture, cookie, 'PUT', '/projects/73', { scope: 'internal' });
    await request(fixture, cookie, 'PUT', '/projects/73', assignment);
    await request(fixture, cookie, 'PUT', '/projects/73', { scope: 'pending' });
    assert.equal((await request(fixture, cookie, 'GET')).pending.projects[0].id, 73);
    await request(fixture, cookie, 'PUT', '/projects/73', assignment);
    tree = await request(fixture, cookie, 'GET');
    assert.deepEqual(tree.individual_customers, [{
      id: individual.id,
      name: individual.display_name,
      config_tenant_id: configTenant.id,
      config_tenant_name: configTenant.name,
      members: [{ id: individual.id, username: individual.username, display_name: individual.display_name }],
      projects: [{ id: 73, title: '历史用量脱敏样本' }],
    }]);
    assert.deepEqual(tree.customers[0].projects, []);
    assert.deepEqual(tree.internal.projects, []);
    assert.deepEqual(tree.pending.projects, []);
    assert.deepEqual(tree.internal.members.map(user => user.id), [internal.id]);
    assert.ok(!tree.available_users.some(user => user.id === individual.id));
    assert.deepEqual(tree.available_individual_users, []);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM operations_project_ownership WHERE drama_id=73').get().n, 0);

    await fixture.restart();
    const reopened = fixture.db;
    assert.deepEqual(await request(fixture, cookie, 'GET'), tree);
    assert.deepEqual(billing.payerAccount(reopened, individual.id), payer);
    assert.deepEqual(ledgerRows(reopened), financials);
    assert.deepEqual(reopened.prepare('SELECT * FROM billing_accounts ORDER BY user_id').all(), balances);
    assert.deepEqual(reopened.prepare('SELECT * FROM tenant_memberships ORDER BY user_id').all(), memberRows);
    assert.deepEqual(reopened.prepare('SELECT * FROM customer_organization_memberships ORDER BY user_id').all(), sharedRows);
  } finally {
    await fixture.close();
  }
});
