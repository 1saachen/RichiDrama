import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultUsageDates, readUsageRange, usageDateLabel, usageProjectOptionsScope, usageRangeParams, usageRangeQuery,
} from '../src/utils/operationsUsageQuery.js'

test('a new usage query starts in the current Beijing calendar month', () => {
  const now = new Date('2026-10-31T16:01:00.000Z')
  assert.deepEqual(defaultUsageDates(now), { date_from: '2026-11-01', date_to: '2026-11-01' })
  assert.equal(readUsageRange({}, now).date_to, '2026-11-01')
})

test('query links preserve specific customers, selected projects and one-sided dates', () => {
  const range = readUsageRange({ ops_individual_id: '84', drama_id: '12', date_to: '2026-11-18' })
  assert.deepEqual(usageRangeQuery(range), {
    ops_scope: 'external', ops_individual_id: '84', drama_id: '12', date_to: '2026-11-18',
  })
  assert.deepEqual(readUsageRange(usageRangeQuery(range)), range)
  assert.equal(usageDateLabel(range), '截至 2026-11-18')
})

test('an explicit all-dates link is distinct from a default query and keeps legacy non-project links', () => {
  const range = readUsageRange({ ops_scope: 'internal', all_dates: '1', drama_id: '0' })
  assert.equal(usageDateLabel(range), '全部日期')
  assert.deepEqual(usageRangeQuery(range), { ops_scope: 'internal', drama_id: '0', all_dates: '1' })
  assert.deepEqual(usageRangeParams(range), { ops_scope: 'internal', drama_id: '0' })
  assert.deepEqual(readUsageRange(usageRangeQuery(range)), range)
})

test('project choices are limited to internal or a specific external customer, independently of dates', () => {
  const filters = { date_from: '2026-11-01', drama_id: '9' }
  assert.deepEqual(usageProjectOptionsScope({ ...filters, ops_scope: 'internal' }), { ops_scope: 'internal' })
  assert.deepEqual(usageProjectOptionsScope({ ...filters, ops_customer_id: '14' }), { ops_scope: 'external', ops_customer_id: '14' })
  assert.deepEqual(usageProjectOptionsScope({ ...filters, ops_individual_id: '83' }), { ops_scope: 'external', ops_individual_id: '83' })
  assert.equal(usageProjectOptionsScope({ ...filters, ops_scope: 'external' }), null)
})
