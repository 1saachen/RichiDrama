export const meterLabels = {
  request: '次调用', image: '张图片', input_image: '张输入图', second: '秒', millisecond: '毫秒',
  character: '个字符', input_token: '输入 Token', input_image_token: '图片输入 Token', cache_token: '缓存输入 Token', output_token: '输出 Token',
}
const chargeLabels = {
  InferencePrompt: '文字输入费', InferenceCompletion: '文字输出费',
  ImageGeneration: '图片生成费', InferenceImage: '图片生成费', Image: '图片生成费',
  SpeechSynthesis: '语音合成费', TTS: '语音合成费', Character: '语音合成费',
  VideoGenerationSecond: '视频生成费', Video: '视频生成费',
  I2ICompletion: '参考图生成', T2ICompletion: '文字生成图片',
  ToIPrompt: '参考图输入', ToICompletion: '单图 · ≤261 万像素', ToILargeCompletion: '单图 · >261 万像素',
  ToILayerCompletion: '图层拆分 · ≤261 万像素', ToILayerLargeCompletion: '图层拆分 · >261 万像素',
  ToVSilentCompletion: '无声视频', ToVCompletion: '有声视频',
  V2VCompletion: '有参考视频', NV2VCompletion: '无参考视频',
  V2V1080Completion: '有参考视频 · 1080p', NV2V1080Completion: '无参考视频 · 1080p',
  V2V4KCompletion: '有参考视频 · 4K', NV2V4KCompletion: '无参考视频 · 4K',
}
function quantity(value) { return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(Number(value)) }
export function billingUnitLabel(meter, size = 1) {
  const count = Number(size || 1)
  return `${count === 1000000 ? '100万' : count === 10000 ? '1万' : quantity(count)} ${meterLabels[meter] || '计量单位'}`
}
export function chargeItemLabel(row) {
  if (row.meter === 'input_image_token') return '图片输入费'
  if (row.meter === 'output_token' && ['image','storyboard_image'].includes(row.service_type)) return '图片输出费'
  if (row.mapping_status !== 'mapped') return row.charge_type === 'MissingFromProvider' ? '供应商未返回价格' : '计费规则待识别'
  if (row.meter === 'output_token' && row.service_type === 'video') return '视频生成费'
  if (chargeLabels[row.charge_type]) return chargeLabels[row.charge_type]
  return ({ input_token: '文字输入费', output_token: '文字输出费', cache_token: '缓存输入费', image: '图片生成费', input_image: '参考图输入费', character: '语音合成费', second: '视频生成费' })[row.meter] || '模型调用费'
}
export function conditionLabel(when = {}) {
  const labels = {
    has_video_input: value => value ? '有参考视频' : '无参考视频',
    has_image_input: value => value ? '有参考图片' : '无参考图片',
    has_audio: value => value ? '有声视频' : '无声视频',
    resolution: value => String(value).replace(/p$/i, 'p').replace(/k$/i, 'K'),
    pixel_band: value => value === 'small' ? '≤261 万像素' : '>261 万像素',
    image_scene: value => value === 'layer' ? '图层拆分' : '单图生成',
    resolution_tier: value => String(value).replace(/k$/i, 'K'),
    fps_tier: value => ({ lte30: '≤30 FPS', lte60: '≤60 FPS', lte120: '≤120 FPS' })[value] || '供应商帧率档位',
  }
  return Object.entries(when).map(([key, value]) => labels[key] ? labels[key](value) : '其他供应商条件').join(' · ') || '基础档位'
}
export function priceRuleSummary(value, meter) {
  if (!value) return '无附加条件'
  if (value.relay_model_billing_version === 1) return `${value.provider_site === 'international' ? '国际站（人民币） · ' : value.provider_site === 'domestic' ? '国内站 · ' : ''}${meter === 'input_image' && value.free_units === 3 ? '每次任务前 3 张参考图免费，第 4 张起按张结算' : `每 ${billingUnitLabel(meter,value.unit_size)}`}`
  if (value.relay_video_billing_version === 1 && meter === 'input_image' && value.provider_model === 'vega-1.0-lite') return '每次任务前 5 张参考图免费，第 6 张起按张结算'
  if (value.image_pricing_version === 'seedream-pro-v1' && value.free_units === 1) return '每次请求首张输入图免费，第 2 张起按张计费'
  if (value.usage_tiers?.length) return value.usage_tiers.map(tier => `${quantity(tier.min_inclusive)}–${quantity(tier.max_inclusive)} Token：${tier.unit_price_points} 积分 / ${billingUnitLabel(meter, tier.unit_size || value.unit_size)}`).join('\n')
  if (value.rates?.length) return (value.provider_site ? `${value.provider_site === 'international' ? '国际站（人民币）' : '国内站'}\n` : '') + value.rates.map(rate => `${conditionLabel(rate.when)}：${rate.unit_price_points} 积分 / ${billingUnitLabel(meter, rate.unit_size || value.unit_size)}`).join('\n')
  return `每 ${billingUnitLabel(meter, value.unit_size)}`
}
export function quantityPolicyLabel(value = {}, meter) {
  if (value.relay_video_billing_version !== 1) return ''
  if (meter === 'input_image') return '每次任务前 5 张参考图免费，第 6 张起收费。'
  if (meter !== 'second') return ''
  return value.provider_model === 'vega-1.0-lite'
    ? '按供应商返回的真实输出和参考视频输入秒数结算。'
    : '无参考视频只计输出时长；有参考视频时另计输入时长，输入至少按输出时长的三分之二计费。'
}
export function supplierPriceText(row) {
  if (row.provider_unit_price == null) return '—'
  const unit = String(row.unit_code && !/^unknown$/i.test(row.unit_code) ? row.unit_code : '待确认单位').replace(/tokens/ig, 'Token').replace(/CNY/ig, '元')
  return String(row.provider_unit_price).split(';').map(part => {
    const text = part.trim(); const separator = text.indexOf('=')
    if (separator < 0) return `${text} 元 / ${unit}`
    const key = text.slice(0, separator)
    const label = chargeLabels[key] || (/^≤\d+K$/.test(key) ? `输入量 ${key} Token` : '供应商价格档位')
    return `${label}：${text.slice(separator + 1)} 元 / ${unit}`
  }).join('\n')
}
