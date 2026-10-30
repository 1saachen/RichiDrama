const test = require('node:test');
const assert = require('node:assert/strict');
const relay = require('../src/services/relayVideoBillingService');
const pricing = require('../src/services/richbestPricingService');
const billing = require('../src/services/billingService');

function snapshot(model, hasVideo) { return { provider_model: model, pricing_context: { has_video_input: hasVideo }, usage: { second: 30 }, rates: [{ meter: 'second', unit_size: 1, unit_price_micro: 300000, conditions: { relay_video_billing_version: 1, provider_model: model, provider_site: 'domestic' } }, ...(model.endsWith('lite') ? [{ meter: 'input_image', unit_size: 1, unit_price_micro: 150000, conditions: { relay_video_billing_version: 1, provider_model: model } }] : [])] }; }

test('Vega uses returned seconds, Pro reference floor and Lite image surcharge rather than requested time or tokens', () => {
  const pro = snapshot('vega-1.0-pro', true);
  const usage = relay.actualUsage(pro, { completion_tokens: 999999, vega: { OutputSeconds: 6, InputSeconds: 2 } });
  assert.deepEqual(usage, { second: 10 });
  assert.equal(billing.snapshotCalculation(pro, usage).amount_micro, 3000000);
  const fractional = relay.actualUsage(pro, { vega: { OutputSeconds: 4, InputSeconds: 1 } });
  assert.equal(billing.snapshotCalculation(pro, fractional).amount_micro, 2000000);
  assert.deepEqual(relay.actualUsage(snapshot('vega-1.0-lite', true), { vega: { OutputSeconds: 4, InputSeconds: 2, InputImageCount: 7 } }), { second: 6, input_image: 2 });
  for (const raw of [{}, { vega: { OutputSeconds: 0, InputSeconds: 0 } }, { vega: { OutputSeconds: 6 } }]) assert.throws(() => relay.actualUsage(pro, raw), /真实输入／输出秒数/);
  assert.equal(relay.actualUsage({ usage: { second: 5 }, rates: [] }, {}), null, 'legacy snapshots retain the prior path');
  assert.deepEqual(relay.reservation(['second'], { model: 'vega-1.5-pro', has_video_input: true, requested_duration: -1 }), { second: 330 });
});

test('Vega pricing keeps the site, maps seconds and extra images, and rejects mixed sites', () => {
  const model = 'vega-1.0-lite';
  const entries = [{ id: model, modality: 'video', prices: [
    { metric: 'video_second', dimension: 'international:768p:no_video', unit_size: 1, effective_price_yuan: '0.385075' },
    { metric: 'image', dimension: 'international:input:after_five', unit_size: 1, effective_price_yuan: '0.200680' },
  ] }];
  const compile = () => pricing.buildCandidates(entries, { resolveTarget: () => ({ billing_key: model, configuredTypes: ['video'] }) });
  const rows = compile();
  assert.deepEqual(rows.map(row => row.meter), ['second', 'input_image']);
  assert.ok(rows.every(row => row.mapping_status === 'mapped'));
  assert.equal(JSON.parse(rows[0].new_conditions_json).provider_site, 'international');
  assert.equal(rows[0].new_unit_price_micro, 385075);
  entries[0].prices.push({ ...entries[0].prices[0], dimension: 'domestic:768p:no_video' });
  assert.ok(compile().filter(row => row.meter === 'second').every(row => row.mapping_status === 'unmapped'));
});
