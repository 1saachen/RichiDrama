<template>
  <div ref="dateRange" class="usage-date-range" role="group" :aria-labelledby="labelId" :aria-describedby="dateError ? errorId : undefined"
    @input.capture="recordTypedDate" @change.capture="stopPickerTextChange"
    @keydown.enter.capture="submitTypedDates" @focusout.capture="submitTypedDates">
    <span :id="labelId" class="usage-date-range__label">日期范围</span>
    <label class="sr-only" :for="inputIds[0]">开始日期</label>
    <label class="sr-only" :for="inputIds[1]">结束日期</label>
    <el-date-picker
      ref="picker"
      :id="inputIds"
      v-model="pickerValue"
      type="daterange"
      value-format="YYYY-MM-DD"
      range-separator="至"
      :start-placeholder="dateFrom || (dateTo ? '开始不限' : '开始日期')"
      :end-placeholder="dateTo || (dateFrom ? '结束不限' : '结束日期')"
      :default-value="calendarAnchor"
      :disabled="disabled"
      :show-confirm="false"
      single-panel
      popper-class="usage-date-range-popper"
      :popper-options="popperOptions"
      @change="commitRange"
      @calendar-change="useCalendar"
      @keydown.esc="restoreRange"
    />
    <p v-if="dateError" :id="errorId" class="usage-date-range__error" role="alert">{{ dateError }}</p>
  </div>
</template>

<script setup>
import { computed, ref, useId, watch } from 'vue'
import { calendarDate } from '@/utils/operationsUsageQuery'

const props = defineProps({
  dateFrom: { type: String, default: '' },
  dateTo: { type: String, default: '' },
  disabled: Boolean,
})
const emit = defineEmits(['change'])

const labelId = useId()
const inputIds = [`${labelId}-start`, `${labelId}-end`]
const errorId = `${labelId}-error`
const dateRange = ref(null)
const picker = ref(null)
const pickerValue = ref(null)
const dateError = ref('')
const typedDates = [null, null]
const calendarAnchor = computed(() => {
  const bound = props.dateFrom || props.dateTo
  return calendarDate(bound) ? new Date(`${bound}T12:00:00`) : undefined
})
const popperOptions = {
  modifiers: [{ name: 'preventOverflow', options: { padding: 8, altAxis: true } }],
}

function recordTypedDate(event) {
  const index = inputIds.indexOf(event.target.id)
  if (index < 0) return
  // Element Plus normalizes impossible dates before it emits a new model value.
  event.stopPropagation()
  typedDates[index] = event.target.value
  dateError.value = ''
}

function stopPickerTextChange(event) {
  if (inputIds.includes(event.target.id)) event.stopPropagation()
}

function resetInputs() {
  dateRange.value?.querySelectorAll('.el-range-input').forEach((input, index) => {
    input.value = pickerValue.value?.[index] || ''
  })
}

function submitTypedDates(event) {
  if (!inputIds.includes(event.target.id) || typedDates.every(value => value === null) || event.isComposing) return
  if (event.type === 'focusout' && (dateRange.value.contains(event.relatedTarget) || event.relatedTarget?.closest?.('.usage-date-range-popper'))) return

  const date_from = typedDates[0] ?? props.dateFrom
  const date_to = typedDates[1] ?? props.dateTo
  clearTyping()
  if (date_from || date_to) {
    if (!date_from || !date_to) dateError.value = '请输入完整的开始和结束日期。'
    else if (!calendarDate(date_from) || !calendarDate(date_to)) dateError.value = '请输入有效日期，格式为 YYYY-MM-DD。'
    else if (date_from > date_to) dateError.value = '结束日期不能早于开始日期。'
  }

  if (!dateError.value) commitRange(date_from && date_to ? [date_from, date_to] : null)
  resetInputs()
  if (event.type === 'keydown') {
    event.preventDefault()
    event.stopPropagation()
    picker.value?.handleClose()
  }
}

function clearTyping() {
  typedDates.fill(null)
  dateError.value = ''
}

function useCalendar() {
  if (!dateError.value && typedDates.every(value => value === null)) return
  clearTyping()
  resetInputs()
}

function restoreRange() {
  clearTyping()
  pickerValue.value = props.dateFrom && props.dateTo ? [props.dateFrom, props.dateTo] : null
  resetInputs()
}

function commitRange(value) {
  if (props.disabled) {
    restoreRange()
    return
  }
  if (value == null || value === '') {
    clearTyping()
    if (props.dateFrom && props.dateTo) emit('change', { date_from: '', date_to: '' })
    return
  }
  if (!Array.isArray(value) || value.length !== 2) return
  const [date_from, date_to] = value
  if (!calendarDate(date_from) || !calendarDate(date_to) || date_from > date_to) return
  clearTyping()
  if (date_from !== props.dateFrom || date_to !== props.dateTo) emit('change', { date_from, date_to })
}

watch(() => [props.dateFrom, props.dateTo], restoreRange, { immediate: true })
</script>

<style scoped>
.usage-date-range {
  display: grid;
  align-content: start;
  gap: 5px;
  min-width: 0;
}

.usage-date-range__label {
  color: var(--text-secondary);
  font-size: .85rem;
}

.usage-date-range__error {
  margin: 0;
  color: var(--status-danger);
  font-size: .85rem;
}

.usage-date-range :deep(.el-date-editor) {
  width: 100%;
  min-width: 0;
}

.usage-date-range :deep(.el-range-input) {
  min-width: 0;
}

:global(.usage-date-range-popper) {
  box-sizing: border-box;
  width: min(324px, calc(100vw - 24px));
}

:global(.usage-date-range-popper .el-date-range-picker.single-panel) {
  --el-datepicker-inrange-bg-color: var(--el-color-primary-light-9);
  --el-datepicker-inrange-hover-bg-color: var(--bg-active);
  --el-datepicker-active-color: var(--action-bg);
  width: 100%;
  max-height: calc(100vh - 24px);
  max-height: calc(100dvh - 24px);
  overflow: auto;
}

:global(.usage-date-range-popper .el-date-range-picker.single-panel .el-picker-panel__body) {
  min-width: 0;
}

:global(.usage-date-range-popper .el-date-range-picker.single-panel .el-picker-panel__content) {
  width: auto;
  margin: clamp(6px, 3.5vw, 15px);
}
</style>
