<template>
  <main class="upscale">
    <header class="page-heading">
      <RouterLink to="/ai-tools" class="back-link">← AI 工具箱</RouterLink>
      <h1>视频超分</h1>
      <p>上传已有视频，提升分辨率，保留原画幅和帧率。</p>
    </header>

    <div class="workbench">
      <section class="preview" aria-labelledby="preview-heading">
        <header>
          <h2 id="preview-heading">视频预览</h2>
          <div v-if="selected?.status === 'completed'" class="preview-tabs" aria-label="选择预览视频">
            <button v-for="(label, kind) in { source: '原片', result: '成片' }" :key="kind" type="button"
              :aria-pressed="previewKind === kind" @click="previewKind = kind">{{ label }}</button>
          </div>
        </header>
        <div class="screen">
          <video v-if="selected" :key="previewUrl" :src="previewUrl" :aria-label="previewKind === 'source' ? '原片预览' : '成片预览'"
            controls playsinline preload="metadata" />
          <div v-else class="empty-preview">
            <el-icon :size="32" aria-hidden="true"><VideoCamera /></el-icon>
            <button class="button primary" type="button" :disabled="uploading" @click="fileInput?.click()">
              {{ uploading ? '正在上传…' : '选择视频' }}
            </button>
            <p>MP4 或 MOV，最大 30 MB</p>
          </div>
        </div>
        <div v-if="selected" class="media-info">
          <strong>{{ selected.name }}</strong>
          <span>{{ mediaLabel(previewMedia) }}</span>
        </div>
      </section>

      <section class="controls" aria-labelledby="controls-heading">
        <h2 id="controls-heading">超分设置</h2>
        <input ref="fileInput" type="file" accept=".mp4,.mov,video/mp4,video/quicktime" hidden @change="uploadVideo">
        <button v-if="selected" class="button" type="button" :disabled="uploading || submitting" @click="fileInput?.click()">
          {{ uploading ? '正在上传…' : '导入新视频' }}
        </button>
        <p v-if="uploading" role="status">{{ uploadStatus }}</p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-if="!selected && !uploading">选择视频后即可查看规格和积分报价。</p>

        <form v-if="selected?.status === 'ready'" class="settings" @submit.prevent="startUpscale">
          <fieldset :disabled="submitting || uploading">
            <legend>目标分辨率</legend>
            <div class="target-options">
              <label v-for="option in selected.targets" :key="option">
                <input v-model="target" type="radio" name="resolution" :value="option">
                {{ option }}
              </label>
            </div>
          </fieldset>
          <div class="price" aria-live="polite">
            <span>预计积分</span>
            <strong>{{ estimate ? formatCredits(estimate.amount) : '—' }}</strong>
          </div>
          <p v-if="quoting" role="status">正在获取报价…</p>
          <template v-else-if="quoteError">
            <p class="error" role="alert">{{ quoteError }}</p>
            <button class="button" type="button" @click="loadQuote">重新报价</button>
          </template>
          <p v-else>按成片时长结算。确认后会将视频发送至火山 MediaKit 处理。</p>
          <button class="button primary" type="submit" :disabled="!estimate || submitting || uploading || quoting">
            {{ submitting ? '正在提交…' : '确认并开始超分' }}
          </button>
        </form>

        <div v-else-if="selected" class="task-state" aria-live="polite">
          <div class="price"><span>目标分辨率</span><strong>{{ selected.target_resolution }}</strong></div>
          <p>{{ statusLabel(selected.status) }}</p>
          <p v-if="selected.error">{{ selected.error }}</p>
          <p v-else-if="isActive(selected)">可以离开此页，处理结果会保存到超分记录。</p>
          <a v-if="selected.status === 'completed'" class="button primary" :href="downloadUrl">下载 MP4</a>
        </div>
      </section>
    </div>

    <section class="history" aria-labelledby="history-heading">
      <header>
        <h2 id="history-heading">超分记录</h2>
        <button type="button" class="button" :disabled="refreshing" @click="refresh">刷新记录</button>
      </header>
      <p v-if="historyError" class="error" role="alert">{{ historyError }}</p>
      <p v-else-if="!records.length">{{ refreshing ? '正在读取记录…' : '暂无超分记录' }}</p>
      <ul v-else>
        <li v-for="job in records" :key="job.id">
          <button type="button" :aria-pressed="selected?.id === job.id" :disabled="submitting" @click="selectJob(job)">
            <span class="history-title"><strong>{{ job.name }}</strong><small>{{ formatChinaDateTime(job.created_at, '') }}</small></span>
            <span class="history-resolution">{{ job.target_resolution || '—' }}</span>
            <span class="status" :data-status="job.status">{{ statusLabel(job.status) }}</span>
          </button>
        </li>
      </ul>
      <footer v-if="pageAnchors.length > 1 || nextPage">
        <button class="button" type="button" :disabled="refreshing || pageAnchors.length === 1" @click="previous">上一页</button>
        <button class="button" type="button" :disabled="refreshing || !nextPage" @click="next">下一页</button>
      </footer>
    </section>
  </main>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VideoCamera } from '@element-plus/icons-vue'
import { videoUpscales } from '@/api/videoUpscales'
import { formatCredits } from '@/utils/billingPresentation'
import { formatChinaDateTime } from '@/utils/time'

const route = useRoute()
const router = useRouter()
const fileInput = ref(null)
const selected = ref(null)
const target = ref('')
const previewKind = ref('source')
const estimate = ref(null)
const quoteError = ref('')
const error = ref('')
const uploading = ref(false)
const uploadStatus = ref('')
const quoting = ref(false)
const submitting = ref(false)
const records = ref([])
const pageAnchors = ref([null])
const nextPage = ref(null)
const refreshing = ref(false)
const historyError = ref('')
let pollTimer
let quoteSequence = 0

const previewUrl = computed(() => selected.value && videoUpscales.media(selected.value.id, previewKind.value))
const previewMedia = computed(() => previewKind.value === 'source' ? selected.value?.source : selected.value?.output)
const downloadUrl = computed(() => selected.value && `${videoUpscales.media(selected.value.id, 'result')}?download=1`)
const isActive = (job) => ['queued', 'submitting', 'processing', 'reconciliation'].includes(job?.status)
const statusLabel = (status) => ({
  ready: '待确认', queued: '排队中', submitting: '正在提交', processing: '超分处理中',
  completed: '已完成', failed: '处理失败', reconciliation: '待对账',
})[status] || status

function mediaLabel(media) {
  if (!media) return ''
  const fps = Number(media.fps.toFixed(2))
  const seconds = Number((media.duration_ms / 1000).toFixed(2))
  return `${media.width} × ${media.height} · ${fps} fps · ${seconds} 秒`
}

function selectJob(job) {
  selected.value = job
  previewKind.value = job.status === 'completed' ? 'result' : 'source'
  target.value = job.status === 'ready' ? job.targets.at(-1) : ''
  error.value = ''
  if (route.query.job !== job.id) router.replace({ query: { ...route.query, job: job.id } })
}

async function uploadVideo(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  error.value = ''
  if (!/\.(mp4|mov)$/i.test(file.name) || file.size > 30 * 1024 * 1024) {
    error.value = '请选择 30 MB 以内的 MP4 或 MOV 视频'
    return
  }
  uploading.value = true
  uploadStatus.value = '正在上传视频…'
  try {
    const job = await videoUpscales.upload(file, ({ progress }) => {
      uploadStatus.value = progress >= 1 ? '正在检测视频规格…' : `正在上传 ${Math.round((progress || 0) * 100)}%`
    })
    selectJob(job)
    pageAnchors.value = [null]
    await refresh()
  } catch (err) { error.value = err.message }
  finally { uploading.value = false }
}

async function loadQuote() {
  const sequence = ++quoteSequence
  const job = selected.value
  const resolution = target.value
  estimate.value = null
  quoteError.value = ''
  quoting.value = !!(job?.status === 'ready' && resolution)
  if (!quoting.value) return
  try {
    const quote = await videoUpscales.quote(job.id, resolution)
    if (sequence === quoteSequence) estimate.value = quote
  } catch (err) {
    if (sequence === quoteSequence) quoteError.value = err.message
  } finally {
    if (sequence === quoteSequence) quoting.value = false
  }
}
watch([() => selected.value?.id, () => selected.value?.status, target], loadQuote)

async function startUpscale() {
  if (!estimate.value || submitting.value || uploading.value) return
  submitting.value = true
  error.value = ''
  try {
    selected.value = await videoUpscales.submit(selected.value.id, target.value, estimate.value.amount_micro)
    await refresh()
  } catch (err) {
    error.value = err.message
    await refresh()
    await loadQuote()
  } finally { submitting.value = false }
}

async function refresh() {
  if (refreshing.value) return
  refreshing.value = true
  historyError.value = ''
  try {
    const { items, next } = await videoUpscales.list(pageAnchors.value.at(-1))
    records.value = items
    nextPage.value = next
    const id = selected.value?.id || route.query.job
    if (!id) return
    const current = items.find((job) => job.id === id) || await videoUpscales.get(id)
    if (!selected.value) selectJob(current)
    else if (selected.value.id === id) {
      if (selected.value.status !== 'ready' && current.status === 'ready') return
      if (selected.value.status !== 'completed' && current.status === 'completed') previewKind.value = 'result'
      selected.value = current
    }
  } catch (err) { historyError.value = err.message }
  finally { refreshing.value = false }
}

function previous() {
  pageAnchors.value.pop()
  refresh()
}
function next() {
  pageAnchors.value.push(nextPage.value)
  refresh()
}

onMounted(() => {
  refresh()
  pollTimer = window.setInterval(() => {
    if (!submitting.value && !uploading.value && (isActive(selected.value) || records.value.some(isActive))) refresh()
  }, 4000)
})
onUnmounted(() => window.clearInterval(pollTimer))
</script>

<style scoped>
.upscale {
  width: min(100%, 1380px);
  margin: auto;
  padding: clamp(24px, 4vw, 56px) clamp(16px, 4vw, 56px);
  color: var(--text-primary);
}
.page-heading { margin-bottom: 26px; }
.page-heading h1 { margin: 16px 0 8px; font-size: clamp(32px, 4vw, 50px); line-height: 1.1; }
.page-heading p, .controls p, .history > p { margin: 0; color: var(--text-muted); line-height: 1.6; }
.back-link { color: var(--text-muted); font-weight: 600; text-decoration: none; }
.back-link:hover { color: var(--text-primary); text-decoration: underline; }
.workbench { display: grid; grid-template-columns: minmax(0, 1.85fr) minmax(270px, 1fr); gap: 20px; align-items: start; }
.preview, .controls, .history { border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--bg-surface); }
.preview { min-width: 0; padding: 16px; }
.preview header, .history header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
h2 { margin: 0; font-size: 1.15rem; line-height: 1.4; }
.screen {
  display: grid;
  place-items: center;
  aspect-ratio: 16 / 9;
  min-height: 190px;
  overflow: hidden;
  border-radius: 8px;
  background: #10151d;
}
.screen video { display: block; width: 100%; height: 100%; min-height: 0; object-fit: contain; }
.empty-preview { display: grid; justify-items: center; gap: 12px; padding: 16px; color: #e6e9ef; }
.empty-preview p { margin: 0; font-size: .85rem; }
.media-info { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 16px; padding: 14px 0 0; overflow-wrap: anywhere; }
.media-info span, .history-title small, .history-resolution { color: var(--text-muted); }
.controls, .history { padding: clamp(16px, 2vw, 24px); }
.controls, .settings, .task-state { display: grid; gap: 12px; }
.controls > .button, .task-state > .button { justify-self: start; }
.settings fieldset { min-width: 0; padding: 0; border: 0; margin: 0; }
.settings legend { margin: 0 0 8px; padding: 0; }
.target-options, .preview-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.target-options label { display: inline-flex; align-items: center; gap: 5px; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px; cursor: pointer; }
.target-options label:has(input:checked), .preview-tabs button[aria-pressed=true] { border-color: var(--accent); background: var(--bg-active); }
.price { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border-subtle); }
.price strong, .history-resolution { font-variant-numeric: tabular-nums; }
.button, .preview-tabs button {
  min-height: 36px;
  padding: 7px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-primary);
  font: inherit;
  text-decoration: none;
  cursor: pointer;
}
.button:hover:not(:disabled), .preview-tabs button:hover { border-color: var(--accent); }
.button:disabled { opacity: .6; cursor: default; }
.button.primary { background: #5143ad; border-color: #5143ad; color: #fff; font-weight: 600; }
.button.primary:hover:not(:disabled) { background: #45359c; }
.error, .controls p.error, .history p.error { color: var(--status-danger, #ad293e); }
.history { margin-top: 20px; }
.history ul { list-style: none; margin: 0; padding: 0; }
.history li button {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px 20px;
  width: 100%;
  padding: 12px 6px;
  border: 0;
  border-top: 1px solid var(--border-subtle);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.history li button:hover, .history li button[aria-pressed=true] { background: var(--bg-hover); }
.history-title { display: grid; gap: 4px; overflow-wrap: anywhere; }
.status { justify-self: end; font-size: .9rem; }
.status[data-status=completed] { color: var(--status-success, #17734a); }
.status[data-status=failed] { color: var(--status-danger, #ad293e); }
.history footer { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
@media (max-width: 760px) {
  .workbench { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .history li button { column-gap: 8px; }
}
</style>
