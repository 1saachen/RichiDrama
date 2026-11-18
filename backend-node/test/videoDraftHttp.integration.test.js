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

test('authenticated Draft HTTP workflow archives both stages, bills separately, and survives restart', { timeout: 180000 }, async t => {
  const oldEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
  const f = await modelCatalogFixture();
  const configModule = require('../src/config');
  const originalLoadConfig = configModule.loadConfig;
  const isolatedConfig = JSON.parse(fs.readFileSync(path.join(f.root, 'config.yaml'), 'utf8'));
  configModule.loadConfig = () => ({ ...isolatedConfig, image_proxy: { use_for_video: false } });
  const payloads = [], media = {};
  const nativeFetch = global.fetch;
  let activationResponse;
  global.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url || input);
    if (url.hostname === 'open.volcengineapi.com' && url.searchParams.get('Action') === 'ListModelActivations' && activationResponse) {
      return new Response(JSON.stringify(activationResponse), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Fixture blocks unexpected supplier traffic');
    return nativeFetch(input, init);
  };
  let rejectNextSubmission = false;
  let badMedia = false;
  let provider, base, cookie;
  try {
    for (const [tier, size] of [['480p', '854x480'], ['1080p', '1920x1080'], ['4k', '3840x2160']]) {
      const file = path.join(f.root, tier + '.mp4');
      const codec = tier === '4k' ? ['-frames:v','1','-c:v','libx265','-x265-params','pools=1:frame-threads=1:rc-lookahead=0:bframes=0:ref=1:wpp=0:log-level=error','-pix_fmt','yuv420p10le'] : ['-c:v','libx264','-pix_fmt','yuv420p'];
      const made = spawnSync(require('../src/utils/ffmpegPath').getFfmpegPath(), ['-v','error','-filter_threads','1','-f','lavfi','-i',`color=c=blue:s=${size}:r=24:d=4`,...codec,'-threads','1','-preset','ultrafast',file], { windowsHide: true, encoding: 'utf8' });
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
      const missing4k = await f.request('POST', `/video-drafts/${source.id}/final-quote`, { resolution: '4k' }, cookie);
      assert.equal(missing4k.status, 400);
      assert.match(missing4k.body.error.message, /4K 价目缺失/);
      const directMissing4k = await f.request('POST', '/omni-video-jobs', { ...body, draft_mode: false, resolution: '4k', idempotency_key: 'unpriced-native-4k' }, cookie);
      assert.equal(directMissing4k.status, 400);
      assert.match(directMissing4k.body.error.message, /4K 价目缺失/);
      assert.equal(count(), before); assert.equal(payloads.length, 1);
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
      const pricesBeforeRecovery = f.db.prepare('SELECT id,unit_price_micro,conditions_json FROM billing_price_book_items WHERE model=?').all(draft.MODEL);
      f.db.prepare('UPDATE billing_price_book_items SET unit_price_micro=unit_price_micro*2,conditions_json=NULL WHERE model=?').run(draft.MODEL);
      badMedia = false;
      assert.equal((await f.request('POST', `/video-drafts/${id}/recover`, {}, cookie)).status,200);
      const recovered = await waitCompleted(id); assert.equal(recovered.actual_points,expectedCharge);
      assert.equal(payloads.length,before+1);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_usage_logs WHERE authorization_id=?').get(row.billing_authorization_id).n,1);
      assert.equal(f.db.prepare('SELECT status FROM billing_reconciliation_cases WHERE authorization_id=?').get(row.billing_authorization_id).status,'resolved');
      for (const price of pricesBeforeRecovery) f.db.prepare('UPDATE billing_price_book_items SET unit_price_micro=?,conditions_json=? WHERE id=?').run(price.unit_price_micro, price.conditions_json, price.id);
    });
    await t.test('explicit 4K native and Draft final outputs use independent prices, retain 10-bit media and survive restart', async () => {
      billing.adjustBalance(f.db, f.admin.id, f.admin.id, 1000000, 'isolated 4K scenario credits after restart');
      const oldPreview = f.db.prepare('SELECT * FROM video_generations WHERE id=?').get(source.id);
      const oldBytes = fs.readFileSync(path.join(f.root, 'storage', source.local_path));
      const charges = Object.entries({ V2VCompletion: 0.042, NV2VCompletion: 0.07, V2V1080Completion: 0.046, NV2V1080Completion: 0.077, V2V4KCompletion: 0.019, NV2V4KCompletion: 0.031 })
        .map(([Type, Price]) => ({ Type, Price, UnitCode: '千tokens' }));
      activationResponse = { ResponseMetadata: { RequestId: 'fixture-seedance25-4k-prices' }, Result: { TotalCount: 1,
        Items: [{ FoundationModelName: 'doubao-seedance-2-5', State: 'Available', MultiChargeItems: [{ ChargeItems: charges }] }] } };
      configs.createConfig(f.db, f.log, { name: 'isolated price metadata', service_type: 'model_ark_asset', provider: 'volcengine', model: 'asset',
        settings: JSON.stringify({ access_key_id: 'fixture-ak', secret_access_key: 'fixture-sk' }) });
      const checkTime = new Date().toISOString();
      f.db.prepare("INSERT OR REPLACE INTO provider_price_source_checks(provider,ark_status,billing_status,checked_at,detail_json,updated_at) VALUES ('volcengine','success','success',?,'{}',?)").run(checkTime, checkTime);
      const activeQuote = await f.request('POST', '/billing/quotes', { service_type: 'video', provider: 'volcengine', model: draft.MODEL,
        usage: { output_token: 1 }, pricing_context: { resolution: '480p', has_video_input: false } }, cookie);
      assert.equal(activeQuote.status, 200, JSON.stringify(activeQuote.body));
      const sync = await f.request('POST', '/admin/provider-prices/volcengine/sync', {}, cookie);
      assert.equal(sync.status, 200, JSON.stringify(sync.body));
      const candidate = sync.body.data.candidates.find(row => row.billing_key === draft.MODEL && row.mapping_status === 'mapped');
      assert.ok(candidate, JSON.stringify(sync.body));
      const reviewed = await f.request('PATCH', `/admin/provider-price-syncs/${sync.body.data.id}/candidates/${candidate.id}`, { review_status: 'accepted' }, cookie);
      assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
      for (const other of sync.body.data.candidates.filter(row => row.id !== candidate.id)) {
        const excluded = await f.request('PATCH', `/admin/provider-price-syncs/${sync.body.data.id}/candidates/${other.id}`, { review_status: 'rejected' }, cookie);
        assert.equal(excluded.status, 200, JSON.stringify(excluded.body));
      }
      const proposal = await f.request('POST', `/admin/provider-price-syncs/${sync.body.data.id}/create-draft`, {}, cookie);
      assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
      assert.equal(proposal.body.data.parent_price_book_id, activeQuote.body.data.rates[0].price_book_id);
      const published = await f.request('POST', `/admin/price-books/${proposal.body.data.id}/publish`, { confirm: true, reason: 'isolated new 4K tier', idempotency_key: 'test-native-4k-prices', notify_users: false }, cookie);
      assert.equal(published.status, 200, JSON.stringify(published.body));
      const nativeBookQuote = await f.request('POST', '/billing/quotes', { service_type: 'video', provider: 'volcengine', model: draft.MODEL,
        usage: { output_token: 1000000 }, pricing_context: { resolution: '480p', has_video_input: false } }, cookie);
      assert.equal(nativeBookQuote.status, 200, JSON.stringify(nativeBookQuote.body));
      assert.equal(nativeBookQuote.body.data.amount, 7000, JSON.stringify(nativeBookQuote.body.data));
      const parent = await f.request('POST', '/omni-video-jobs', { ...body, idempotency_key: 'draft-parent-for-4k' }, cookie);
      assert.equal(parent.status, 201, JSON.stringify(parent.body));
      const preview = await waitCompleted(parent.body.data.video_generation_id);
      const callQuote = async (resolution, has_video_input) => {
        const response = await f.request('POST', '/billing/quotes', { service_type: 'video', model: draft.MODEL, usage: { output_token: 1000000 }, pricing_context: { resolution, has_video_input } }, cookie);
        assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.data;
      };
      assert.equal((await callQuote('4k', false)).amount, 3100);
      assert.equal((await callQuote('4K', true)).amount, 1900);
      assert.equal((await callQuote('720p', false)).amount, 7000);
      const quoted = await f.request('POST', `/video-drafts/${preview.id}/final-quote`, { resolution: '4k' }, cookie);
      assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
      assert.equal(quoted.body.data.usage.output_token, 894300);
      assert.equal(quoted.body.data.pricing_context.resolution, '4k');
      const defaultQuote = await f.request('POST', `/video-drafts/${preview.id}/final-quote`, {}, cookie);
      assert.equal(defaultQuote.body.data.pricing_context.resolution, '1080p');
      assert.equal((await f.request('POST', `/video-drafts/${preview.id}/finalize`, { resolution: '720p' }, cookie)).status, 400);
      const priorCalls = payloads.length;
      const [a, b] = await Promise.all([1, 2].map(() => f.request('POST', `/video-drafts/${preview.id}/finalize`, { resolution: '4k' }, cookie)));
      assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(b.status, 201, JSON.stringify(b.body));
      assert.equal(a.body.data.id, b.body.data.id);
      const final4k = await waitCompleted(a.body.data.id);
      assert.equal(final4k.resolution, '4k'); assert.equal(final4k.actual_points, 6.2);
      assert.equal(payloads.length, priorCalls + 1);
      assert.deepEqual(payloads.at(-1), { model: draft.MODEL, content: [{ type: 'draft_task', draft_task: { id: preview.provider_task_id } }], resolution: '4k', watermark: false });
      const output = path.join(f.root, 'storage', final4k.local_path);
      assert.deepEqual(fs.readFileSync(output), media['/4k.mp4'], 'Archive must preserve the provider 10-bit HEVC bytes');
      const probe = spawnSync(require('../src/utils/ffmpegPath').getFfprobePath(), ['-v','error','-select_streams','v:0','-show_entries','stream=width,height,pix_fmt,codec_name','-of','json',output], { encoding: 'utf8', windowsHide: true });
      const stream = JSON.parse(probe.stdout).streams[0];
      assert.deepEqual([stream.width, stream.height, stream.codec_name, stream.pix_fmt], [3840, 2160, 'hevc', 'yuv420p10le']);
      const native = await f.request('POST', '/omni-video-jobs', { ...body, draft_mode: false, resolution: '4k', idempotency_key: 'direct-native-4k' }, cookie);
      assert.equal(native.status, 201, JSON.stringify(native.body));
      const native4k = await waitCompleted(native.body.data.video_generation_id);
      assert.equal(native4k.resolution, '4k'); assert.equal(payloads.at(-1).resolution, '4k'); assert.equal(payloads.at(-1).draft, undefined);
      await f.restart();
      const read = await f.request('GET', `/videos/${final4k.id}`, undefined, cookie);
      assert.equal(read.status, 200); assert.equal(read.body.data.resolution, '4k'); assert.equal(read.body.data.local_path, final4k.local_path);
      const repeated = await f.request('POST', `/video-drafts/${preview.id}/finalize`, { resolution: '4k' }, cookie);
      assert.equal(repeated.body.data.id, final4k.id);
      assert.equal((await f.request('POST', `/video-drafts/${preview.id}/finalize`, { resolution: '1080p' }, cookie)).status, 400);
      assert.deepEqual(f.db.prepare('SELECT * FROM video_generations WHERE id=?').get(source.id), oldPreview);
      assert.deepEqual(fs.readFileSync(path.join(f.root, 'storage', source.local_path)), oldBytes);
    });
  } finally {
    if (provider) await new Promise(resolve => provider.close(resolve));
    await f.close(); configModule.loadConfig = originalLoadConfig;
    global.fetch = nativeFetch;
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
  }
});

test('Draft expiry uses the documented cutoff without altering archived files', () => {
  assert.equal(draft.expiry('2026-10-28T01:59:59.000Z'), '2026-11-04T01:59:59.000Z');
  assert.equal(draft.expiry('2026-10-28T02:00:00.000Z'), '2026-11-11T02:00:00.000Z');
  assert.equal(draft.expiry('invalid'), null);
});
