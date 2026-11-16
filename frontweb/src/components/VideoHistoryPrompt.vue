<template>
  <details class="video-history-prompt" @toggle="onToggle">
    <summary :aria-label="`${open ? '收起提示词' : '查看提示词'} #${generationId}`">
      {{ open ? '收起提示词' : '查看提示词' }}
    </summary>
    <div class="prompt-content">
      <div v-if="failed" class="prompt-actions">
        <p role="status">提示词读取失败。</p>
        <el-button size="small" text @click="loadPrompt">重试</el-button>
      </div>
      <p v-else-if="originalPrompt === null" role="status">正在读取提示词…</p>
      <p v-else-if="!originalPrompt.trim()">这条记录没有保存提示词。</p>
      <template v-else>
        <div class="prompt-actions">
          <el-button size="small" text :icon="CopyDocument" @click="copyPrompt">复制原始提示词</el-button>
        </div>
        <pre>{{ originalPrompt }}</pre>
      </template>
    </div>
  </details>
</template>

<script setup>
import { ref } from 'vue'
import { CopyDocument } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { omniVideoAPI } from '@/api/omniVideo'
import { copyText } from '@/utils/clipboard'

const props = defineProps({ generationId: { type: [Number, String], required: true } })
const open = ref(false)
const loading = ref(false)
const failed = ref(false)
const originalPrompt = ref(null)

function onToggle(event) {
  open.value = event.currentTarget.open
  if (open.value && originalPrompt.value === null) void loadPrompt()
}

async function loadPrompt() {
  if (loading.value) return
  loading.value = true
  failed.value = false
  try {
    const detail = await omniVideoAPI.historyDetail(props.generationId, { errorHandledLocally: true })
    originalPrompt.value = detail.original_prompt || ''
  } catch (_) {
    failed.value = true
  } finally {
    loading.value = false
  }
}

async function copyPrompt() {
  try {
    await copyText(originalPrompt.value)
    ElMessage.success('已复制原始提示词')
  } catch (_) {
    ElMessage.error('复制失败，请选中提示词手动复制')
  }
}
</script>

<style scoped>
.video-history-prompt { min-width: 0; }
.video-history-prompt summary {
  width: fit-content;
  margin-inline-start: auto;
  padding: 8px;
  border-radius: 6px;
  color: var(--accent);
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
}
.video-history-prompt summary:hover { background: var(--bg-hover); }
.video-history-prompt summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.prompt-content {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-raised);
  color: var(--text-regular);
}
.prompt-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; }
.prompt-actions p { margin-inline-end: auto; }
.prompt-content p, .prompt-content pre { margin: 0; font: inherit; font-size: 13px; line-height: 1.65; }
.prompt-content pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
