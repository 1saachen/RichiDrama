<template>
  <main class="audio-tool">
    <header class="workbench-header">
      <div>
        <RouterLink class="back-link" to="/ai-tools">← AI 工具箱</RouterLink>
        <div class="tool-title">
          <span class="title-icon" aria-hidden="true"><el-icon><Headset /></el-icon></span>
          <h1>音频生成</h1>
        </div>
      </div>
      <AccountBalanceBadge />
    </header>

    <section v-if="!config?.available" class="access-state" aria-live="polite">
      <p>{{ loadingConfig ? '正在读取音频生成设置…' : (configError || '当前环境或账号未开放音频生成。') }}</p>
      <el-button v-if="configError && !loadingConfig" @click="loadConfig">重新加载</el-button>
    </section>

    <template v-else>
      <div class="workspace">
        <div class="input-panel">
          <form class="prompt-form" @submit.prevent="generateAudio">
            <div class="model-line">
              <h2>声音描述</h2>
              <span>Seed Audio 1.0</span>
            </div>
            <label class="sr-only" for="audio-prompt">声音描述</label>
            <textarea
              id="audio-prompt"
              v-model="prompt"
              :maxlength="promptLimit"
              :disabled="submitting"
              placeholder="例如，先是夜雨和远处的车声，一名女子低声说“你回来了”，随后响起轻微的关门声。"
            />
            <div class="input-caption">
              <span v-if="config.max_duration_seconds">单次最长 {{ config.max_duration_seconds }} 秒</span>
              <output for="audio-prompt">{{ prompt.length }} / {{ promptLimit }}</output>
            </div>
            <p v-if="submissionError" class="message error" role="alert">{{ submissionError }}</p>
            <div class="generate-actions">
              <el-button type="primary" native-type="submit" :loading="submitting" :disabled="!canGenerate">生成音频</el-button>
              <small v-if="!config.configured" role="status">音频生成服务尚未配置。</small>
              <small v-else-if="showRate">{{ config.rate_credits_per_minute }} 点／分钟，按生成时长结算</small>
            </div>
            <section class="prompt-example" aria-labelledby="prompt-example-heading">
              <div class="prompt-example-actions">
                <h3 id="prompt-example-heading">提示词实例</h3>
                <el-button native-type="button" size="small" aria-controls="audio-prompt" :disabled="submitting" @click="prompt = examplePrompt">填入示例</el-button>
              </div>
              <p>{{ examplePrompt }}</p>
            </section>
          </form>
        </div>

        <section class="preview-panel" aria-labelledby="preview-heading">
          <header class="preview-heading">
            <h2 id="preview-heading">音频试听</h2>
            <span v-if="selectedJob" class="job-status" :class="selectedJob.status">
              {{ statusText(selectedJob.status) }}
            </span>
          </header>

          <div v-if="selectedJob" class="preview-content" :key="selectedJob.id">
            <p class="selected-prompt">{{ selectedJob.prompt }}</p>
            <div v-if="selectedJob.status === 'completed' && selectedJob.audio_url" class="player">
              <audio controls preload="metadata" :src="selectedJob.audio_url" aria-label="试听所选音频" />
              <div class="player-footer">
                <small v-if="formatDuration(selectedJob.duration)">{{ formatDuration(selectedJob.duration) }}</small>
                <a class="download-link" :href="selectedJob.audio_url" download>下载音频</a>
              </div>
            </div>
            <p v-else class="message" :class="{ error: selectedJob.status === 'failed' }" role="status">
              {{ jobMessage(selectedJob) }}
            </p>
          </div>
          <div v-else class="preview-empty">
            <div class="audio-signal" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <p>{{ loadingHistory ? '正在读取生成记录…' : '生成音频后，可在这里试听和下载。' }}</p>
          </div>
        </section>
      </div>

      <section class="history-panel" aria-labelledby="history-heading" :aria-busy="loadingHistory">
        <header class="history-heading">
          <h2 id="history-heading">生成记录</h2>
          <el-button :loading="loadingHistory" size="small" @click="loadHistory">刷新记录</el-button>
        </header>
        <p v-if="historyError" class="message error" role="status">{{ historyError }}</p>
        <p v-else-if="!jobs.length" class="message muted">{{ loadingHistory ? '正在加载…' : '暂无生成记录。' }}</p>
        <ul v-if="jobs.length" class="history-list">
          <li v-for="job in jobs" :key="job.id">
            <button type="button" :aria-pressed="job.id === selectedId" @click="selectedId = job.id">
              <span class="history-prompt">{{ job.prompt }}</span>
              <time :datetime="job.created_at">{{ formatChinaDateTime(job.created_at, '时间未知') }}</time>
              <span class="job-status" :class="job.status">{{ statusText(job.status) }}</span>
            </button>
          </li>
        </ul>
      </section>
    </template>
  </main>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Headset } from '@element-plus/icons-vue'
import { audioGenerationAPI } from '@/api/audioGeneration'
import AccountBalanceBadge from '@/components/AccountBalanceBadge.vue'
import { createClientRequestId } from '@/utils/requestId'
import { formatChinaDateTime } from '@/utils/time'

const promptLimit = 3000
const examplePrompt = '生成一段约10秒、适合短剧的原创悬疑纯器乐配乐。前两秒低音大提琴持续音轻入，中间加入稀疏的弱奏钢琴和低频鼓点，张力逐步上升，最后两秒短促收束，在第10秒附近结束。全程只有乐器，无演唱、人声、对白、旁白和环境音效。'
const config = ref(null)
const loadingConfig = ref(true)
const configError = ref('')
const prompt = ref('')
const submitting = ref(false)
const submissionError = ref('')
const jobs = ref([])
const loadingHistory = ref(false)
const historyError = ref('')
const selectedId = ref(null)

const selectedJob = computed(() => jobs.value.find((job) => job.id === selectedId.value))
const canGenerate = computed(() => config.value?.configured && prompt.value.trim().length > 0)
const showRate = computed(() => Number(config.value?.rate_credits_per_minute) > 0)
const runningStatuses = new Set(['pending', 'processing'])
const statusLabels = {
  pending: '排队中',
  processing: '生成中',
  completed: '已完成',
  failed: '失败',
  pending_reconciliation: '待对账',
}

let pollTimer
let disposed = false
let submissionCount = 0
let pendingRequest

function statusText(status) {
  return statusLabels[status] || '状态未知'
}

function jobMessage(job) {
  if (job.status === 'failed') return job.error || '生成失败，请调整描述后重试。'
  if (job.status === 'pending_reconciliation') return '该请求正在核对生成结果与扣费状态，可稍后刷新。'
  if (job.status === 'completed') return '音频暂不可用，请刷新记录。'
  return runningStatuses.has(job.status) ? '音频完成后会自动显示在这里。' : '请刷新记录查看最新状态。'
}

function formatDuration(duration) {
  const seconds = Number(duration)
  return Number.isFinite(seconds) && seconds > 0 ? `${Number(seconds.toFixed(1))} 秒` : ''
}

function schedulePoll() {
  clearTimeout(pollTimer)
  if (disposed || document.hidden) return
  if (jobs.value.some((job) => runningStatuses.has(job.status))) pollTimer = setTimeout(loadHistory, 3000)
}

async function loadHistory() {
  if (disposed || !config.value?.available || loadingHistory.value) return
  const beforeSubmit = submissionCount
  clearTimeout(pollTimer)
  loadingHistory.value = true
  try {
    const result = await audioGenerationAPI.listJobs()
    if (disposed || beforeSubmit !== submissionCount) return
    const running = new Set(result.items.filter((job) => runningStatuses.has(job.status)).map((job) => job.id))
    const finished = jobs.value.some((job) => runningStatuses.has(job.status) && !running.has(job.id))
    jobs.value = result.items
    if (finished) window.dispatchEvent(new Event('lmd:balance-changed'))
    if (!selectedJob.value) selectedId.value = jobs.value[0]?.id ?? null
    historyError.value = ''
  } catch (_) {
    if (!disposed) historyError.value = '无法刷新生成记录，请重试。'
  } finally {
    loadingHistory.value = false
    schedulePoll()
  }
}

async function loadConfig() {
  loadingConfig.value = true
  configError.value = ''
  try {
    config.value = await audioGenerationAPI.getConfig()
    if (config.value?.available) void loadHistory()
  } catch (_) {
    configError.value = '无法加载音频生成设置，请重试。'
  } finally {
    loadingConfig.value = false
  }
}

async function generateAudio() {
  if (!canGenerate.value || submitting.value) return
  const text = prompt.value.trim()
  if (pendingRequest?.prompt !== text) pendingRequest = { prompt: text, id: createClientRequestId() }
  submitting.value = true
  submissionError.value = ''
  try {
    const job = await audioGenerationAPI.createJob(text, pendingRequest.id)
    submissionCount += 1
    jobs.value = [job, ...jobs.value.filter((item) => item.id !== job.id)]
    selectedId.value = job.id
    pendingRequest = null
    window.dispatchEvent(new Event('lmd:balance-changed'))
    schedulePoll()
  } catch (error) {
    submissionError.value = error.message || '无法提交音频生成请求，请重试。'
    void loadHistory()
  } finally {
    submitting.value = false
  }
}

function visibilityChanged() {
  if (document.hidden) clearTimeout(pollTimer)
  else if (jobs.value.some((job) => runningStatuses.has(job.status))) void loadHistory()
}

onMounted(() => {
  void loadConfig()
  document.addEventListener('visibilitychange', visibilityChanged)
})

onUnmounted(() => {
  disposed = true
  clearTimeout(pollTimer)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<style scoped>
.audio-tool {
  width: min(100%, 1170px);
  margin-inline: auto;
  padding: clamp(1rem, 3vw, 2.5rem) clamp(1rem, 3vw, 2rem) 3rem;
  color: var(--text-primary);
}

.workbench-header,
.model-line,
.preview-heading,
.history-heading,
.generate-actions,
.prompt-example-actions,
.player-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: .65rem 1rem;
}

.workbench-header { margin-bottom: 1.5rem; }
.back-link { color: var(--text-muted); font-size: .85rem; text-decoration: none; }
.back-link:hover { color: var(--accent); }
.tool-title { display: flex; align-items: center; gap: .7rem; margin-top: .6rem; }
.tool-title h1 { margin: 0; font-size: clamp(1.62rem, 3vw, 2rem); }
.title-icon {
  display: grid;
  width: 2.5rem;
  height: 2.5rem;
  place-items: center;
  flex: none;
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent-teal) 17%, var(--bg-surface));
  color: var(--accent-teal);
  font-size: 1.3rem;
}

.workspace { display: grid; grid-template-columns: minmax(0, 1.04fr) minmax(0, 1fr); gap: 1rem; }
.input-panel, .preview-panel, .history-panel, .access-state {
  min-width: 0;
  padding: clamp(1rem, 2.6vw, 1.5rem);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
}

.model-line { margin-bottom: .8rem; }
.model-line span, .input-caption, .generate-actions small, .player-footer small {
  color: var(--text-muted);
  font-size: .82rem;
}

.audio-tool h2 { margin: 0; font-size: 1.06rem; }
.prompt-form textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg-page);
  color: var(--text-primary);
  font: inherit;
  font-size: .95rem;
  display: block;
  min-height: 10.5rem;
  padding: .7rem .8rem;
  resize: vertical;
  line-height: 1.65;
}
.prompt-form textarea::placeholder { color: var(--text-muted); }
.audio-tool :is(textarea, a, .history-list button):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.input-caption { display: flex; flex-wrap: wrap; gap: .25rem .75rem; margin: .45rem 0 .9rem; }
.input-caption output { margin-left: auto; font-variant-numeric: tabular-nums; }
.generate-actions { justify-content: flex-start; }
.generate-actions .el-button { min-height: 2.35rem; }
.prompt-example { margin-top: 1rem; padding-top: .8rem; border-top: 1px solid var(--border-subtle); }
.prompt-example h3 { margin: 0; font-size: .9rem; }
.prompt-example p { margin: .5rem 0 0; color: var(--text-regular); font-size: .86rem; line-height: 1.65; }

.preview-panel { display: flex; flex-direction: column; }
.preview-heading, .history-heading { padding-bottom: .8rem; border-bottom: 1px solid var(--border-subtle); }
.preview-content { display: grid; align-content: start; gap: .8rem; padding-top: .8rem; }
.selected-prompt { margin: 0; color: var(--text-regular); font-size: .95rem; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.preview-empty { display: grid; place-items: center; align-content: center; flex: 1; min-height: 13rem; color: var(--text-muted); text-align: center; font-size: .88rem; }
.preview-empty p { margin: .9rem 0 0; }
.audio-signal { display: flex; height: 3rem; align-items: center; gap: .26rem; color: color-mix(in srgb, var(--accent-teal) 80%, var(--text-muted)); }
.audio-signal i { width: .19rem; height: 34%; border-radius: 99px; background: currentColor; }
.audio-signal i:nth-child(2n) { height: 57%; }
.audio-signal i:nth-child(4) { height: 100%; }
.audio-signal i:nth-child(5) { height: 74%; }
.player { display: grid; gap: .5rem; padding: .7rem; border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--bg-raised); }
.player audio { display: block; width: 100%; max-width: 100%; }
.player-footer { padding-inline: .2rem; }
.download-link { margin-left: auto; color: var(--accent); font-size: .88rem; text-underline-offset: .16em; }

.history-panel { margin-top: 1rem; }
.history-list { margin: 0; padding: 0; list-style: none; }
.history-list li + li { border-top: 1px solid var(--border-subtle); }
.history-list button {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) auto minmax(5.5rem, auto);
  align-items: center;
  gap: .35rem 1rem;
  padding: .65rem .55rem;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
}
.history-list button:hover { background: var(--bg-hover); }
.history-list button[aria-pressed='true'] { background: var(--bg-raised); box-shadow: inset 2px 0 var(--accent); }
.history-prompt { overflow: hidden; font-size: .88rem; text-overflow: ellipsis; white-space: nowrap; }
.history-list time { color: var(--text-muted); font-size: .77rem; font-variant-numeric: tabular-nums; }
.job-status { display: inline-flex; align-items: center; gap: .4rem; font-size: .78rem; color: var(--text-muted); white-space: nowrap; }
.job-status::before { width: .46rem; height: .46rem; border-radius: 50%; background: currentColor; content: ''; }
.job-status.completed { color: var(--accent-teal); }
.job-status.pending, .job-status.processing, .job-status.pending_reconciliation { color: var(--accent-warm); }
.job-status.failed, .error { color: var(--status-danger); }
.message { margin: .45rem 0 0; font-size: .86rem; line-height: 1.55; overflow-wrap: anywhere; }
.prompt-form .message { margin: 0 0 .65rem; }
.muted { color: var(--text-muted); }
.access-state p { margin: 0 0 .5rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

@media (max-width: 720px) {
  .workspace { grid-template-columns: minmax(0, 1fr); }
  .preview-empty { min-height: 9rem; }
}

@media (max-width: 480px) {
  .history-list button { grid-template-columns: minmax(0, 1fr) auto; }
  .history-prompt { grid-column: 1 / -1; }
  .job-status { justify-self: end; }
}
</style>
