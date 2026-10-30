<template>
  <div class="price-items-editor">
    <p v-if="locked" class="editor-help">供应商计费方式和价格档位已固定，只能调整积分金额。更新计费规则请重新同步供应商价格。</p>
    <article v-for="(item, index) in items" :key="index" class="price-editor-item">
      <header><div><strong>{{ serviceLabel(item.service_type || serviceType) }}</strong><small v-if="showIdentity">{{ item.model }}</small></div><el-button v-if="!locked" link type="danger" @click="items.splice(index, 1)">删除</el-button></header>
      <div v-if="!locked" class="price-editor-fields">
        <label v-if="showIdentity">服务类型<el-select v-model="item.service_type" aria-label="服务类型"><el-option v-for="(name, type) in services" :key="type" :label="name" :value="type" /></el-select></label>
        <label v-if="showIdentity">模型<el-input v-model="item.model" aria-label="模型" /></label>
        <label>计量单位<el-select v-model="item.meter" aria-label="计量单位"><el-option v-for="(name, meter) in meterLabels" :key="meter" :label="name" :value="meter" /></el-select></label>
        <label>单位数量<el-input-number v-model="item.unit_size" :min="1" :step="1" :precision="0" controls-position="right" aria-label="计价单位数量" /></label>
      </div>
      <p class="editor-unit">每 {{ billingUnitLabel(item.meter, item.unit_size || conditions(item).unit_size) }}</p>
      <p v-if="quantityPolicyLabel(conditions(item), item.meter)" class="editor-help">{{ quantityPolicyLabel(conditions(item), item.meter) }}</p>
      <div class="price-editor-fields"><label>{{ conditions(item).rates?.length || conditions(item).usage_tiers?.length ? '基础单价（积分）' : '单价（积分）' }}<el-input-number v-model="item.unit_price" :min="0" :precision="4" :disabled="item.is_free" controls-position="right" aria-label="单价（积分）" /></label><el-checkbox v-model="item.is_free">免费</el-checkbox></div>
      <div v-for="rate in conditions(item).rates || []" :key="rate.id" class="price-editor-rate"><div><span>{{ conditionLabel(rate.when) }}</span><small>每 {{ billingUnitLabel(item.meter, rate.unit_size || item.unit_size || conditions(item).unit_size) }}</small></div><el-input-number v-model="rate.unit_price_points" :min="0" :precision="4" controls-position="right" :aria-label="`${conditionLabel(rate.when)}单价（积分）`" /></div>
      <div v-for="tier in conditions(item).usage_tiers || []" :key="tier.id" class="price-editor-rate"><div><span>{{ tier.min_inclusive }}–{{ tier.max_inclusive }} Token</span><small>每 {{ billingUnitLabel(item.meter, tier.unit_size || item.unit_size || conditions(item).unit_size) }}</small></div><el-input-number v-model="tier.unit_price_points" :min="0" :precision="4" controls-position="right" aria-label="用量档位单价（积分）" /></div>
      <small v-if="conditions(item).provider_site">{{ conditions(item).provider_site === 'international' ? '国际站价格（已折算人民币）' : '国内站价格' }}</small>
    </article>
  </div>
</template>

<script setup>
import { serviceLabel } from '@/utils/billingPresentation'
import { billingUnitLabel, conditionLabel, meterLabels, quantityPolicyLabel } from '@/utils/providerPricePresentation'
defineProps({ items: { type: Array, required: true }, locked: Boolean, showIdentity: { type: Boolean, default: true }, serviceType: { type: String, default: '' } })
const services = { text: '文本生成', image: '图片生成', storyboard_image: '分镜图片', video: '视频生成', video_postprocess: '视频后处理', tts: '语音合成' }
function conditions(item) {
  if (!item.conditions_json) return {};
  if (typeof item.conditions_json === 'string') item.conditions_json = JSON.parse(item.conditions_json);
  for (const row of [...(item.conditions_json.rates || []), ...(item.conditions_json.usage_tiers || [])]) {
    if (typeof row.unit_price_points === 'string') row.unit_price_points = Number(row.unit_price_points);
  }
  return item.conditions_json;
}
</script>

<style scoped>
.price-items-editor{display:grid;gap:1rem;margin:1rem 0}.editor-help{color:var(--text-muted);line-height:1.6}.price-editor-item{min-width:0;border:1px solid var(--el-border-color);border-radius:10px;padding:1rem}.price-editor-item header{display:flex;justify-content:space-between;gap:1rem;align-items:start}.price-editor-item small{display:block;margin-top:.35rem;color:var(--text-muted);overflow-wrap:anywhere}.price-editor-item header div{min-width:0;overflow-wrap:anywhere}.price-editor-fields{display:flex;flex-wrap:wrap;gap:1rem;align-items:end;margin:.8rem 0}.price-editor-fields label{display:grid;gap:.5rem;flex:1;min-width:140px;font-size:13px}.price-editor-fields .el-input-number,.price-editor-fields .el-select{width:100%}.editor-unit{font-size:13px;color:var(--text-muted)}.price-editor-rate{display:flex;justify-content:space-between;align-items:center;gap:1rem;border-top:1px solid var(--el-border-color);padding:.8rem 0}.price-editor-rate>div:first-child{min-width:0;overflow-wrap:anywhere}.price-editor-rate>.el-input-number{flex:0 0 150px}@media(max-width:500px){.price-editor-rate{align-items:stretch;flex-direction:column}.price-editor-rate>.el-input-number{flex:auto;width:100%}.price-editor-fields label{flex-basis:100%}}
</style>
