<template>
  <main class="relay-studio">
    <header class="studio-header"><div><router-link to="/ai-tools">← AI 工具箱</router-link><h1>中转图片与素材理解</h1><p>使用 GPT Image、Vega 图片和 Vega 理解模型，结果保存在当前账户。</p></div><AccountBalanceBadge /></header>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
    <div class="studio-grid">
      <section class="studio-card">
        <h2>创作设置</h2>
        <fieldset :disabled="busy">
          <label>计费归属项目<el-select v-model="dramaId" filterable placeholder="请选择项目" aria-label="计费归属项目"><el-option v-for="p in projects" :key="p.id" :value="p.id" :label="p.title" /></el-select></label>
          <label>模型<el-select v-model="selection" filterable placeholder="请选择已上架的模型" aria-label="中转模型"><el-option v-for="m in models" :key="modelKey(m)" :value="modelKey(m)" :label="m.model" /></el-select></label>
          <p v-if="!loading && !models.length" class="hint">暂无可用模型。管理员需先导入模型、同步发布完整价格并上架；中转业务 Key 也须开通对应型号。</p>
          <p v-if="current" class="hint">{{ understanding ? '素材理解：文字、图片、视频、音频和文件' : gpt ? 'GPT Image：当前渠道支持文生图' : 'Vega 图片：支持提示词与参考图生成' }}</p>
          <label>{{ understanding ? '理解要求' : '图片提示词' }}<el-input v-model="prompt" type="textarea" :rows="7" :maxlength="vegaImage ? 2000 : 16000" show-word-limit :placeholder="understanding ? '例如：描述画面内容，整理人物和剧情要点' : '描述主体、场景、构图与画风'" aria-label="提示词" /></label>
          <div v-if="current && !understanding" class="settings-grid">
            <label>输出张数<el-input-number v-model="n" :min="1" :max="maxN" aria-label="输出张数" /></label>
            <label>尺寸<el-select v-model="size" aria-label="图片尺寸"><el-option v-for="v in sizes" :key="v" :label="v" :value="v" /></el-select></label>
            <label v-if="gpt">质量<el-select v-model="quality" aria-label="图片质量"><el-option v-for="v in qualities" :key="v" :label="qualityLabels[v] || v" :value="v" /></el-select></label>
            <label v-if="vegaImage">画幅比例<el-select v-model="ratio" aria-label="画幅比例"><el-option v-for="v in ratios" :key="v" :value="v" :label="v" /></el-select></label>
          </div>
          <div v-if="understanding" class="settings-grid"><label>输入与回答长度上限<el-select v-model="maxTokens" aria-label="输入与回答长度上限"><el-option v-for="v in [1024,2048,4096,8192]" :key="v" :value="v" :label="`${v} Token`" /></el-select></label><label class="check-label"><el-checkbox v-model="thinking">开启思考</el-checkbox></label></div>
          <section v-if="current && !gpt" class="input-media">
            <label class="upload-label">{{ understanding ? '上传理解素材' : '上传参考图片' }}<input ref="uploadInput" type="file" multiple :accept="understanding ? 'image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,application/pdf,text/plain' : 'image/png,image/jpeg,image/webp'" @change="readFiles" /></label>
            <p class="hint">{{ understanding ? '支持图片、视频、音频、PDF、TXT；合计最多 8 MiB。Pro 必须提供素材。' : `最多 ${maxRefs} 张参考图，合计最多 7 MiB。` }}</p>
            <ul class="media-list"><li v-for="(item,index) in media" :key="index"><span>{{ item.name }}</span><button type="button" :aria-label="`移除 ${item.name}`" @click="media.splice(index,1)">移除</button></li></ul>
          </section>
          <div class="submit-area"><el-button type="primary" size="large" :loading="busy" :disabled="!current || !dramaId || (!prompt.trim() && !media.length)" @click="submit">{{ understanding ? '分析素材' : '生成图片' }}</el-button><p class="hint">提交前确认预冻结积分，完成后按供应商真实用量结算。刷新或离开页面不会重复提交。</p></div>
        </fieldset>
      </section>
      <section class="studio-card results" aria-live="polite">
        <div class="section-title"><h2>当前结果</h2><el-button :loading="refreshing" @click="refreshActive">刷新结果</el-button></div>
        <template v-if="active">
          <p class="result-status"><b>{{ statusLabels[active.state] || active.state }}</b> · {{ active.model }}</p>
          <p v-if="active.billing_state === 'pending_reconciliation'" class="pending-note">费用待核对，预冻结积分保留；请勿重复生成。</p>
          <p v-if="active.error_msg" class="result-note">{{ active.error_msg }}</p>
          <p v-if="active.charged !== null">实际结算：{{ active.charged }} 积分</p>
          <div class="result-images"><figure v-for="(image,index) in active.images" :key="image.local_path"><img :src="image.image_url" :alt="`生成结果 ${index + 1}`" /><figcaption><a :href="image.image_url" download>下载第 {{ index + 1 }} 张</a><span>{{ image.width }} × {{ image.height }}</span></figcaption></figure></div>
          <div v-if="active.text" class="text-result"><pre>{{ active.text }}</pre><el-button @click="copyResult">复制理解结果</el-button></div>
          <p v-if="['queued','submitting','running','archiving'].includes(active.state)" class="hint">任务在后台处理，页面会自动更新。</p>
        </template>
        <p v-else class="empty">提交任务或选择下方历史记录查看结果。</p>
        <h2 class="history-title">历史记录</h2>
        <div class="history-list"><button v-for="item in runs" :key="item.id" type="button" :class="{ selected:active?.id === item.id }" @click="active = item"><b>{{ item.model }}</b><span>{{ statusLabels[item.state] }} · {{ formatChinaDateTime(item.created_at) }}</span></button></div>
      </section>
    </div>
  </main>
</template>
<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import AccountBalanceBadge from '@/components/AccountBalanceBadge.vue'
import { dramaAPI } from '@/api/drama'
import { relayModelsAPI } from '@/api/relayModels'
import { createClientRequestId } from '@/utils/requestId'
import { formatChinaDateTime } from '@/utils/time'
const route=useRoute(), projects=ref([]), models=ref([]), selection=ref(''), dramaId=ref(Number(route.query.drama_id)||null), prompt=ref(''), media=ref([]), n=ref(1), size=ref('1K'), ratio=ref('1:1'), quality=ref('medium'), maxTokens=ref(2048), thinking=ref(false)
const busy=ref(false), loading=ref(true), refreshing=ref(false), loadError=ref(''), runs=ref([]), active=ref(null), requestId=ref(createClientRequestId())
const modelKey=m=>`${m.config_id}:${m.model}`, current=computed(()=>models.value.find(m=>modelKey(m)===selection.value)), understanding=computed(()=>current.value?.family==='vega_vl'), gpt=computed(()=>current.value?.family==='gpt_image'), vegaImage=computed(()=>current.value?.family==='vega_image')
const maxN=computed(()=>Math.min(current.value?.capabilities?.maxN||1,vegaImage.value?4:10)), maxRefs=computed(()=>current.value?.capabilities?.maxInputImages||0), sizes=computed(()=>gpt.value?['1024x1024','1536x1024','1024x1536','2048x2048','2048x1152','3840x2160','2160x3840','auto']:['1K','2K','4K']), qualities=computed(()=>current.value?.capabilities?.qualityLevels||['auto','low','medium','high'])
const ratios=['1:1','2:3','3:2','3:4','4:3','9:16','16:9','21:9'], qualityLabels={auto:'自动',low:'低',medium:'中',high:'高',xhigh:'超高',max:'最高'}, statusLabels={queued:'排队中',submitting:'提交中',running:'生成中',archiving:'保存结果中',completed:'已完成',failed:'失败',reconciliation:'结果待核对'}
watch(selection,()=>{media.value=[];n.value=1;size.value=gpt.value?'1024x1024':'1K';quality.value='medium'})
function body(){return {model:current.value.model,config_id:current.value.config_id,drama_id:Number(dramaId.value),prompt:prompt.value,media:media.value,...(understanding.value?{max_tokens:maxTokens.value,thinking_enabled:thinking.value}:{n:n.value,size:size.value,...(gpt.value?{quality:quality.value}:{aspect_ratio:ratio.value})})}}
watch([selection,dramaId,prompt,media,n,size,ratio,quality,maxTokens,thinking],()=>{requestId.value=createClientRequestId()},{deep:true,flush:'sync'})
async function readFiles(event){const files=[...event.target.files];event.target.value='';const entries=[];try{for(const f of files){if(f.size>8*1024*1024)throw Error('单份素材不能超过 8 MiB');const type=f.type.startsWith('image/')?'image':f.type.startsWith('video/')?'video':f.type.startsWith('audio/')?'audio':'file';const url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(f)});entries.push({type,name:f.name,url})}media.value.push(...entries)}catch(e){ElMessage.error(e.message||'读取素材失败')}}
async function loadRuns(){if(refreshing.value)return;refreshing.value=true;try{runs.value=await relayModelsAPI.list();if(active.value)active.value=runs.value.find(r=>r.id===active.value.id)||active.value}catch(e){loadError.value=e.message}finally{refreshing.value=false}}
async function refreshActive(){try{if(active.value)active.value=await relayModelsAPI.refresh(active.value.id);await loadRuns()}catch(e){ElMessage.error(e.message)}}
async function submit(){busy.value=true;try{const input=body();const quote=await relayModelsAPI.quote(input);await ElMessageBox.confirm(`本次先冻结 ${quote.amount} 积分，最终按真实用量结算，可能产生差额补扣。是否提交？`,'确认生成费用',{confirmButtonText:'确认提交',cancelButtonText:'取消'});active.value=await relayModelsAPI.create({...input,expected_quote:quote.quote_hash,idempotency_key:requestId.value});await loadRuns()}catch(e){if(e!=='cancel'&&e!=='close')ElMessage.error(e.message||'提交失败')}finally{busy.value=false}}
async function copyResult(){await navigator.clipboard.writeText(active.value.text);ElMessage.success('已复制')}
let timer
onMounted(async()=>{try{const [p,m]=await Promise.all([dramaAPI.list({page_size:100}),relayModelsAPI.models()]);projects.value=p?.items||p||[];models.value=m;const preferred=m.find(x=>x.model===route.query.model)||m[0];if(preferred)selection.value=modelKey(preferred);await loadRuns();timer=setInterval(loadRuns,2500)}catch(e){loadError.value=e.message}finally{loading.value=false}})
onUnmounted(()=>clearInterval(timer))
</script>
<style scoped>
.relay-studio{box-sizing:border-box;height:100dvh;overflow-y:auto;overflow-x:hidden;background:var(--bg-page,#f4f5f7);color:var(--text-primary,#20242b);padding:28px clamp(16px,3vw,48px) 48px}.studio-header{max-width:1480px;margin:0 auto 24px;display:flex;align-items:center;justify-content:space-between;gap:24px}.studio-header h1{font-size:26px;margin:14px 0 8px}.studio-header p,.hint{color:var(--text-muted,#707783);font-size:13px;line-height:1.7}.studio-header a,a{color:var(--accent,#5263cc)}.studio-grid{display:grid;grid-template-columns:minmax(360px,.85fr) minmax(0,1.15fr);gap:24px;max-width:1480px;margin:auto;align-items:start}.studio-card{min-width:0;padding:24px;border:1px solid var(--border-color,#dfe2e8);border-radius:12px;background:var(--bg-card,#fff)}h2{font-size:18px;margin:0 0 20px}fieldset{min-width:0;border:0;padding:0;margin:0}label{display:flex;min-width:0;flex-direction:column;gap:9px;font-size:14px;margin-bottom:20px}.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}.check-label{justify-content:end}.submit-area{padding-top:12px;border-top:1px solid var(--border-color,#dfe2e8)}.submit-area .el-button{width:100%}.section-title{display:flex;justify-content:space-between;align-items:start;gap:12px}.result-status,.result-note{overflow-wrap:anywhere;line-height:1.65}.pending-note{padding:12px;border:1px solid #d4ab62;border-radius:6px;font-size:13px;color:#8d641d}.result-images{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.result-images figure{margin:0;min-width:0}.result-images img{display:block;width:100%;height:auto;border-radius:6px}.result-images figcaption{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:10px 0;font-size:12px}.text-result pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;font:inherit;line-height:1.8}.history-title{margin-top:32px}.history-list{display:grid;gap:8px}.history-list button{padding:14px;text-align:left;border:1px solid var(--border-color,#dfe2e8);border-radius:6px;background:transparent;color:inherit;cursor:pointer;min-width:0}.history-list b,.history-list span{display:block;overflow-wrap:anywhere}.history-list span{margin-top:8px;color:var(--text-muted,#707783);font-size:12px}.history-list .selected{border-color:var(--accent,#5263cc)}.media-list{list-style:none;padding:0}.media-list li{display:flex;justify-content:space-between;gap:10px;margin-bottom:8px;font-size:12px}.media-list span{min-width:0;overflow-wrap:anywhere}.media-list button{flex:none;border:0;background:transparent;color:var(--accent,#5263cc);cursor:pointer}.upload-label input{max-width:100%}.empty{padding:24px 0;color:var(--text-muted,#707783)}.relay-studio>:deep(.el-alert){max-width:1480px;margin:0 auto 20px;box-sizing:border-box}@media(max-width:800px){.studio-grid{grid-template-columns:minmax(0,1fr)}.studio-header{align-items:start}.studio-header h1{font-size:22px}.studio-card{padding:18px}.result-images{grid-template-columns:1fr}.settings-grid{gap:0 12px}}
</style>
