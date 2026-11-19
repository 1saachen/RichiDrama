<template>
  <div class="usage-ownership-fields">
    <label class="usage-ownership-field">
      <span>消耗归属</span>
      <el-select :model-value="range.ops_scope" aria-label="消耗归属" fit-input-width popper-class="usage-ownership-options"
        :disabled="disabled" @change="changeScope">
        <el-option label="全部归属" value="all" />
        <el-option label="内部漫剧" value="internal" />
        <el-option label="外部客户合计" value="external" />
        <el-option label="待确认" value="pending" />
      </el-select>
    </label>

    <label v-if="range.ops_scope === 'external'" class="usage-ownership-field">
      <span>具体客户</span>
      <el-select :model-value="customerChoice" aria-label="具体客户" placeholder="全部外部客户" filterable clearable
        fit-input-width popper-class="usage-ownership-options" :disabled="disabled" @change="changeCustomer">
        <el-option label="全部外部客户" value="" />
        <el-option-group v-if="customers.length" label="共享客户">
          <el-option v-for="customer in customers" :key="customer.id" :label="customerLabel(customer, '客户账户')" :value="`customer:${customer.id}`" />
        </el-option-group>
        <el-option-group v-if="individualCustomers.length" label="独立客户">
          <el-option v-for="customer in individualCustomers" :key="customer.id" :label="customerLabel(customer, '独立账号')" :value="`individual:${customer.id}`" />
        </el-option-group>
        <el-option v-if="missingCustomerLabel" :label="missingCustomerLabel" :value="customerChoice" />
      </el-select>
    </label>

    <label v-if="showProjects" class="usage-ownership-field">
      <span>{{ projectFieldLabel }}</span>
      <el-select :model-value="range.drama_id || ''" :aria-label="projectFieldLabel" :placeholder="`全部${projectFieldLabel}`" filterable clearable
        fit-input-width popper-class="usage-ownership-options" :disabled="disabled || projectsLoading" :loading="projectsLoading"
        @change="emit('change', { drama_id: $event || '' })">
        <el-option :label="`全部${projectFieldLabel}`" value="" />
        <el-option v-for="project in projects" :key="project.id" :label="projectLabel(project)" :value="String(project.id)" />
        <el-option v-if="missingProjectLabel" :label="missingProjectLabel" :value="range.drama_id" />
      </el-select>
    </label>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { usageProjectOptionsScope } from '@/utils/operationsUsageQuery'

const props = defineProps({
  range: { type: Object, required: true },
  customers: { type: Array, default: () => [] },
  individualCustomers: { type: Array, default: () => [] },
  projects: { type: Array, default: () => [] },
  projectsLoading: Boolean,
  disabled: Boolean,
})
const emit = defineEmits(['change'])

const showProjects = computed(() => Boolean(usageProjectOptionsScope(props.range)))
const projectFieldLabel = computed(() => props.range.ops_scope === 'internal' ? '内部项目' : '客户项目')

const customerChoice = computed(() => {
  if (props.range.ops_customer_id) return `customer:${props.range.ops_customer_id}`
  return props.range.ops_individual_id ? `individual:${props.range.ops_individual_id}` : ''
})
const missingCustomerLabel = computed(() => {
  const { ops_customer_id, ops_individual_id } = props.range
  if (ops_customer_id && !props.customers.some(item => String(item.id) === ops_customer_id)) return `客户 #${ops_customer_id}`
  if (ops_individual_id && !props.individualCustomers.some(item => String(item.id) === ops_individual_id)) return `独立客户 #${ops_individual_id}`
  return ''
})
const missingProjectLabel = computed(() => {
  const id = props.range.drama_id
  if (id === '0') return '非项目用量'
  return id && !props.projects.some(item => String(item.id) === id) ? `项目 #${id}` : ''
})

function duplicateLabels(labels) {
  const seen = new Set()
  const duplicates = new Set()
  for (const label of labels) {
    if (seen.has(label)) duplicates.add(label)
    seen.add(label)
  }
  return duplicates
}

const duplicateProjectTitles = computed(() => duplicateLabels(props.projects.map(project => project.title)))
const duplicateCustomerNames = computed(() => duplicateLabels([
  ...props.customers.map(customer => customer.name),
  ...props.individualCustomers.map(customer => customer.name),
]))

function projectLabel({ id, title }) {
  if (!title) return `项目 #${id}`
  return duplicateProjectTitles.value.has(title) ? `#${id} · ${title}` : title
}

function customerLabel({ id, name }, kind) {
  if (!name) return `${kind} #${id}`
  return duplicateCustomerNames.value.has(name) ? `${kind} #${id} · ${name}` : name
}

function changeScope(scope) {
  emit('change', { ops_scope: scope, ops_customer_id: '', ops_individual_id: '', drama_id: '' })
}

function changeCustomer(choice) {
  const [kind, id] = (choice || '').split(':')
  emit('change', { ops_customer_id: kind === 'customer' ? id : '', ops_individual_id: kind === 'individual' ? id : '', drama_id: '' })
}
</script>

<style scoped>
.usage-ownership-fields { display: contents; }
.usage-ownership-field { display: grid; align-content: start; gap: 5px; min-width: 0; color: var(--text-secondary); font-size: .85rem; }
.usage-ownership-field .el-select { width: 100%; min-width: 0; }
:global(.usage-ownership-options .el-select-dropdown__item) {
  min-height: 34px;
  height: auto;
  padding-block: 6px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
</style>
