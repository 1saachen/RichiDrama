const test = require('node:test');
const assert = require('node:assert/strict');
const { providerPriceReviewFixture } = require('./helpers/providerPriceReviewFixture');
const auth = require('../src/services/authService');
const prices = require('../src/services/providerPriceService');

test('official review rejects unit reinterpretation; batch acceptance is scoped, authenticated and restart-safe', async () => {
  const f = await providerPriceReviewFixture();
  try {
    const login = await f.request('POST', '/auth/login', { username: 'catalog-admin', password: 'fixture-password' });
    assert.equal(login.status, 200);
    const cookie = login.cookie;
    const route = `/admin/provider-price-syncs/${f.syncId}`;
    const rows = () => prices.syncView(f.db, f.syncId).candidates;
    const candidate = rows().find(row => row.mapping_status === 'mapped' && row.review_status === 'pending' && !row.is_unchanged);
    const beforePrices = f.db.prepare('SELECT * FROM billing_price_book_items ORDER BY id').all();
    const beforeLedger = f.db.prepare('SELECT * FROM billing_transactions ORDER BY id').all();
    const originalRows = rows();
    for (const data of [{ meter: 'second' }, { unit_size: 1 }, { service_type: 'video' }, { billing_key: 'another-model' }]) {
      const result = await f.request('PATCH', `${route}/candidates/${candidate.id}`, { ...data, review_status: 'accepted' }, cookie);
      assert.equal(result.status, 400, JSON.stringify(result.body));
      assert.match(result.body.error.message, /不能修改/);
    }
    assert.deepEqual(rows(), originalRows);
    const unknown = rows().find(row => row.mapping_status !== 'mapped');
    assert.equal((await f.request('PATCH', `${route}/candidates/${unknown.id}`, { review_status: 'accepted' }, cookie)).status, 400);
    assert.equal((await f.request('POST', `${route}/accept-mapped`)).status, 401);
    auth.createUser(f.db, { username: 'review-member', password: 'fixture-password' }, f.admin.id);
    const member = await f.request('POST', '/auth/login', { username: 'review-member', password: 'fixture-password' });
    assert.equal((await f.request('POST', `${route}/accept-mapped`, {}, member.cookie)).status, 403);

    // Existing clients may still send the original mapping alongside approval.
    assert.equal((await f.request('PATCH', `${route}/candidates/${candidate.id}`, { service_type: candidate.service_type, billing_key: candidate.billing_key, meter: candidate.meter, unit_size: candidate.unit_size, review_status: 'accepted' }, cookie)).status, 200);
    const expected = rows().filter(row => row.mapping_status === 'mapped' && row.review_status === 'pending' && !row.is_unchanged).length;
    const result = await f.request('POST', `${route}/accept-mapped`, {}, cookie);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.accepted_count, expected);
    assert.equal((await f.request('POST', `${route}/accept-mapped`, {}, cookie)).body.data.accepted_count, 0);
    for (const original of originalRows) {
      const current = rows().find(row => row.id === original.id);
      if (original.mapping_status !== 'mapped' || original.is_unchanged || original.review_status === 'rejected') assert.equal(current.review_status, original.review_status);
      for (const field of ['meter', 'unit_size', 'billing_key', 'service_type', 'new_unit_price_micro', 'new_conditions_json']) assert.equal(current[field], original[field]);
    }
    assert.equal((await f.request('POST', `${route}/create-draft`, {}, cookie)).status, 400, 'unknown pending rules block publishing');
    assert.deepEqual(f.db.prepare('SELECT * FROM billing_price_book_items ORDER BY id').all(), beforePrices, 'review does not publish or change prices');
    assert.deepEqual(f.db.prepare('SELECT * FROM billing_transactions ORDER BY id').all(), beforeLedger);
    const afterReview = rows();
    await f.restart();
    const restored = await f.request('GET', route, undefined, cookie);
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body.data.candidates, afterReview);
    // Verify an existing user-created price independently of the migration
    // fixtures, whose bootstrap defaults are populated across startup passes.
    for (const historical of beforePrices.filter(row => row.price_book_id === f.book.id)) assert.deepEqual(f.db.prepare('SELECT * FROM billing_price_book_items WHERE id=?').get(historical.id), historical, 'historical price remains readable and unchanged after startup migrations');
    assert.deepEqual(f.db.prepare('SELECT * FROM billing_transactions ORDER BY id').all(), beforeLedger);
    assert.equal((await f.request('PATCH', `${route}/candidates/${unknown.id}`, { review_status: 'rejected' }, cookie)).status, 200);
    const drafted = await f.request('POST', `${route}/create-draft`, {}, cookie);
    assert.equal(drafted.status, 201, JSON.stringify(drafted.body));
    assert.equal((await f.request('POST', `${route}/accept-mapped`, {}, cookie)).status, 400);
    assert.equal(f.db.prepare('SELECT status FROM billing_price_books WHERE id=?').get(drafted.body.data.id).status, 'draft');
  } finally { await f.close(); }
});
