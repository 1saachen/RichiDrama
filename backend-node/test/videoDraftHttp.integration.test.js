const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { modelCatalogFixture } = require('./helpers/modelCatalogFixture');
const billing = require('../src/services/billingService');
const configs = require('../src/services/aiConfigService');
const draft = require('../src/services/videoDraftService');

test('authenticated Draft HTTP workflow archives both stages, bills separately, and survives restart', { timeout: 120000 }, async t => {
  const oldEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
  const f = await modelCatalogFixture();
  const payloads = [], media = {};
  let rejectNextSubmission = false;
  let badMedia = false;
  let provider, base, cookie;
  try {
    for (const [tier, size] of [['480p', '854x480'], ['1080p', '1920x1080']]) {
      const file = path.join(f.root, tier + '.mp4');
      const made = spawnSync(require('../src/utils/ffmpegPath').getFfmpegPath(), ['-v','error','-f','lavfi','-i',`color=c=blue:s=${size}:r=24:d=4`,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',file], { windowsHide: true, encoding: 'utf8' });
      assert.equal(made.status, 0, made.stderr); media['/' + tier + '.mp4'] = fs.readFileSync(file);
    }
    provider = http.createServer((req, res) => {
      if (media[req.url]) { res.writeHead(200, {'content-type':'video/mp4'}); res.end(badMedia ? Buffer.from('isolated corrupt media') : media[req.url]); return; }
      let raw = ''; req.on('data', c => { raw += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST') {
          const body = JSON.parse(raw); payloads.push(body);
          if (rejectNextSubmission) { rejectNextSubmission = false; res.statusCode = 503; res.end(JSON.stringify({error: {message: 'isolated uncertain provider outcome'}})); return; }
          const id = `draft-fixture-${payloads.length}`;
          res.end(JSON.stringify({ id, status: 'queued' }));
        } else {
          const index = Number(req.url.match(/(\d+)$/)?.[1]) - 1;
          const body = payloads[index];
          if (!body) { res.statusCode = 404; res.end('{}'); return; }
          res.end(JSON.stringify({ id: `draft-fixture-${index + 1}`, status: 'succeeded', draft: body.draft === true,
            created_at: Math.floor(Date.now()/1000), content: { video_url: base + '/' + body.resolution + '.mp4' },
            duration: 4, usage: { completion_tokens: body.draft ? 1000 : 2000 } }));
        }
      });
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); base = `http://127.0.0.1:${provider.address().port}`;
    configs.createConfig(f.db, f.log, { service_type: 'video', name: 'isolated draft provider', provider: 'volcengine',
      api_protocol: 'volcengine_omni', base_url: base, endpoint: '/api/v3/contents/generations/tasks', query_endpoint: '/api/v3/contents/generations/tasks/{taskId}',
      api_key: 'mock-only', model: [draft.MODEL], default_model: draft.MODEL, is_default: true });
    f.db.prepare("UPDATE billing_price_books SET status='archived' WHERE id IN (SELECT price_book_id FROM billing_price_book_items WHERE model=?)").run(draft.MODEL);
    billing.savePriceBook(f.db, f.admin.id, { name: 'isolated Draft token price', status: 'published', items: [{ service_type: 'video', model: draft.MODEL, meter: 'output_token', unit_price: 0.001 }] });
    billing.adjustBalance(f.db, f.admin.id, f.admin.id, 100000, 'isolated draft fixture credits');
    const login = await f.request('POST', '/auth/login', { username: 'catalog-admin', password: 'fixture-password' }); cookie = login.cookie;
    async function waitCompleted(id) {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const response = await f.request('GET', `/videos/${id}`, undefined, cookie);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        if (response.body.data.status === 'completed') return response.body.data;
        if (response.body.data.status === 'failed') assert.fail(JSON.stringify(response.body.data));
        await delay(100);
      }
      assert.fail('generation did not reach completed');
    }
    const at = new Date().toISOString();
    const projectId = Number(f.db.prepare('INSERT INTO dramas(title,owner_user_id,created_at,updated_at) VALUES(?,?,?,?)').run('Draft test project', f.admin.id, at, at).lastInsertRowid);
    const episodeId = Number(f.db.prepare('INSERT INTO episodes(drama_id,episode_number,title,created_at,updated_at) VALUES(?,1,?,?,?)').run(projectId, 'test episode', at, at).lastInsertRowid);
    const shotId = Number(f.db.prepare("INSERT INTO storyboards(episode_id,storyboard_number,title,status,video_url,local_path,created_at,updated_at) VALUES(?,1,'test shot','completed','/static/existing.mp4','existing.mp4',?,?)").run(episodeId, at, at).lastInsertRowid);
    const body = { drama_id: projectId, storyboard_id: shotId, model: draft.MODEL, prompt: 'A blue paper boat', assets: [], duration: 4,
      aspect_ratio: '16:9', resolution: '720p', draft_mode: true, idempotency_key: 'draft-http-request-1' };
    let source, final;
    await t.test('authentication, model gate, and preview archival', async () => {
      assert.equal((await f.request('POST', '/omni-video-jobs', body)).status, 401);
      const invalid = await f.request('POST', '/omni-video-jobs', {...body, model: 'doubao-seedance-2-0-mini-260615'}, cookie);
      assert.equal(invalid.status, 400); assert.equal(payloads.length, 0);
      const created = await f.request('POST', '/omni-video-jobs', body, cookie);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      source = await waitCompleted(created.body.data.video_generation_id);
      assert.equal(source.generation_mode, 'draft'); assert.equal(source.resolution, '480p');
      assert.equal(payloads[0].draft, true); assert.ok(source.local_path); assert.match(source.video_url, /^\/static\//);
      const shot = f.db.prepare('SELECT status,video_url,local_path,active_video_generation_id FROM storyboards WHERE id=?').get(shotId);
      assert.equal(shot.status, 'completed'); assert.equal(shot.local_path, 'existing.mp4'); assert.equal(shot.active_video_generation_id, null);
      assert.equal(source.actual_points, 1);
      const repeated = await f.request('POST', '/omni-video-jobs', body, cookie);
      assert.equal(repeated.body.data.video_generation_id, source.id);
      assert.equal(payloads.length, 1);
      const normal = await f.request('GET', '/videos?page_size=100', undefined, cookie);
      assert.ok(!normal.body.data.items.some(item => item.id === source.id));
    });
    await t.test('ownership, missing archive, non-draft response, expired source, and missing prices fail before billing', async () => {
      assert.ok(source);
      const count = () => f.db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE type='authorization'").get().n;
      const before = count();
      const meta = f.db.prepare('SELECT * FROM video_draft_tasks WHERE generation_id=?').get(source.id);
      const other = require('../src/services/authService').createUser(f.db, { username: 'draft-other', password: 'fixture-password', account_kind: 'platform_admin' }, null);
      const loginOther = await f.request('POST', '/auth/login', {username: 'draft-other', password: 'fixture-password'});
      assert.equal((await f.request('POST', `/video-drafts/${source.id}/finalize`, {}, loginOther.cookie)).status, 400);
      assert.equal((await f.request('GET', '/video-drafts', undefined, loginOther.cookie)).body.data.length, 0);
      f.db.prepare('UPDATE video_generations SET local_path=? WHERE id=?').run('missing.mp4', source.id);
      assert.equal((await f.request('POST', `/video-drafts/${source.id}/finalize`, {}, cookie)).status, 400);
      f.db.prepare('UPDATE video_generations SET local_path=? WHERE id=?').run(source.local_path, source.id);
      f.db.prepare('UPDATE video_draft_tasks SET provider_draft=0 WHERE generation_id=?').run(source.id);
      assert.equal((await f.request('POST', `/video-drafts/${source.id}/finalize`, {}, cookie)).status, 400);
      f.db.prepare('UPDATE video_draft_tasks SET provider_draft=1,expires_at=? WHERE generation_id=?').run('2000-01-01T00:00:00.000Z', source.id);
      assert.equal((await f.request('POST', `/video-drafts/${source.id}/finalize`, {}, cookie)).status, 400);
      f.db.prepare('UPDATE video_draft_tasks SET expires_at=? WHERE generation_id=?').run(meta.expires_at, source.id);
      const config = configs.getConfig(f.db, meta.config_id);
      f.db.prepare('UPDATE ai_service_configs SET endpoint=? WHERE id=?').run('/changed-endpoint', config.id);
      assert.equal((await f.request('POST', `/video-drafts/${source.id}/finalize`, {}, cookie)).status, 400);
      f.db.prepare('UPDATE ai_service_configs SET endpoint=? WHERE id=?').run(config.endpoint, config.id);
      f.db.prepare('UPDATE video_draft_tasks SET has_video_input=1,has_audio_input=1 WHERE generation_id=?').run(source.id);
      const inheritedQuote = await f.request('POST', `/video-drafts/${source.id}/final-quote`, {}, cookie);
      assert.equal(inheritedQuote.body.data.pricing_context.has_video_input, true);
      assert.equal(inheritedQuote.body.data.pricing_context.has_audio, true);
      assert.equal(inheritedQuote.body.data.pricing_context.resolution, '1080p');
      f.db.prepare('UPDATE video_draft_tasks SET has_video_input=0,has_audio_input=0 WHERE generation_id=?').run(source.id);
      const book = f.db.prepare("SELECT b.id FROM billing_price_books b JOIN billing_price_book_items i ON i.price_book_id=b.id WHERE b.status='published' AND i.model=?").get(draft.MODEL);
      f.db.prepare("UPDATE billing_price_books SET status='archived' WHERE id=?").run(book.id);
      assert.equal((await f.request('POST', `/video-drafts/${source.id}/finalize`, {}, cookie)).status, 400);
      f.db.prepare("UPDATE billing_price_books SET status='published' WHERE id=?").run(book.id);
      assert.equal(count(), before); assert.equal(payloads.length, 1); assert.ok(other.id);
    });
    await t.test('final request inherits creative inputs, has its own billing, and approval is idempotent', async () => {
      assert.ok(source, 'draft stage must complete');
      const invalid = await f.request('POST', `/video-drafts/${source.id}/finalize`, { prompt: 'changed' }, cookie);
      assert.equal(invalid.status, 400);
      const quoted = await f.request('POST', `/video-drafts/${source.id}/final-quote`, {}, cookie);
      assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
      const [a, b] = await Promise.all([1,2].map(() => f.request('POST', `/video-drafts/${source.id}/finalize`, {}, cookie)));
      assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(b.status, 201, JSON.stringify(b.body));
      assert.equal(a.body.data.id, b.body.data.id); final = await waitCompleted(a.body.data.id);
      assert.deepEqual(payloads[1], { model: draft.MODEL, content: [{ type: 'draft_task', draft_task: { id: 'draft-fixture-1' } }], resolution: '1080p', watermark: false });
      assert.equal(final.actual_points, 2); assert.equal(payloads.length, 2);
      assert.equal(f.db.prepare('SELECT active_video_generation_id FROM storyboards WHERE id=?').get(shotId).active_video_generation_id, final.id);
      const auths = f.db.prepare("SELECT id FROM billing_transactions WHERE type='authorization' AND reference_type IN ('omni_video_job','video_generation')").all();
      assert.equal(auths.length, 2);
      const charges = f.db.prepare('SELECT * FROM billing_usage_logs WHERE authorization_id IN (?,?)').all(...auths.map(x => x.id));
      assert.equal(charges.length, 2);
    });
    await t.test('known provider tasks recover archival without another submission or charge', async () => {
      assert.ok(final);
      const before = f.db.prepare('SELECT COUNT(*) n FROM billing_usage_logs').get().n;
      f.db.prepare("UPDATE video_generations SET status='failed',local_path=NULL,error_msg='isolated archive interruption' WHERE id=?").run(source.id);
      const resumed = await f.request('POST', `/video-drafts/${source.id}/recover`, {}, cookie);
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
      source = await waitCompleted(source.id);
      assert.ok(source.local_path); assert.equal(payloads.length, 2);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_usage_logs').get().n, before);
      assert.equal(f.db.prepare('SELECT active_video_generation_id FROM storyboards WHERE id=?').get(shotId).active_video_generation_id, final.id);
    });
    await t.test('restart keeps archived previews, expiry blocks new promotion, and deleted final cannot be resubmitted', async () => {
      assert.ok(final, 'final stage must complete');
      await f.restart();
      const list = await f.request('GET', '/video-drafts', undefined, cookie);
      assert.equal(list.status, 200); assert.equal(list.body.data[0].final_generation_id, final.id);
      const again = await f.request('POST', `/video-drafts/${source.id}/finalize`, {}, cookie);
      assert.equal(again.body.data.id, final.id); assert.equal(payloads.length, 2);
      f.db.prepare('UPDATE video_generations SET deleted_at=? WHERE id=?').run(new Date().toISOString(), final.id);
      await f.request('POST', `/video-drafts/${source.id}/finalize`, {}, cookie);
      assert.equal(payloads.length, 2);
      f.db.prepare('UPDATE video_draft_tasks SET expires_at=? WHERE generation_id=?').run('2000-01-01T00:00:00.000Z', source.id);
      const expired = await f.request('GET', '/video-drafts', undefined, cookie);
      assert.equal(expired.body.data[0].draft_expired, true); assert.ok(expired.body.data[0].video_url);
      assert.equal((await f.request('POST', `/video-drafts/${source.id}/final-quote`, {}, cookie)).status, 400);
    });
    await t.test('uncertain provider submission retains authorization and records reconciliation instead of retrying', async () => {
      const callsBefore = payloads.length;
      rejectNextSubmission = true;
      const created = await f.request('POST', '/omni-video-jobs', {...body, idempotency_key:'draft-unknown-outcome'}, cookie);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.data.video_generation_id;
      for(let i=0;i<100;i++) { if(f.db.prepare('SELECT status FROM video_generations WHERE id=?').get(id).status==='failed') break; await delay(20); }
      const row = f.db.prepare('SELECT * FROM video_generations WHERE id=?').get(id);
      assert.equal(row.status, 'failed');
      assert.equal(f.db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE authorization_id=? AND type='void'").get(row.billing_authorization_id).n, 0,
        JSON.stringify({error:row.error_msg,cost:f.db.prepare('SELECT status,provider_request_id FROM cost_calls WHERE authorization_id=?').all(row.billing_authorization_id)}));
      assert.equal(f.db.prepare("SELECT COUNT(*) n FROM billing_reconciliation_cases WHERE authorization_id=? AND status='pending'").get(row.billing_authorization_id).n, 1);
      assert.equal(f.db.prepare('SELECT status FROM cost_calls WHERE authorization_id=? ORDER BY submitted_at DESC LIMIT 1').get(row.billing_authorization_id).status, 'unknown');
      assert.equal((await f.request('POST', `/video-drafts/${id}/recover`, {}, cookie)).status, 400);
      assert.equal(payloads.length, callsBefore + 1);
    });
    await t.test('failed local archival retains the reservation and recovery settles it once', async () => {
      const before = payloads.length; badMedia = true;
      const created = await f.request('POST', '/omni-video-jobs', {...body, idempotency_key:'draft-archive-interruption'}, cookie);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.data.video_generation_id;
      for(let i=0;i<500;i++) { if(f.db.prepare('SELECT status FROM video_generations WHERE id=?').get(id).status==='failed') break; await delay(100); }
      const row = f.db.prepare('SELECT * FROM video_generations WHERE id=?').get(id);
      assert.equal(row.status, 'failed'); assert.ok(row.provider_task_id);
      assert.equal(f.db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE authorization_id=? AND type='void'").get(row.billing_authorization_id).n,0);
      assert.equal(f.db.prepare("SELECT status FROM billing_reconciliation_cases WHERE authorization_id=?").get(row.billing_authorization_id).status,'pending');
      const expectedCharge = billing.snapshotCalculation(billing.getAuthorization(f.db, row.billing_authorization_id).snapshot, {output_token:1000}).amount_micro / 10000;
      f.db.prepare('UPDATE billing_price_book_items SET unit_price_micro=unit_price_micro*2,conditions_json=NULL WHERE model=?').run(draft.MODEL);
      badMedia = false;
      assert.equal((await f.request('POST', `/video-drafts/${id}/recover`, {}, cookie)).status,200);
      const recovered = await waitCompleted(id); assert.equal(recovered.actual_points,expectedCharge);
      assert.equal(payloads.length,before+1);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_usage_logs WHERE authorization_id=?').get(row.billing_authorization_id).n,1);
      assert.equal(f.db.prepare('SELECT status FROM billing_reconciliation_cases WHERE authorization_id=?').get(row.billing_authorization_id).status,'resolved');
    });
  } finally {
    if (provider) await new Promise(resolve => provider.close(resolve));
    await f.close(); if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
  }
});

test('Draft expiry uses the documented cutoff without altering archived files', () => {
  assert.equal(draft.expiry('2026-10-28T01:59:59.000Z'), '2026-11-04T01:59:59.000Z');
  assert.equal(draft.expiry('2026-10-28T02:00:00.000Z'), '2026-11-11T02:00:00.000Z');
  assert.equal(draft.expiry('invalid'), null);
});
