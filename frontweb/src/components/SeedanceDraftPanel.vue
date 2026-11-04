<template>
  <section class="seedance-drafts" aria-label="Seedance 样片">
    <div class="draft-heading"><div><b>480p 样片</b><p>先检查画面与动作，满意后再升级1080p。两个阶段分别计费。</p></div>
      <el-button :disabled="disabled || !canGenerate || running" :loading="generating" @click="$emit('generate')">生成480p样片</el-button></div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="!rows.length" class="draft-empty">样片独立归档，不覆盖当前成片。升级沿用原始提示词、素材、时长和音频设置。</p>
    <div class="draft-history">
      <article v-for="item in rows" :key="item.id" class="draft-card">
        <div class="draft-card-head"><b>样片 #{{ item.id }}</b><span>{{ statusLabel(item) }}</span><span>样片扣费：{{ item.actual_points == null ? '待结算' : `${Number(item.actual_points).toFixed(2)} 积分` }}</span></div>
        <video v-if="item.local_path" :src="item.video_url" controls preload="metadata" playsinline />
        <p v-if="item.error_msg" role="alert">{{ item.error_msg }}</p>
        <p>升级期限：{{ formatTime(item.draft_expires_at) }}<template v-if="item.draft_expired">（已过期，本地样片仍保留）</template></p>
        <p v-if="item.final_generation_id">已关联正式任务 #{{ item.final_generation_id }}，成片单独结算，可在生成历史查看。</p>
        <el-button v-if="item.draft_can_recover || item.final_can_recover" :disabled="disabled || busy" @click="recover(item.final_can_recover ? item.final_generation_id : item.id)">恢复{{ item.final_can_recover ? '成片' : '样片' }}归档（不重新生成）</el-button>
        <el-button v-if="!item.final_generation_id" type="primary" :disabled="disabled || !item.draft_can_finalize || busy || running" :loading="busy === item.id" @click="finalize(item)">确认样片，升级1080p</el-button>
      </article>
    </div>
  </section>
</template>
<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { videosAPI } from '@/api/videos'
const notifyBalanceChanged = () => window.dispatchEvent(new CustomEvent('lmd:balance-changed'))
const props = defineProps({ storyboardId: [Number, String], shotId: [Number, String], disabled: Boolean, generating: Boolean, canGenerate: { type: Boolean, default: true } })
const emit = defineEmits(['generate', 'updated'])
const rows = ref([]), busy = ref(null), error = ref('')
const running = computed(() => rows.value.some(item => ['processing','sd2_waiting','persisting'].includes(item.status)))
let alive = true
const identity = () => `${props.storyboardId || ''}:${props.shotId || ''}`
const formatTime = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value)) + '（北京时间）' : '待供应商确认'
const statusLabel = item => ({ completed: '已本地归档', failed: '生成失败', sd2_waiting: '等待素材认证', processing: '生成中', persisting: '归档中' })[item.status] || item.status
async function refresh() {
  const before = identity()
  if (!props.storyboardId && !props.shotId) { rows.value = []; return }
  try { const data = await videosAPI.drafts(props.storyboardId ? { storyboard_id: props.storyboardId } : { shot_id: props.shotId }); if (alive && before === identity()) { rows.value = data || []; error.value = '' } }
  catch (e) { if (alive && before === identity()) error.value = e.message || '样片读取失败' }
}
async function finalize(item) {
  if (busy.value) return
  busy.value = item.id
  try {
    const quote = await videosAPI.draftFinalQuote(item.id)
    await ElMessageBox.confirm(`将沿用该样片的原始创作参数生成1080p成片，另行预授权 ${Number(quote.amount).toFixed(2)} 积分，最终按供应商真实用量结算。`, '升级正式成片', { confirmButtonText: '确认生成并计费', cancelButtonText: '取消', type: 'warning' })
    await videosAPI.finalizeDraft(item.id); notifyBalanceChanged(); await refresh(); emit('updated'); ElMessage.success('正式任务已提交，可在生成历史查看')
  } catch (e) { if (e !== 'cancel' && e !== 'close') ElMessage.error(e.message || '升级失败') }
  finally { busy.value = null }
}
async function recover(id) {
  busy.value = id
  try { await videosAPI.recoverDraft(id); await refresh(); emit('updated'); ElMessage.success('已恢复查询与归档，不会重新提交生成') }
  catch (e) { ElMessage.error(e.message || '恢复归档失败') }
  finally { busy.value = null }
}
watch(identity, () => { rows.value = []; void refresh() }, { immediate: true })
const timer = setInterval(() => { void refresh() }, 3000)
onBeforeUnmount(() => { alive = false; clearInterval(timer) })
defineExpose({ refresh })
</script>
<style scoped>
.seedance-drafts { padding: 14px; margin: 12px 0; border: 1px solid var(--el-border-color); border-radius: 12px; min-width: 0; }
.draft-heading,.draft-card-head { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:8px; }
.seedance-drafts p { font-size:12px; line-height:1.7; color:var(--el-text-color-secondary); overflow-wrap:anywhere; margin:8px 0; }
.draft-history { display:grid; gap:12px; max-height:440px; overflow-y:auto; }
.draft-card { border-top:1px solid var(--el-border-color-lighter); padding-top:12px; min-width:0; }
.draft-card-head { font-size:12px; }
.draft-card video { display:block; width:100%; max-height:220px; margin-top:10px; background:#111; }
.seedance-drafts :deep(.el-button) { white-space:normal; height:auto; min-height:32px; max-width:100%; }
</style>
