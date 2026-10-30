const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { modelCatalogFixture } = require('./helpers/modelCatalogFixture');
const ai = require('../src/services/aiConfigService');
const prices = require('../src/services/providerPriceService');
const billing = require('../src/services/billingService');

test('relay video HTTP lifecycle settles real seconds, preserves unknown usage, releases failure and never resubmits on restart', { timeout: 90000 }, async () => {
  const f = await modelCatalogFixture();
  const storage = path.join(f.root, 'storage'); fs.mkdirSync(storage, { recursive: true });
  const previousStorage = process.env.CFG_STORAGE__LOCAL_PATH; process.env.CFG_STORAGE__LOCAL_PATH = storage;
  let server; let creates = 0;
  const submitKeys = [];
  try {
    const clip = path.join(f.root, 'source.mp4');
    const encoded = spawnSync(require('../src/utils/ffmpegPath').getFfmpegPath(), ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=1280x720:r=24:d=1','-c:v','libx264','-pix_fmt','yuv420p',clip], { encoding: 'utf8' });
    assert.equal(encoded.status, 0, encoded.error?.message || encoded.stderr);
    const bytes = fs.readFileSync(clip);
    server = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST') {
        let text = ''; for await (const chunk of req) text += chunk;
        const body = JSON.parse(text);
        const allowed = ['model', 'content', 'duration', 'resolution', 'ratio', 'generate_audio', 'seed'];
        if (Object.keys(body).some(key => !allowed.includes(key)) || !req.headers['idempotency-key'] || req.headers.authorization !== 'Bearer fixture-only') {
          res.statusCode = 422; res.end(JSON.stringify({ error: { code: 'video_parameter_unsupported', message: 'invalid Vega request contract' } })); return;
        }
        submitKeys.push(req.headers['idempotency-key']);
        creates++; res.end(JSON.stringify({ id: `mock-vega-${creates}`, status: 'queued' })); return;
      }
      if (req.url === '/clip.mp4') { res.setHeader('content-type','video/mp4'); res.end(bytes); return; }
      const id = Number(req.url.split('-').at(-1));
      res.end(JSON.stringify(id === 3 ? { id: 'mock-vega-3', status: 'failed', error: { message: 'isolated rejection' } } : { id: `mock-vega-${id}`, status: 'succeeded', resolution: '720p', content: { video_url: `http://127.0.0.1:${server.address().port}/clip.mp4` }, usage: id === 1 ? { vega: { OutputSeconds: 6 } } : {} }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    ai.createConfig(f.db, f.log, { service_type:'video', provider:'richbest', name:'HTTP Vega mock', base_url:base, api_key:'fixture-only', model:['vega-1.0-pro'], default_model:'vega-1.0-pro', is_default:true });
    const sync = await prices.sync(f.db, f.admin.id, { provider:'richbest', fetchImpl: async () => ({ ok:true, status:200, headers:new Headers(), text:async () => JSON.stringify({ data:[{ id:'vega-1.0-pro', modality:'video', configured:true, prices:[{ metric:'video_second', dimension:'domestic:720p:no_video', unit_size:1, effective_price_yuan:'0.500000' }] }] }) }) });
    prices.acceptMappedCandidates(f.db, f.admin.id, sync.id);
    const draft = prices.createDraft(f.db, f.admin.id, sync.id);
    const login = await f.request('POST','/auth/login',{username:'catalog-admin',password:'fixture-password'}); const cookie=login.cookie;
    assert.equal((await f.request('POST',`/admin/price-books/${draft.id}/publish`,{confirm:true,reason:'isolated relay seconds test',idempotency_key:'seconds-http',notify_users:false},cookie)).status,200);
    billing.adjustBalance(f.db,f.admin.id,f.admin.id,100000,'isolated test balance');
    const project=await f.request('POST','/dramas',{title:'isolated Vega billing'},cookie); assert.equal(project.status,201);
    const beforeHolds = f.db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE type='authorization'").get().n;
    const capabilities = await f.request('GET', '/video-model-capabilities', undefined, cookie);
    assert.equal(capabilities.status, 200);
    assert.match(JSON.stringify(capabilities.body), /vega-1.0-pro/);
    const quote = await f.request('POST', '/omni-video-jobs/quote', { model: 'vega-1.0-pro', duration: 4, resolution: '720p', aspect_ratio: '16:9' }, cookie);
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    const invalidQuote = await f.request('POST', '/omni-video-jobs/quote', { model: 'vega-1.0-pro', duration: -1, resolution: '720p' }, cookie);
    assert.equal(invalidQuote.status, 400);
    for (const invalid of [{ duration: -1 }, { resolution: '480p' }, { seed: 2147483648 }, { task_type: 'edit' }, { reference_image_urls: ['https://example.invalid/a.jpg'] }]) {
      const rejected = await f.request('POST', '/videos', { drama_id: project.body.data.id, model: 'vega-1.0-pro', provider: 'richbest', duration: 4, resolution: '720p', aspect_ratio: '16:9', prompt: 'sea', idempotency_key: 'invalid-' + JSON.stringify(invalid), ...invalid }, cookie);
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    }
    assert.equal(creates, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE type='authorization'").get().n, beforeHolds);
    const completed=[];
    for (let n=1;n<=3;n++) {
      const submitted=await f.request('POST','/videos',{drama_id:project.body.data.id,model:'vega-1.0-pro',provider:n===1?undefined:n===2?'chatfire':'richbest',prompt:'blue sea',duration:5,resolution:'720p',aspect_ratio:'16:9',upscale_resolution:null,target_fps:null,idempotency_key:`vega-http-${n}`},cookie);
      assert.equal(submitted.status,201,JSON.stringify(submitted.body));
      const id=submitted.body.data.id; const deadline=Date.now()+25000; let row;
      do { row=f.db.prepare('SELECT * FROM video_generations WHERE id=?').get(id); if(row.status!=='processing')break; await new Promise(resolve=>setTimeout(resolve,100)); } while(Date.now()<deadline);
      assert.equal(row.status,n===3?'failed':'completed',JSON.stringify({status:row.status,error:row.error_msg}));
      assert.equal(row.provider, 'richbest', 'store the resolved connection provider even when the caller omits it or sends a stale default');
      const expectedKey = require('../src/services/richbestProvider').idempotencyKey('v', row);
      assert.equal(submitKeys[n - 1], expectedKey, 'real HTTP submission must include the persisted authorization, not only the local numeric row ID');
      assert.notEqual(submitKeys[n - 1], `rd-v-${id}`);
      const charge=f.db.prepare('SELECT * FROM billing_usage_logs WHERE authorization_id=?').get(row.billing_authorization_id);
      if(n===1) { assert.equal(charge.charged_micro,3000000); assert.equal(JSON.parse(charge.usage_json).second,6); }
      if(n===2) { assert.equal(charge,undefined); assert.equal(f.db.prepare('SELECT status FROM billing_reconciliation_cases WHERE authorization_id=?').get(row.billing_authorization_id).status,'pending'); }
      if(n===3) assert.ok(f.db.prepare("SELECT 1 FROM billing_transactions WHERE authorization_id=? AND type='void'").get(row.billing_authorization_id));
      if(n<3) { assert.ok(row.local_path); assert.ok(fs.existsSync(path.join(storage,row.local_path))); completed.push({id,path:row.local_path}); }
    }
    // Reproduce a crash after media completion but before reconciliation was
    // written. Only isolated fixture data is changed; the hold stays intact.
    const interrupted=f.db.prepare("SELECT billing_authorization_id FROM video_generations WHERE provider_task_id='mock-vega-2'").get();
    f.db.prepare('DELETE FROM billing_reconciliation_cases WHERE authorization_id=?').run(interrupted.billing_authorization_id);
    await f.restart();
    assert.equal(billing.recoverCompletedVideoReconciliations(f.db).recovered,1);
    assert.equal(billing.recoverCompletedVideoReconciliations(f.db).recovered,0);
    const restored=f.db.prepare('SELECT * FROM billing_reconciliation_cases WHERE authorization_id=?').get(interrupted.billing_authorization_id);
    assert.equal(restored.status,'pending');
    assert.match(restored.reason,/真实秒数/);
    for(const item of completed) { const result=await f.request('GET',`/videos/${item.id}`,undefined,cookie); assert.equal(result.status,200); assert.equal(result.body.data.local_path,item.path); }
    assert.equal(creates,3);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_usage_logs WHERE model=?').get('vega-1.0-pro').n,1);
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    if(previousStorage===undefined) delete process.env.CFG_STORAGE__LOCAL_PATH; else process.env.CFG_STORAGE__LOCAL_PATH=previousStorage;
    await f.close();
  }
});
