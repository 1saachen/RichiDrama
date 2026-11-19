const usageScopes = new Set(['all', 'internal', 'external', 'pending'])
const operationsCalendar = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })

function queryId(value, allowZero = false) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) return ''
  const id = Number(value)
  return Number.isSafeInteger(id) && id >= (allowZero ? 0 : 1) ? String(id) : ''
}

export function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return ''
  const time = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 10) === value ? value : ''
}

export function defaultUsageDates(now = new Date()) {
  const date_to = operationsCalendar.format(now)
  return { date_from: `${date_to.slice(0, 7)}-01`, date_to }
}

function operationsScope(query) {
  let ops_scope = usageScopes.has(query.ops_scope) ? query.ops_scope : 'all'
  let ops_customer_id = queryId(query.ops_customer_id)
  let ops_individual_id = ops_customer_id ? '' : queryId(query.ops_individual_id)
  if (ops_scope === 'internal' || ops_scope === 'pending') {
    ops_customer_id = ''
    ops_individual_id = ''
  } else if (ops_customer_id || ops_individual_id) ops_scope = 'external'
  return { ops_scope, ops_customer_id, ops_individual_id, drama_id: queryId(query.drama_id, true) }
}

export function readUsageRange(query = {}, now) {
  const date_from = calendarDate(query.date_from)
  const date_to = calendarDate(query.date_to)
  const dates = date_from || date_to || String(query.all_dates) === '1'
    ? { date_from, date_to: date_from && date_to && date_from > date_to ? '' : date_to }
    : defaultUsageDates(now)
  return { ...operationsScope(query), ...dates }
}

export function usageRangeParams(range = {}) {
  const { ops_scope, ops_customer_id, ops_individual_id, drama_id } = operationsScope(range)
  const date_from = calendarDate(range.date_from)
  const date_to = calendarDate(range.date_to)
  return {
    ops_scope,
    ...(ops_customer_id ? { ops_customer_id } : {}),
    ...(ops_individual_id ? { ops_individual_id } : {}),
    ...(drama_id ? { drama_id } : {}),
    ...(date_from ? { date_from } : {}),
    ...(date_to ? { date_to } : {}),
  }
}

export function usageRangeQuery(range) {
  const params = usageRangeParams(range)
  return params.date_from || params.date_to ? params : { ...params, all_dates: '1' }
}

export function usageProjectOptionsScope(range) {
  const { ops_scope, ops_customer_id, ops_individual_id } = operationsScope(range)
  if (ops_scope === 'internal') return { ops_scope }
  if (ops_scope !== 'external') return null
  if (ops_customer_id) return { ops_scope, ops_customer_id }
  return ops_individual_id ? { ops_scope, ops_individual_id } : null
}

export function usageDateLabel({ date_from, date_to }) {
  if (date_from && date_to) return `${date_from} 至 ${date_to}`
  if (date_from) return `${date_from} 起`
  return date_to ? `截至 ${date_to}` : '全部日期'
}
