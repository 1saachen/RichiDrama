const test = require('node:test');
const assert = require('node:assert/strict');
const { providerPriceReviewFixture } = require('./helpers/providerPriceReviewFixture');
const prices = require('../src/services/providerPriceService');
const ai = require('../src/services/aiConfigService');

const relayPayload = { data: [{ id: 'vega-1.0-pro', modality: 'video', configured: true, prices: [
  { metric: 'video_second', dimension: 'international:720p:no_video', unit_size: 1, effective_price_yuan: '0.500000' },
  { metric: 'video_second', dimension: 'international:720p:video', unit_size: 1, effective_price_yuan: '0.300000' },
  { metric: 'video_second', dimension: 'international:1080p:no_video', unit_size: 1, effective_price_yuan: '1.000000' },
] }] };

test('both supplier paths keep rules immutable through editing, copying, model pricing, publishing and restart', async () => {
  const f = await providerPriceReviewFixture();
  try {
    const login = await f.request('POST', '/auth/login', { username: 'catalog-admin', password: 'fixture-password' });
    const cookie = login.cookie;
    ai.createConfig(f.db, f.log, { service_type: 'video', provider: 'richbest', name: 'isolated Vega pricing', base_url: 'http://supplier.invalid', api_key: 'fixture-only', model: ['vega-1.0-pro'] });
    const relay = await prices.sync(f.db, f.admin.id, { provider: 'richbest', fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(relayPayload) }) });
    for (const syncId of [f.syncId, relay.id]) {
      const detail = prices.syncView(f.db, syncId);
      for (const row of detail.candidates.filter(row => row.mapping_status !== 'mapped')) prices.updateCandidate(f.db, f.admin.id, syncId, row.id, { review_status: 'rejected' });
      assert.equal((await f.request('POST', `/admin/provider-price-syncs/${syncId}/accept-mapped`, {}, cookie)).status, 200);
      const created = await f.request('POST', `/admin/provider-price-syncs/${syncId}/create-draft`, {}, cookie);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const draft = created.body.data;
      assert.equal(draft.rules_locked, true);
      const payload = () => ({ name: draft.name, provider: draft.provider, items: structuredClone(draft.items) });
      for (const field of ['meter', 'model', 'service_type']) {
        const tampered = payload(); tampered.items[0][field] = 'tampered';
        assert.equal((await f.request('PATCH', `/admin/price-books/${draft.id}`, tampered, cookie)).status, 400);
      }
      const unit = payload(); unit.items[0].conditions_json = { ...(unit.items[0].conditions_json || {}), unit_size: 7 };
      assert.equal((await f.request('PATCH', `/admin/price-books/${draft.id}`, unit, cookie)).status, 400);
      const deleted = payload(); deleted.items.pop();
      assert.equal((await f.request('PATCH', `/admin/price-books/${draft.id}`, deleted, cookie)).status, 400);
      const changed = payload(); changed.items[0].unit_price += 1;
      const saved = await f.request('PATCH', `/admin/price-books/${draft.id}`, changed, cookie);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const published = await f.request('POST', `/admin/price-books/${draft.id}/publish`, { confirm: true, reason: 'isolated supplier contract', idempotency_key: `contract-${draft.id}`, notify_users: false }, cookie);
      assert.equal(published.status, 200, JSON.stringify(published.body));
      const clone = await f.request('POST', `/admin/price-books/${draft.id}/clone`, {}, cookie);
      assert.equal(clone.status, 201, JSON.stringify(clone.body));
      assert.equal(clone.body.data.rules_locked, true);
      const cloneTamper = { name: clone.body.data.name, provider: clone.body.data.provider, items: structuredClone(clone.body.data.items) };
      cloneTamper.items[0].meter = 'request';
      assert.equal((await f.request('PATCH', `/admin/price-books/${clone.body.data.id}`, cloneTamper, cookie)).status, 400);
      if (draft.provider === 'richbest') {
        const item = published.body.data.price_book.items.find(row => row.model === 'vega-1.0-pro');
        const modelChange = { service_type: 'video', model: item.model, price_book_id: draft.id, items: [{ ...item, meter: 'output_token' }] };
        assert.equal((await f.request('POST', '/admin/model-catalog/price-draft', modelChange, cookie)).status, 400);
        modelChange.items = [{ ...item, unit_price: item.unit_price + 1 }];
        const modelDraft = await f.request('POST', '/admin/model-catalog/price-draft', modelChange, cookie);
        assert.equal(modelDraft.status, 201, JSON.stringify(modelDraft.body));
        assert.equal(modelDraft.body.data.provider, 'richbest');
        assert.equal(modelDraft.body.data.rules_locked, true);
      }
    }
    await f.restart();
    const restored = await f.request('GET', '/admin/price-books', undefined, cookie);
    assert.equal(restored.status, 200);
    assert.ok(restored.body.data.filter(book => book.source_sync_id || book.parent_price_book_id).every(book => book.rules_locked));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM price_book_rule_snapshots').get().n >= 4, true);
  } finally { await f.close(); }
});

module.exports = { relayPayload };
