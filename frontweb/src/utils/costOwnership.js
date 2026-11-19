export const ownershipLabels = {
  all: '全部归属',
  external: '外部客户',
  internal: '内部漫剧',
  pending: '待确认',
}

export function billingAccountLabel(call) {
  if (call.organization_id) return call.organization_name || `客户 #${call.organization_id}`
  return call.customer_kind === 'personal' ? '个人账户' : '未知账户'
}

export function activityOwnership(call) {
  if (call.ops_scope === 'external' && call.ops_individual_id) {
    return call.ops_individual_name || `独立客户 #${call.ops_individual_id}`
  }
  if (call.ops_scope === 'external' && call.ops_customer_id) {
    return call.ops_customer_name || `客户 #${call.ops_customer_id}`
  }
  return ownershipLabels[call.ops_scope] || '待确认'
}
