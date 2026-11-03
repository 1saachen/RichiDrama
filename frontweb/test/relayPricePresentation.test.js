import test from 'node:test'
import assert from 'node:assert/strict'
import { billingUnitLabel, chargeItemLabel, priceRuleSummary } from '../src/utils/providerPricePresentation.js'
test('image Token input and output remain distinct in price review',()=>{
  assert.match(billingUnitLabel('input_image_token',1000000),/图片输入 Token/)
  assert.equal(chargeItemLabel({meter:'input_image_token',service_type:'image'}),'图片输入费')
  assert.equal(chargeItemLabel({meter:'output_token',service_type:'image'}),'图片输出费')
})
test('Vega image free references and site survive rule presentation',()=>{
  const rule={relay_model_billing_version:1,provider_site:'domestic',free_units:3,unit_size:1}
  assert.match(priceRuleSummary(rule,'input_image'),/国内站.*前 3 张.*第 4 张/)
  assert.match(priceRuleSummary({...rule,provider_site:'international',free_units:0},'image'),/国际站（人民币）/)
})
