const test = require('node:test');
const assert = require('node:assert/strict');
const { modelCatalogFixture } = require('./helpers/modelCatalogFixture');
const auth = require('../src/services/authService');

test('operations costs classify confirmed projects and retained payers independently across restart', async () => {
  const fixture = await modelCatalogFixture();
  try {
    const db = fixture.db;
    const internal = auth.createUser(db, { username: 'ops-internal-test', password: 'fixture-password' }, fixture.admin.id);
    const unspecified = auth.createUser(db, { username: 'ops-unknown-test', password: 'fixture-password' }, fixture.admin.id);
    const login = async user => (await fixture.request('POST', '/auth/login', {
      username: user.username, password: 'fixture-password',
    })).cookie;
    const cookie = await login(fixture.admin);
    const request = async (method, path, body, status = 200) => {
      const result = await fixture.request(method, path, body, cookie);
      assert.equal(result.status, status, JSON.stringify(result.body));
      return result.body.data;
    };
    const get = query => request('GET', '/admin/costs/activity' + query);
    const at = '2026-10-31T16:00:00.000Z';
    const tenant = db.prepare("INSERT INTO tenants (name,status,created_at,updated_at) VALUES ('归属统计验收组','active',?,?)").run(at, at);
    const createCustomer = name => request('POST', '/admin/customer-organizations', {
      name, config_tenant_id: Number(tenant.lastInsertRowid),
    }, 201);
    const customerA = await createCustomer('外部验收 A');
    const customerB = await createCustomer('外部验收 B');
    const project = db.prepare('INSERT INTO dramas (id,title,owner_user_id,created_at,updated_at) VALUES(?,?,?,?,?)');
    project.run(801, '内部验收项目', internal.id, at, at);
    project.run(802, '客户 A 验收项目', internal.id, at, at);
    project.run(803, '未知验收项目', unspecified.id, at, at);
    const usage = db.prepare(`INSERT INTO billing_usage_logs
      (id,user_id,organization_id,drama_id,project_title_snapshot,service_type,model,usage_json,charged_micro,snapshot_json,created_at)
      VALUES (@id,@userId,@organizationId,@projectId,@projectTitle,'text','ops-test-model','{"output_token":3}',@charged,@snapshot,@date)`);
    const record = (id, { userId = internal.id, organizationId = null, projectId = null, projectTitle = null, charged = 5, date = at } = {}) => {
      usage.run({ id, userId, organizationId, projectId, projectTitle, charged, date,
        snapshot: JSON.stringify({ account_scope: organizationId ? 'organization' : 'personal' }) });
    };
    for (let index = 0; index < 21; index++) {
      record(`internal-${index}`, {
        projectId: 801, projectTitle: '内部验收项目', organizationId: index === 0 ? customerB.id : null,
      });
    }
    record('internal-next-day', { projectId: 801, projectTitle: '内部验收项目', date: '2026-11-01T16:00:00.000Z' });
    record('internal-next-month', { projectId: 801, projectTitle: '内部验收项目', date: '2026-11-30T16:00:00.000Z' });
    record('internal-standalone');
    record('external-project-cross-payer', { projectId: 802, projectTitle: '客户 A 验收项目', organizationId: customerB.id, charged: 81 });
    record('external-standalone', { organizationId: customerA.id });
    record('other-external-standalone', { organizationId: customerB.id });
    record('pending-project', { projectId: 803, projectTitle: '未知验收项目', organizationId: customerA.id });
    record('unknown-standalone', { userId: unspecified.id });

    const saved = await request('POST', '/admin/costs/reports', {
      organization_id: customerB.id, month: '2026-11', basis: 'billing_activity_v1',
    });
    const snapshot = () => ['billing_usage_logs', 'billing_transactions', 'cost_reports', 'cost_report_items'].map(
      table => fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
    const ledgerBefore = snapshot();
    const actorWithoutAdmin = await login(internal);
    assert.equal((await fixture.request('GET', '/admin/costs/activity?ops_scope=internal')).status, 401);
    assert.equal((await fixture.request('GET', '/admin/costs/activity?ops_scope=internal', undefined, actorWithoutAdmin)).status, 403);
    assert.equal((await get('?ops_scope=pending')).summary.calls, 27, 'projects without a confirmed assignment default to pending');

    await request('PUT', '/admin/ownership/projects/801', { scope: 'internal' });
    await request('PUT', '/admin/ownership/projects/802', { scope: 'external', organization_id: customerA.id });
    await request('PUT', '/admin/ownership/internal-members', { user_ids: [internal.id] });

    const all = await get('?ops_scope=all&group_by=ops_customer');
    assert.equal(all.summary.calls, 29);
    assert.deepEqual(Object.fromEntries(all.breakdown.items.map(row => [row.key, row.calls])), {
      [customerA.id]: 2, [customerB.id]: 1, internal: 24, pending: 2,
    });
    assert.equal(all.breakdown.items.find(row => row.key === 'internal').label, '内部漫剧');
    assert.equal(all.breakdown.items.find(row => row.key === String(customerA.id)).label, customerA.name);
    const external = await get(`?ops_scope=external&ops_customer_id=${customerA.id}`);
    const paidByB = external.calls.items.find(row => row.id === 'usage:external-project-cross-payer');
    assert.equal(external.summary.calls, 2);
    assert.equal(paidByB.ops_customer_id, customerA.id);
    assert.equal(paidByB.ops_customer_name, customerA.name);
    assert.equal(paidByB.organization_id, customerB.id);
    assert.equal(paidByB.charged_micro, 81);
    const detail = await request('GET', '/admin/costs/activity/usage:external-project-cross-payer?ops_scope=all');
    assert.equal(detail.ops_customer_id, customerA.id);
    assert.equal(detail.organization_id, customerB.id);
    const pending = await get('?ops_scope=pending');
    assert.deepEqual(new Set(pending.calls.items.map(row => row.id)), new Set(['usage:pending-project', 'usage:unknown-standalone']));
    assert.equal(pending.calls.items.find(row => row.id === 'usage:pending-project').customer_kind, 'customer');

    const dailyQuery = '?ops_scope=internal&drama_id=801&group_by=day&time_order=desc&date_from=2026-11-01&date_to=2026-11-30&page=2';
    const daily = await get(dailyQuery);
    assert.deepEqual(daily.breakdown.items.map(row => [row.key, row.calls]), [['2026-11-02', 1], ['2026-11-01', 21]]);
    assert.equal(daily.calls.total, 22);
    assert.equal(daily.calls.items.length, 2);
    assert.ok(daily.calls.items.every(row => row.drama_id === 801 && row.ops_scope === 'internal'));
    const monthly = await get('?ops_scope=internal&drama_id=801&group_by=month&time_order=desc');
    assert.deepEqual(monthly.breakdown.items.map(row => [row.key, row.calls]), [['2026-12', 1], ['2026-11', 22]]);
    const legacy = await get(`?organization_id=${customerB.id}`);
    assert.equal(legacy.summary.calls, 3);
    assert.ok(legacy.calls.items.every(row => !Object.hasOwn(row, 'ops_scope')));
    await request('GET', '/admin/costs/activity?ops_scope=invented', undefined, 400);
    await request('GET', '/admin/costs/activity?ops_customer_id=0', undefined, 400);

    await fixture.restart();
    const afterRestart = await get(dailyQuery);
    assert.deepEqual(afterRestart.breakdown, daily.breakdown);
    assert.deepEqual(afterRestart.calls, daily.calls);
    assert.deepEqual(await request('GET', '/admin/costs/reports/' + saved.id), saved);
    assert.deepEqual(snapshot(), ledgerBefore);
  } finally {
    await fixture.close();
  }
});
