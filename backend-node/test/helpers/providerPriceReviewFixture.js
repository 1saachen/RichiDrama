const { modelCatalogFixture } = require('./modelCatalogFixture');
const ai = require('../../src/services/aiConfigService');
const prices = require('../../src/services/providerPriceService');

async function providerPriceReviewFixture(port = 0) {
  const fixture = await modelCatalogFixture(port);
  const { db, admin, log } = fixture;
  ai.createConfig(db, log, { service_type: 'model_ark_asset', provider: 'volcengine', name: 'isolated-asset', model: 'asset', settings: JSON.stringify({ access_key_id: 'fixture-ak', secret_access_key: 'fixture-sk' }) });
  const items = [];
  for (let index = 0; index < 6; index++) {
    const model = `doubao-review-text-${index}`;
    ai.createConfig(db, log, { service_type: 'text', provider: 'volcengine', name: `隔离验收文本 ${index + 1}`, base_url: 'http://supplier.invalid', api_key: 'fixture-only', model: [model] });
    items.push({ FoundationModelName: model, DisplayName: `文本验收模型 ${index + 1}`, ChargeItems: [
      { Type: 'InferencePrompt', UnitCode: '千 tokens', Price: 0.0008 },
      { Type: 'InferenceCompletion', UnitCode: '千 tokens', Price: 0.002 },
    ] });
  }
  const model = 'doubao-seedance-2-5';
  ai.createConfig(db, log, { service_type: 'video', provider: 'volcengine', name: '隔离视频验收', base_url: 'http://supplier.invalid', api_key: 'fixture-only', model: [model] });
  items.push({ FoundationModelName: model, DisplayName: '视频验收模型', MultiChargeItems: [{ ChargeItems: [
    { Type: 'V2VCompletion', UnitCode: '千 tokens', Price: 0.042 }, { Type: 'NV2VCompletion', UnitCode: '千 tokens', Price: 0.07 },
    { Type: 'V2V1080Completion', UnitCode: '千 tokens', Price: 0.046 }, { Type: 'NV2V1080Completion', UnitCode: '千 tokens', Price: 0.077 },
  ] }] });
  ai.createConfig(db, log, { service_type: 'text', provider: 'volcengine', name: '未识别规则', base_url: 'http://supplier.invalid', model: ['doubao-review-unknown'] });
  items.push({ FoundationModelName: 'doubao-review-unknown', DisplayName: '未识别规则验收', ChargeItems: [{ Type: 'UnknownCharge', UnitCode: 'unknown', Price: 1 }] });
  const sync = await prices.sync(db, admin.id, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ResponseMetadata: { RequestId: 'fixture-request' }, Result: { TotalCount: items.length, Items: items } }) }) });
  // One unchanged item and one deliberately excluded item exercise batch scope.
  const mapped = sync.candidates.filter(row => row.mapping_status === 'mapped');
  db.prepare('UPDATE provider_price_candidates SET current_unit_price_micro=new_unit_price_micro, conditions_changed=0 WHERE id=?').run(mapped[0].id);
  prices.updateCandidate(db, admin.id, sync.id, mapped[1].id, { review_status: 'rejected' });
  const at = new Date().toISOString();
  db.prepare("INSERT INTO provider_price_source_checks(provider,ark_status,billing_status,checked_at,detail_json,updated_at) VALUES ('volcengine','success','success',?,'{}',?)").run(at, at);
  return Object.assign(fixture, { syncId: sync.id });
}
module.exports = { providerPriceReviewFixture };
