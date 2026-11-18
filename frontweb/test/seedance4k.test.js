import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

function mountLogic(file, props, extra = {}, expose = '') {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8').split('<script setup>')[1].split('</script>')[0]
    .replace(/^import [^\n]*\n/gm, '')
  const emitted = []
  const context = vm.createContext({
    ref: value => ({ value }), computed: get => ({ get value() { return get() } }),
    defineProps: () => props, defineEmits: () => (...args) => emitted.push(args),
    watch() {}, onMounted() {}, onBeforeUnmount() {}, defineExpose() {},
    setInterval: () => 1, setTimeout: () => 1, clearTimeout() {}, clearInterval() {},
    window: { dispatchEvent() {} }, CustomEvent: class {},
    ...extra,
  })
  vm.runInContext(`${source}\nglobalThis.harness = { ${expose} };`, context)
  return { ...context.harness, emitted }
}

test('4K is selectable only when advertised, and switching to Flash drops it safely', () => {
  const props = { modelValue: { video_model: 'regular', duration: 30, resolution: '720p', upscale_resolution: '1080p' }, maxDuration: 60 }
  const ui = mountLogic('../src/components/GenerationSettings.vue', props, {}, 'videoModels, resolutionOptions, set')
  ui.videoModels.value = [
    { model: 'regular', limits: { duration: { max: 30 }, resolutions: ['480p', '720p', '1080p', '4k'] } },
    { model: 'flash', limits: { duration: { max: 30 }, resolutions: ['480p', '720p'] } },
    { model: 'legacy', limits: {} },
  ]
  assert.equal(ui.resolutionOptions.value.at(-1).value, '4k')
  ui.set('resolution', '4k')
  props.modelValue = ui.emitted.at(-1)[1]
  assert.equal(props.modelValue.upscale_resolution, null)
  ui.set('video_model', 'flash')
  props.modelValue = ui.emitted.at(-1)[1]
  assert.equal(props.modelValue.resolution, '720p')
  assert.equal(ui.resolutionOptions.value.some(x => x.value === '4k'), false)
  props.modelValue = { ...props.modelValue, video_model: 'legacy' }
  assert.equal(ui.resolutionOptions.value.some(x => x.value === '4k'), false)
})

test('4K generation quotes use the selected aspect ratio', async () => {
  const calls = []
  let scheduled
  const ui = mountLogic('../src/components/GenerationSettings.vue', {
    modelValue: { video_model: 'doubao-seedance-2-5-260628', resolution: '4k', aspect_ratio: '4:3', duration: 5 },
    includeGenerationQuote: true, maxDuration: 60, hasVideoInput: false, hasAudioInput: false,
  }, {
    setTimeout(fn) { scheduled = fn; return 1 },
    omniVideoAPI: { async quoteBilling(input) { calls.push(input); return { amount: 3465.47 } } },
  }, 'scheduleQuote')
  ui.scheduleQuote()
  await scheduled()
  assert.equal(calls[0].aspect_ratio, '4:3')
  assert.equal(calls[0].resolution, '4k')
})

test('Draft promotion quotes and submits the same selected resolution; cancelling never submits', async () => {
  const calls = [], messages = []
  let confirm = true
  const ui = mountLogic('../src/components/SeedanceDraftPanel.vue', { shotId: 1 }, {
    videosAPI: {
      async draftFinalQuote(id, options) { calls.push(['quote', id, options.resolution]); return { amount: 2772.33 } },
      async finalizeDraft(id, options) { calls.push(['finalize', id, options.resolution]) },
      async drafts() { return [] },
    },
    ElMessage: { success() {}, error() {} },
    ElMessageBox: { async confirm(message) { messages.push(message); if (!confirm) throw 'cancel' } },
  }, 'finalResolutions, finalize')
  await ui.finalize({ id: 1 })
  assert.deepEqual(calls.slice(0, 2), [['quote', 1, '1080p'], ['finalize', 1, '1080p']])
  ui.finalResolutions.value[2] = '4k'
  await ui.finalize({ id: 2 })
  assert.deepEqual(calls.slice(2, 4), [['quote', 2, '4k'], ['finalize', 2, '4k']])
  assert.match(messages.at(-1), /4K.*2772.33/)
  confirm = false
  ui.finalResolutions.value[3] = '4k'
  await ui.finalize({ id: 3 })
  assert.deepEqual(calls.at(-1), ['quote', 3, '4k'])
  assert.equal(calls.some(x => x[0] === 'finalize' && x[1] === 3), false)
})
