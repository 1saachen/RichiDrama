import test from 'node:test'
import assert from 'node:assert/strict'
import { chargeItemLabel, priceRuleSummary, supplierPriceText, billingUnitLabel } from '../src/utils/providerPricePresentation.js'

test('official video rates and supplier charge codes render as readable Chinese with units', () => {
  const row = { mapping_status: 'mapped', service_type: 'video', meter: 'output_token', charge_type: 'VerifiedVideoInputResolutionRates', unit_code: '千 tokens', provider_unit_price: 'V2VCompletion=0.042; NV2V1080Completion=0.077' }
  assert.equal(chargeItemLabel(row), '视频生成费')
  assert.equal(supplierPriceText(row), '有参考视频：0.042 元 / 千 Token\n无参考视频 · 1080p：0.077 元 / 千 Token')
  assert.equal(billingUnitLabel('output_token', 1000000), '100万 输出 Token')
  const summary = priceRuleSummary({ unit_size: 1000000, rates: [{ id: 'internal-code', when: { has_video_input: false, resolution: '1080p' }, unit_price_points: 7700 }] }, 'output_token')
  assert.equal(summary, '无参考视频 · 1080p：7700 积分 / 100万 输出 Token')
  assert.doesNotMatch(summary, /internal-code|has_video_input/)
})

test('tiered prices preserve each tier and quantity, and unknown charges remain visibly unsupported', () => {
  const summary = priceRuleSummary({ usage_tiers: [{ min_inclusive: 0, max_inclusive: 32768, unit_size: 1000000, unit_price_points: 60 }, { min_inclusive: 32769, max_inclusive: 131072, unit_size: 1000000, unit_price_points: 90 }] }, 'input_token')
  assert.match(summary, /0–32,768 Token：60 积分 \/ 100万 输入 Token/)
  assert.match(summary, /32,769–131,072 Token：90 积分/)
  assert.equal(chargeItemLabel({ mapping_status: 'unmapped', charge_type: 'MultiChargeItems[0]' }), '计费规则待识别')
  assert.equal(supplierPriceText({ provider_unit_price: null }), '—')
  assert.equal(priceRuleSummary({ image_pricing_version: 'seedream-pro-v1', free_units: 1 }, 'input_image'), '每次请求首张输入图免费，第 2 张起按张计费')
})

test('Flash prices describe free reference inputs and avoid Pro pixel tiers', () => {
  const row = { provider_model: 'doubao-seedream-5-0-flash', unit_code: '张', provider_unit_price: 'ToICompletion=0.12; ToILayerCompletion=0.12' }
  assert.equal(supplierPriceText(row), '单图生成：0.12 元 / 张\n图层拆分：0.12 元 / 张')
  const summary = priceRuleSummary({ image_pricing_version: 'seedream-flash-v1', unit_size: 1, rates: [
    { when: { image_scene: 'single' }, unit_price_points: 12, unit_size: 1 },
    { when: { image_scene: 'layer' }, unit_price_points: 12, unit_size: 1 },
  ] }, 'image')
  assert.match(summary, /参考图输入免费/)
  assert.match(summary, /不按像素分档/)
  assert.match(summary, /单图生成：12 积分/)
  assert.doesNotMatch(summary, /261/)
})
