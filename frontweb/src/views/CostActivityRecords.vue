<template>
  <table class="cost-activity-records">
    <thead>
      <tr>
        <th>时间 / 状态</th><th>归属 / 项目</th><th>执行用户 / 模型</th><th>实际用量</th>
        <th>供应商成本估算</th><th>已扣积分</th><th>操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="call in items" :key="call.id">
        <td>{{ chinaTime(call.occurred_at) }}<small>{{ timeBasis[call.time_basis] }} · {{ statuses[call.status] || call.status }}</small></td>
        <td>
          {{ call.ops_scope ? activityOwnership(call) : billingAccountLabel(call) }}
          <small>{{ call.project_title || '非项目操作' }}</small>
          <small>{{ sourceKindLabel(call.source_kind) }} · {{ serviceTypeLabel(call.service_type) }}</small>
        </td>
        <td>{{ call.executor_display_name || call.executor_username || call.user_name || '未知用户' }}<small>{{ call.model }}</small></td>
        <td class="usage-cell">{{ usageText(call.usage) }}</td>
        <td>{{ costMoney(call.supplier_amount_micro) }}<small>{{ call.reason }}</small></td>
        <td>{{ chargedCredits(call) }}</td>
        <td><button @click="emit('inspect', call.id, $event)">查看依据</button></td>
      </tr>
    </tbody>
  </table>
</template>

<script setup>
import { chinaTime, costMoney, serviceTypeLabel, sourceKindLabel, usageText } from '@/utils/costPresentation'
import { activityOwnership, billingAccountLabel } from '@/utils/costOwnership'

defineProps({ items: { type: Array, required: true } })
const emit = defineEmits(['inspect'])
const statuses = {
  settled: '已结算', processing: '处理中', released: '已释放', reconciliation: '待对账',
  completed: '已完成', failed: '失败', unknown: '结果不明',
}
const timeBasis = { settlement: '结算时间', authorization: '预授权时间', supplier_submission: '提交时间' }

function chargedCredits(call) {
  if (call.charged_micro == null) return call.status === 'released' ? '已释放' : '未结算'
  return (call.charged_micro / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 4 })
}
</script>
