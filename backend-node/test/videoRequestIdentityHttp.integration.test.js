const test = require('node:test');
const assert = require('node:assert/strict');
const { modelCatalogFixture } = require('./helpers/modelCatalogFixture');
const auth = require('../src/services/authService');

test('failed request IDs survive HTTP list/detail and restart without changing historical data', async () => {
  // Fixture mounts routes only, with isolated SQLite and no recovery workers.
  const f = await modelCatalogFixture();
  try {
    const now = '2026-11-04T02:25:16.411Z';
    const reason = 'The request failed because the output video may contain sensitive information.';
    f.db.prepare(`INSERT INTO video_generations (id,owner_user_id,billing_authorization_id,provider,model,prompt,status,provider_task_id,error_msg,created_at,updated_at)
      VALUES (5614,?,'identity-auth','volcengine','fixture-video','fixture','failed','cgt-fixture',?,?,?)`).run(f.admin.id, reason, now, now);
    f.db.prepare(`INSERT INTO omni_video_jobs (id,video_generation_id,owner_user_id,model_requested,model_resolved,prompt,request_snapshot_json,created_at,updated_at)
      VALUES (5614,5614,?,'fixture-video','fixture-video','fixture','{}',?,?)`).run(f.admin.id, now, now);
    f.db.prepare(`INSERT INTO cost_calls (id,source_key,operation_id,attempt,authorization_id,customer_kind,user_id,source_kind,source_id,provider,model,service_type,context_json,submitted_at,observed_at,provider_task_id,provider_request_id,status)
      VALUES ('identity-call','identity-call','identity-operation',1,'identity-auth','personal',?,'video','5614','volcengine','fixture-video','video','{}',?,?,'cgt-fixture','021-fixture-response-id','failed')`).run(f.admin.id, now, now);
    const snapshot = () => JSON.stringify({ video: f.db.prepare('SELECT * FROM video_generations WHERE id=5614').get(), call: f.db.prepare("SELECT * FROM cost_calls WHERE id='identity-call'").get(), ledger: f.db.prepare('SELECT * FROM billing_usage_logs').all() });
    const before = snapshot();
    const verify = async () => {
      const login = await f.request('POST', '/auth/login', { username: 'catalog-admin', password: 'fixture-password' });
      assert.equal(login.status, 200);
      for (const route of ['/videos/5614', '/videos', '/omni-video-jobs/5614', '/omni-video-jobs', '/video-generations/5614/history-detail']) {
        const res = await f.request('GET', route, undefined, login.cookie);
        assert.equal(res.status, 200, `${route}: ${JSON.stringify(res.body)}`);
        let item = res.body.data;
        if (item.items) item = item.items;
        if (Array.isArray(item)) item = item.find(x => x.id === 5614);
        const value = route.endsWith('history-detail') ? item.task : item.generation || item;
        assert.equal(value.provider_request_id, '021-fixture-response-id', route);
        assert.equal(value.provider_task_id, 'cgt-fixture', route);
      }
      const { generationFailureCopyText } = await import('../../frontweb/src/utils/generationFailure.js');
      const res = await f.request('GET', '/videos/5614', undefined, login.cookie);
      assert.match(generationFailureCopyText(res.body.data), /火山响应 ID: 021-fixture-response-id/);
      const denied = await f.request('GET', '/videos/5614');
      assert.equal(denied.status, 401);
    };
    await verify();
    await f.restart();
    await verify();
    const other = auth.createUser(f.db, { username: 'identity-other', password: 'fixture-password' }, null);
    assert.notEqual(other.id, f.admin.id);
    const login = await f.request('POST', '/auth/login', { username: 'identity-other', password: 'fixture-password' });
    for (const route of ['/videos/5614', '/omni-video-jobs/5614', '/video-generations/5614/history-detail']) {
      const denied = await f.request('GET', route, undefined, login.cookie);
      assert.ok([403, 404].includes(denied.status), `${route}: ${denied.status}`);
      assert.ok(!JSON.stringify(denied.body).includes('021-fixture-response-id'));
    }
    assert.equal(snapshot(), before, 'reads and restart do not rewrite task, call or ledger');
  } finally { await f.close(); }
});
