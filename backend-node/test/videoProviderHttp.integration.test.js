const test = require('node:test');
const assert = require('node:assert/strict');
const { modelCatalogFixture } = require('./helpers/modelCatalogFixture');
const video = require('../src/services/videoService');
const ai = require('../src/services/aiConfigService');
const billing = require('../src/services/billingService');
const prices = require('../src/services/providerPriceService');

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
