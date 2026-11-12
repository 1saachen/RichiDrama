const test = require('node:test');
const assert = require('node:assert/strict');
const { modelCatalogFixture } = require('./helpers/modelCatalogFixture');
const video = require('../src/services/videoService');
const ai = require('../src/services/aiConfigService');
const billing = require('../src/services/billingService');
const prices = require('../src/services/providerPriceService');

test('Fast and Mini capabilities agree with submission and preserve historical records', async () => {
  const f = await modelCatalogFixture();
  try {
    const mini = 'doubao-seedance-2-0-mini-260615';
    const full = 'doubao-seedance-2-0-260128';
    const relayFast = ['doubao-seedance-2.0-fast', 'dreamina-seedance-2.0-fast'];
    ai.createConfig(f.db, f.log, {
      service_type: 'video', provider: 'volcengine', api_protocol: 'volcengine_omni',
      name: 'isolated Seedance connection', model: [mini, full], default_model: full,
      base_url: 'http://127.0.0.1:1', api_key: 'fixture-only', is_default: true,
    });
    ai.createConfig(f.db, f.log, {
      service_type: 'video', provider: 'richbest', name: 'isolated Fast relay',
      model: relayFast, default_model: relayFast[0], base_url: 'http://127.0.0.1:1', api_key: 'fixture-only',
    });
    billing.savePriceBook(f.db, f.admin.id, {
      name: 'isolated Fast pricing', provider: 'richbest', status: 'published',
      items: relayFast.map((model) => ({ service_type: 'video', model, meter: 'second', unit_price: 1 })),
    });
    const login = await f.request('POST', '/auth/login', { username: 'catalog-admin', password: 'fixture-password' });
    assert.equal(login.status, 200);
    const cookie = login.cookie;
    const project = await f.request('POST', '/dramas', { title: 'Seedance resolution fixture' }, cookie);
    assert.equal(project.status, 201);
    const capabilities = await f.request('GET', '/video-model-capabilities', undefined, cookie);
    assert.equal(capabilities.status, 200);
    assert.ok(capabilities.body.data.find((entry) => entry.model === full).limits.resolutions.includes('1080p'));

    const authorizations = () => f.db.prepare("SELECT COUNT(*) AS n FROM billing_transactions WHERE type='authorization'").get().n;
    const before = authorizations();
    for (const model of [mini, ...relayFast]) {
      assert.deepEqual(capabilities.body.data.find((entry) => entry.model === model).limits.resolutions, ['480p', '720p']);
      const body = { model, prompt: 'a paper boat', duration: 4, aspect_ratio: '16:9', resolution: '1080p' };
      for (const [route, payload] of [
        ['/omni-video-jobs/quote', body],
        ['/omni-video-jobs', { ...body, source_context: 'single_video_tool' }],
        ['/videos', { ...body, drama_id: project.body.data.id }],
      ]) {
        const rejected = await f.request('POST', route, payload, cookie);
        assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
        assert.match(JSON.stringify(rejected.body), /不支持 1080p 原片/);
      }
      for (const resolution of ['480p', '720p']) {
        const quote = await f.request('POST', '/omni-video-jobs/quote', { ...body, resolution }, cookie);
        assert.equal(quote.status, 200, JSON.stringify(quote.body));
      }
    }
    assert.equal(authorizations(), before);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n, 0);
    const now = new Date().toISOString();
    const legacy = f.db.prepare(`INSERT INTO video_generations
      (owner_user_id, provider, model, status, resolution, created_at, updated_at)
      VALUES (?, 'richbest', ?, 'failed', '1080p', ?, ?)`).run(f.admin.id, relayFast[0], now, now);
    await f.restart();
    const history = await f.request('GET', `/videos/${legacy.lastInsertRowid}`, undefined, cookie);
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.resolution, '1080p');
    assert.equal(history.body.data.status, 'failed');
  } finally { await f.close(); }
});

test('Omni stores the resolved provider when the UI omits it or sends a stale default; restart preserves it', async () => {
  const f = await modelCatalogFixture();
  const originalProcess = video.processVideoGeneration;
  const prepared = [];
  video.processVideoGeneration = (_db, _log, id) => { prepared.push(id); };
  try {
    ai.createConfig(f.db, f.log, { service_type: 'video', provider: 'richbest', name: 'isolated provider metadata', model: ['vega-1.0-pro'], default_model: 'vega-1.0-pro', base_url: 'http://supplier.invalid', api_key: 'fixture-only', is_default: true });
    const login = await f.request('POST', '/auth/login', { username: 'catalog-admin', password: 'fixture-password' });
    const synced = await prices.sync(f.db, f.admin.id, { provider: 'richbest', fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: [{ id: 'vega-1.0-pro', modality: 'video', configured: true, prices: [{ metric: 'video_second', dimension: 'domestic:720p:no_video', unit_size: 1, effective_price_yuan: '0.500000' }] }] }) }) });
    prices.acceptMappedCandidates(f.db, f.admin.id, synced.id);
    const draft = prices.createDraft(f.db, f.admin.id, synced.id);
    assert.equal((await f.request('POST', `/admin/price-books/${draft.id}/publish`, { confirm: true, reason: 'isolated metadata contract', idempotency_key: 'provider-metadata-price', notify_users: false }, login.cookie)).status, 200);
    billing.adjustBalance(f.db, f.admin.id, f.admin.id, 100000, 'isolated fixture test credits');
    const ids = [];
    for (const extra of [{}, { provider: 'chatfire' }]) {
      const res = await f.request('POST', '/omni-video-jobs', { source_context: 'single_video_tool', idempotency_key: `provider-metadata-${ids.length}`, model: 'vega-1.0-pro', prompt: 'isolated metadata only', duration: 4, resolution: '720p', aspect_ratio: '16:9', assets: [], ...extra }, login.cookie);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const id = res.body.data.video_generation_id; ids.push(id);
      assert.equal(f.db.prepare('SELECT provider FROM video_generations WHERE id=?').get(id).provider, 'richbest');
    }
    await new Promise(setImmediate);
    assert.equal(prepared.length, 2, 'stub intercepts all work; no supplier or media generation');
    await f.restart();
    for (const id of ids) assert.equal(video.getById(f.db, id).provider, 'richbest');
  } finally { video.processVideoGeneration = originalProcess; await f.close(); }
});
