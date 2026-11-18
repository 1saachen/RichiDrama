const test = require('node:test');
const assert = require('node:assert/strict');
const { modelCatalogFixture } = require('./helpers/modelCatalogFixture');
const ai = require('../src/services/aiConfigService');
const prices = require('../src/services/providerPriceService');
const FLASH = 'doubao-seedance-2-5-flash-261115';
const OLD = 'doubao-seedance-2-0-mini-260615';

test('Flash catalog onboarding, conditional quotes and capabilities survive restart without changing existing models', async () => {
  const f = await modelCatalogFixture();
  try {
    const config = ai.createConfig(f.db, f.log, { service_type: 'video', provider: 'volcengine', name: 'isolated direct video',
      model: [OLD], default_model: OLD, is_default: true, base_url: 'http://supplier.invalid', api_key: 'fixture-only' });
    const login = await f.request('POST', '/auth/login', { username: 'catalog-admin', password: 'fixture-password' });
    assert.equal(login.status, 200);
    const call = async (method, route, body, status = 200) => {
      const r = await f.request(method, route, body, login.cookie);
      assert.equal(r.status, status, JSON.stringify(r.body));
      return r.body.data;
    };
    const before = f.db.prepare('SELECT * FROM billing_price_book_items WHERE price_book_id=? ORDER BY id').all(f.book.id);
    const row = { service_type: 'video', model: FLASH, config_id: config.id, display_name: 'Seedance 2.5 Flash', status: 'draft' };
    await call('POST', '/admin/model-catalog', row);
    await call('POST', '/admin/model-catalog', { ...row, status: 'active' }, 400);
    const candidate = prices.buildCandidateRows(f.db, { FoundationModelName: 'doubao-seedance-2-5-flash', MultiChargeItems: [{ ChargeItems: [
      { Type: 'V2VCompletion', Price: 0.028, UnitCode: '千tokens' }, { Type: 'NV2VCompletion', Price: 0.046, UnitCode: '千tokens' },
    ] }] })[0];
    assert.equal(candidate.mapping_status, 'mapped');
    const conditions = JSON.parse(candidate.new_conditions_json);
    const draft = await call('POST', '/admin/model-catalog/price-draft', { service_type: 'video', model: FLASH, price_book_id: f.book.id,
      items: [{ meter: 'output_token', unit_price: 4600, conditions_json: conditions }] }, 201);
    await call('POST', `/admin/price-books/${draft.id}/publish`, { confirm: true, reason: 'isolated Flash onboarding test', idempotency_key: 'flash-test-publish', notify_users: false });
    await call('POST', '/admin/model-catalog', { ...row, status: 'active' });
    const quote = async (has_video_input) => (await call('POST', '/billing/quotes', { service_type: 'video', provider: 'volcengine', model: FLASH,
      usage: { output_token: 1000000 }, pricing_context: { has_video_input, resolution: '720p' } })).amount;
    assert.equal(await quote(false), 4600);
    assert.equal(await quote(true), 2800);
    const caps = await call('GET', '/video-model-capabilities');
    const flash = caps.find(x => x.model === FLASH);
    assert.deepEqual(flash.limits.resolutions, ['480p', '720p']);
    assert.equal(flash.limits.image_reference.max, 10);
    assert.equal(flash.limits.audio_reference.max, 5);
    await f.restart();
    assert.equal(await quote(false), 4600);
    const catalog = await call('GET', '/admin/model-catalog');
    assert.equal(catalog.find(x => x.model === FLASH).status, 'active');
    assert.equal(ai.getConfig(f.db, config.id).default_model, OLD);
    for (const old of before) assert.deepEqual(f.db.prepare('SELECT * FROM billing_price_book_items WHERE id=?').get(old.id), old);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM video_generations').get().n, 0);
  } finally { await f.close(); }
});
