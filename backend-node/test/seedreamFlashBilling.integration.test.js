const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const sharp = require('sharp');
const { modelCatalogFixture } = require('./helpers/modelCatalogFixture');
const { model, activation } = require('./helpers/seedreamFlashPrices');
const proFixture = require('./helpers/seedreamProPrices');
const prices = require('../src/services/providerPriceService');
const billing = require('../src/services/billingService');
const ai = require('../src/services/aiConfigService');
const policy = require('../src/services/seedreamProPricing');
const cost = require('../src/services/supplierCostRates');

process.env.MINIDRAMA_PROFILE = 'dev';
process.env.CFG_STORAGE__TYPE = 'local';

async function prepare(f, baseUrl = 'http://supplier.invalid') {
  process.env.CFG_STORAGE__LOCAL_PATH = path.join(f.root, 'storage');
  for (const service_type of ['image', 'storyboard_image']) ai.createConfig(f.db, f.log, {
    service_type, provider: 'volcengine', name: `Flash ${service_type}`, model, default_model: model,
    base_url: baseUrl, api_key: 'fixture-only', api_protocol: 'volcengine',
  });
  const cookie = (await f.request('POST', '/auth/login', { username: f.admin.username, password: 'fixture-password' })).cookie;
  const rows = prices.buildCandidateRows(f.db, activation);
  assert.equal(rows.length, 2);
  const items = rows.map(row => ({ service_type: row.service_type, model: row.billing_key, meter: row.meter,
    unit_price: row.new_unit_price_micro / 10000, conditions_json: JSON.parse(row.new_conditions_json) }));
  const book = await f.request('POST', '/admin/price-books', { name: 'Flash isolated', status: 'published', items }, cookie);
  assert.equal(book.status, 201, JSON.stringify(book.body));
  return { cookie, items };
}

test('Flash maps the exact two-charge contract, rejects unknown dimensions, and prices no reference input', async () => {
  const f = await modelCatalogFixture();
  try {
    await prepare(f);
    assert.equal(prices.buildCandidateRows(f.db, { ...activation, MultiChargeItems: [] }).length, 2);
    for (const mutate of [
      item => item.MultiChargeItems[0].ChargeItems.pop(),
      item => item.MultiChargeItems[0].ChargeItems.push({ Type: 'ToIPrompt', Price: 0.02, UnitCode: '张' }),
      item => { item.MultiChargeItems[0].ChargeItems[0].UnitCode = '千 tokens'; },
      item => { item.MultiChargeItems[0].ChargeItems[0].Price = null; },
      item => { item.MultiChargeItems[0].MaxPixels = 2610000; },
    ]) {
      const value = structuredClone(activation); mutate(value);
      assert.ok(prices.buildCandidateRows(f.db, value).every(row => row.mapping_status === 'unmapped'));
    }
    for (const image_scene of ['single', 'layer']) for (const input_image_count of [0, 1, 10]) {
      const result = cost.calculate(cost.decode(activation, new Date().toISOString()), { image: 1 }, { image_scene, input_image_count });
      assert.equal(result.status, 'calculated');
      assert.equal(result.amount_micro, 120000);
      assert.deepEqual(result.rates.map(row => row.meter), ['image']);
    }
    assert.equal(cost.calculate(cost.decode(activation, new Date().toISOString()), { image: 1 }, {}).status, 'missing_price');
  } finally { await f.close(); }
});

test('Pro and Flash account prices sync, review, publish, quote and survive restart without changing historical ledgers', async () => {
  const f = await modelCatalogFixture();
  const originalFetch = global.fetch;
  try {
    await f.restart(); // Establish the existing bootstrap's stable baseline.
    const { cookie, items } = await prepare(f);
    const proModel = 'doubao-seedream-5-0-pro-260628';
    const accountPro = structuredClone(proFixture.activation);
    for (const charge of [...accountPro.ChargeItems, ...accountPro.MultiChargeItems.flatMap(g => g.ChargeItems)]) charge.Price = charge.OriginalPrice;
    for (const service_type of ['image', 'storyboard_image']) ai.createConfig(f.db, f.log, { service_type, provider: 'volcengine', name: `Pro ${service_type}`, model: proModel });
    ai.createConfig(f.db, f.log, { service_type: 'model_ark_asset', provider: 'volcengine', name: 'isolated credentials', model: 'asset', settings: JSON.stringify({ access_key_id: 'fixture-ak', secret_access_key: 'fixture-sk' }) });
    const historical = billing.createAuthorization(f.db, f.admin, { service_type: 'image', model: 'existing-image', usage: { image: 1 }, idempotency_key: 'old-image-authorization' });
    const historicalRow = f.db.prepare('SELECT * FROM billing_transactions WHERE id=?').get(historical.authorization_id);
    global.fetch = async (url, init) => {
      if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, init);
      assert.match(String(url), /^https:\/\/open\.volcengineapi\.com\//);
      assert.equal(new URL(url).searchParams.get('Action'), 'ListModelActivations');
      return new Response(JSON.stringify({ ResponseMetadata: { RequestId: 'isolated-pro-flash-prices' }, Result: { TotalCount: 2, Items: [activation, accountPro] } }));
    };
    const sync = await f.request('POST', '/admin/provider-prices/volcengine/sync', {}, cookie);
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    const candidates = sync.body.data.candidates;
    assert.equal(candidates.length, 6);
    assert.ok(candidates.every(row => row.mapping_status === 'mapped'));
    const at = new Date().toISOString();
    f.db.prepare("INSERT INTO provider_price_source_checks(provider,ark_status,billing_status,checked_at,updated_at) VALUES ('volcengine','success','success',?,?)").run(at, at);
    const base = `/admin/provider-price-syncs/${sync.body.data.id}`;
    assert.equal((await f.request('POST', `${base}/accept-mapped`, {}, cookie)).status, 200);
    const draft = await f.request('POST', `${base}/create-draft`, {}, cookie);
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const published = await f.request('POST', `/admin/price-books/${draft.body.data.id}/publish`, { confirm: true, reason: 'isolated new-account billing', idempotency_key: 'pro-flash-prices', notify_users: false }, cookie);
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.data.price_book.rules_locked, true);
    for (const service_type of ['image', 'storyboard_image']) for (const refs of [0, 1, 10]) for (const size of ['1024x1024', '2048x2048']) {
      const quote = await f.request('POST', '/billing/quotes', { service_type, model, usage: { image: 1, input_image: refs }, pricing_context: policy.context({ size, reference_images: Array(refs).fill('fixture') }) }, cookie);
      assert.equal(quote.status, 200, JSON.stringify(quote.body));
      assert.equal(quote.body.data.amount, 12);
      assert.deepEqual(quote.body.data.usage, { image: 1 });
    }
    const resourceBatch = await f.request('POST', '/billing/resource-image-quotes', { model, count: 3, image_input_count: 3, size: '1024x1024', reference_images: Array(10).fill('fixture') }, cookie);
    assert.equal(resourceBatch.status, 200, JSON.stringify(resourceBatch.body));
    assert.equal(resourceBatch.body.data.amount, 36);
    const proQuote = await f.request('POST', '/billing/quotes', { service_type: 'image', model: proModel, usage: { image: 1 }, pricing_context: policy.context({ size: '1024x1024', reference_images: ['one', 'two', 'three'] }) }, cookie);
    assert.equal(proQuote.body.data.amount, 34);
    for (const payload of [{ usage: { image: 2 }, pricing_context: policy.context() }, { usage: { image: 1 } }, { usage: { image: 1 }, pricing_context: { image_scene: 'single', input_image_count: 11 } }]) {
      assert.equal((await f.request('POST', '/billing/quotes', { service_type: 'image', model, ...payload }, cookie)).status, 400);
    }
    const invalid = structuredClone(items);
    invalid[0].conditions_json.rates[0].when.pixel_band = 'small';
    assert.equal((await f.request('POST', '/admin/price-books', { name: 'invalid pixel tiers', items: invalid }, cookie)).status, 400);
    const surcharge = [...items, { ...items[0], meter: 'input_image', unit_price: 2, conditions_json: {} }];
    assert.equal((await f.request('POST', '/admin/price-books', { name: 'invalid reference surcharge', items: surcharge }, cookie)).status, 400);
    await f.restart();
    assert.deepEqual(f.db.prepare('SELECT * FROM billing_transactions WHERE id=?').get(historical.authorization_id), historicalRow);
    const settled = billing.settleAuthorization(f.db, f.admin, historical.authorization_id, { usage: { image: 1 } });
    assert.equal(settled.charged_micro, 10000);
    const restored = await f.request('POST', '/billing/quotes', { service_type: 'image', model, usage: { image: 1 }, pricing_context: policy.context({ size: '1024x1024' }) }, cookie);
    assert.equal(restored.body.data.amount, 12);
  } finally { global.fetch = originalFetch; await f.close(); }
});

test('Flash HTTP single-image generation stores media, settles once, releases clear failures, and keeps unknown outcomes for reconciliation after restart', async () => {
  const f = await modelCatalogFixture();
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: 'blue' } }).png().toBuffer();
  fs.mkdirSync(path.join(f.root, 'storage'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'storage/reference.png'), png);
  let mode = 'success'; const requests = [];
  const provider = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      const input = JSON.parse(raw); requests.push(input);
      res.setHeader('content-type', 'application/json'); res.setHeader('x-request-id', `flash-${requests.length}`);
      if (mode === 'rejected') { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'isolated rejected request' } })); return; }
      if (mode === 'unknown') { res.statusCode = 500; res.end('{}'); return; }
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }], usage: { generated_images: mode === 'mismatch' ? 2 : 1, input_images: (input.image || []).length } }));
    });
  });
  try {
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const { cookie } = await prepare(f, `http://127.0.0.1:${provider.address().port}/api/v3`);
    const project = await f.request('POST', '/dramas', { title: 'Flash isolated billing' }, cookie);
    const dramaId = project.body.data.id;
    async function generate(key, refs = []) {
      const created = await f.request('POST', '/images', { drama_id: dramaId, prompt: 'Blue square', model, size: '1024x1024', reference_images: refs, idempotency_key: key }, cookie);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      for (let i = 0; i < 150; i++) {
        const row = (await f.request('GET', `/images/${created.body.data.id}`, undefined, cookie)).body.data;
        if (['completed', 'failed'].includes(row?.status)) return row;
        await delay(25);
      }
      assert.fail('isolated Flash task did not finish');
    }
    const image = await generate('flash-success', Array(10).fill('reference.png'));
    assert.equal(image.status, 'completed', image.error_msg);
    assert.equal(requests[0].image.length, 10);
    assert.equal(requests[0].size, '1024x1024');
    assert.equal(requests[0].sequential_image_generation, undefined);
    assert.match(image.image_url, /^\/static\//);
    assert.ok(fs.existsSync(path.join(f.root, 'storage', image.local_path)));
    const authId = f.db.prepare('SELECT billing_authorization_id FROM image_generations WHERE id=?').get(image.id).billing_authorization_id;
    const usage = f.db.prepare('SELECT * FROM billing_usage_logs WHERE authorization_id=?').get(authId);
    assert.equal(usage.charged_micro, 120000);
    assert.deepEqual(JSON.parse(usage.usage_json), { image: 1, image_size: '1024x1024' });
    assert.equal(billing.settleAuthorization(f.db, f.admin, authId, { usage: { image: 1 } }).reused, true);
    mode = 'rejected';
    const rejected = await generate('flash-rejected'); assert.equal(rejected.status, 'failed');
    const rejectedId = f.db.prepare('SELECT billing_authorization_id FROM image_generations WHERE id=?').get(rejected.id).billing_authorization_id;
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE authorization_id=? AND type='void'").get(rejectedId).n, 1);
    for (mode of ['unknown', 'mismatch']) {
      const row = await generate(`flash-${mode}`); assert.equal(row.status, 'failed');
      const id = f.db.prepare('SELECT billing_authorization_id FROM image_generations WHERE id=?').get(row.id).billing_authorization_id;
      assert.equal(f.db.prepare('SELECT status FROM billing_reconciliation_cases WHERE authorization_id=?').get(id).status, 'pending');
      assert.equal(f.db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE authorization_id=? AND type IN ('settlement','void')").get(id).n, 0);
    }
    const before = requests.length;
    await delay(50); await f.restart();
    assert.equal((await f.request('GET', `/images/${image.id}`, undefined, cookie)).body.data.local_path, image.local_path);
    assert.equal(requests.length, before);
    assert.equal(billing.recoverInterruptedImageReconciliations(f.db).recovered, 0);
    assert.equal((await f.request('POST', '/images', { drama_id: dramaId, model, layer_decomposition: true }, cookie)).status, 400);
    assert.equal(requests.length, before);
  } finally { await new Promise(resolve => provider.close(resolve)); await f.close(); }
});
