<template>
  <main class="ownership-page" :aria-busy="loading">
    <header class="page-heading">
      <h1>客户与项目</h1>
      <div class="actions">
        <router-link class="button-link" :to="projectUsageRoute">项目用量</router-link>
        <router-link class="button-link" :to="costRoute">消耗与成本</router-link>
      </div>
    </header>

    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <div v-if="loadError" class="message-panel" role="alert">
      <p>{{ loadError }}</p>
      <el-button :loading="loading" @click="load">重新加载</el-button>
    </div>
    <p v-else-if="loading && !snapshot" class="muted" role="status">正在加载客户与项目…</p>

    <div v-if="snapshot" class="workspace">
      <nav class="scope-list" aria-label="业务归属">
        <section class="scope-section" aria-labelledby="customers-heading">
          <h2 id="customers-heading" class="external-heading">
            <button class="scope-button scope-toggle" type="button" :aria-expanded="externalExpanded"
              aria-controls="external-customers" @click="externalExpanded = !externalExpanded">
              <span>外部客户</span>
              <small>{{ externalAccounts.length }} 个</small>
              <span class="scope-chevron" aria-hidden="true"></span>
            </button>
          </h2>
          <div v-show="externalExpanded" id="external-customers">
            <button class="scope-button" type="button" :aria-current="selected === 'external' ? 'true' : undefined"
              @click="selectScope('external')">外部客户合计</button>
            <div v-if="externalAccounts.length" class="external-account-list">
              <button v-for="customer in externalAccounts" :key="customer.key" class="scope-button" type="button"
                :aria-current="selected === customer.key ? 'true' : undefined" @click="selectScope(customer.key)">
                <span>{{ customer.name }}</span>
                <small>{{ customer.individual ? '独立客户 · ' : '' }}{{ customer.projects.length }} 个项目</small>
              </button>
            </div>
            <p v-else class="muted scope-empty">暂无外部客户</p>
            <div class="actions scope-actions">
              <router-link class="text-link" :to="customerAccountsRoute">管理客户账户</router-link>
              <el-button v-if="availableIndividuals.length" size="small" text
                :disabled="saving || loading || !!loadError" @click="editIndividual">
                添加独立客户
              </el-button>
            </div>
          </div>
        </section>
        <section class="scope-section" aria-labelledby="internal-heading">
          <h2 id="internal-heading">内部团队</h2>
          <button class="scope-button" type="button" :aria-current="selected === 'internal' ? 'true' : undefined"
            @click="selectScope('internal')">
            <span>内部漫剧</span>
            <small>{{ snapshot.internal.projects.length }} 个项目</small>
          </button>
        </section>
        <button class="scope-button pending-button" type="button"
          :aria-current="selected === 'pending' ? 'true' : undefined" @click="selectScope('pending')">
          <span>待确认</span>
          <small>{{ snapshot.pending.projects.length }} 个项目</small>
        </button>
      </nav>

      <section class="scope-detail" aria-labelledby="scope-title">
        <header class="scope-heading">
          <div>
            <h2 id="scope-title">{{ scopeName }}</h2>
            <small v-if="activeExternal?.individual">独立客户 · 个人积分</small>
            <p class="muted usage-range-label">用量查询 · {{ usageDateLabel(range) }}（北京时间）</p>
          </div>
          <router-link class="button-link" :to="costRoute">查看消耗</router-link>
        </header>

        <p v-if="actionError" class="error" role="alert">{{ actionError }}</p>

        <section v-if="activeExternal" class="detail-section" aria-labelledby="configuration-title">
          <div class="section-heading">
            <div>
              <h3 id="configuration-title">配置组</h3>
              <p class="configuration-name">{{ activeExternal.config_tenant_name || '尚未分配' }}</p>
              <p v-if="activeCustomer?.config_group_state === 'shared'" class="muted">当前使用共享配置组。</p>
            </div>
            <div class="actions">
              <el-button v-if="activeCustomer && activeCustomer.config_group_state !== 'dedicated'" type="primary"
                :loading="saving" :disabled="loading || !!loadError" @click="createCustomerGroup">
                分配专属配置组
              </el-button>
              <router-link v-if="activeExternal.config_tenant_id" class="button-link" :to="configurationRoute">
                管理配置组
              </router-link>
            </div>
          </div>
        </section>

        <dl v-if="combinedScope" class="detail-section combined-counts">
          <div><dt>外部客户</dt><dd>{{ externalAccounts.length }}</dd></div>
          <div><dt>在册项目</dt><dd>{{ combinedProjectCount }}</dd></div>
        </dl>

        <section v-if="selected !== 'pending' && !combinedScope" class="detail-section" aria-labelledby="members-title">
          <div class="section-heading">
            <h3 id="members-title">成员 <small>{{ members.length }}</small></h3>
            <el-button v-if="selected === 'internal'" :disabled="saving || loading || !!loadError" @click="editMembers">
              管理内部成员
            </el-button>
            <router-link v-else-if="activeCustomer" class="button-link" :to="customerAccountsRoute">管理客户成员</router-link>
          </div>
          <ul v-if="members.length" class="member-list">
            <li v-for="member in members" :key="member.id">
              <strong>{{ memberName(member) }}</strong>
              <small v-if="member.display_name && member.username !== member.display_name">{{ member.username }}</small>
            </li>
          </ul>
          <p v-else class="muted empty">暂无成员</p>
        </section>

        <section v-if="!combinedScope" class="detail-section" aria-labelledby="projects-title">
          <div class="section-heading">
            <h3 id="projects-title">项目 <small>{{ projects.length }}</small></h3>
            <el-button v-if="selected !== 'pending' && snapshot.pending.projects.length" type="primary"
              :disabled="saving || loading || !!loadError" @click="editProject()">
              从待确认加入
            </el-button>
          </div>
          <ul v-if="projects.length" class="project-list">
            <li v-for="project in projects" :key="project.id">
              <div>
                <strong>{{ projectName(project) }}</strong>
                <small>项目 ID {{ project.id }}</small>
              </div>
              <el-button :disabled="saving || loading || !!loadError" @click="editProject(project)">
                {{ selected === 'pending' ? '确认归属' : '调整归属' }}
              </el-button>
            </li>
          </ul>
          <p v-else class="muted empty">{{ selected === 'pending' ? '暂无待确认的项目' : '暂无归入此处的项目' }}</p>
        </section>
      </section>
    </div>

    <el-dialog v-model="projectDialog" title="设置项目归属" width="min(480px, calc(100% - 28px))"
      destroy-on-close :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving">
      <p v-if="editingProject" class="editing-name">{{ projectName(editingProject) }}</p>
      <el-form label-position="top" @submit.prevent="saveProject">
        <el-form-item v-if="!editingProject" label="项目">
          <el-select v-model="draftProjectId" filterable placeholder="选择项目" :disabled="saving">
            <el-option v-for="project in snapshot?.pending.projects" :key="project.id" :value="project.id"
              :label="`${projectName(project)} · #${project.id}`" />
          </el-select>
        </el-form-item>
        <el-form-item label="归属">
          <el-select v-model="draftTarget" placeholder="选择客户或内部团队" :disabled="saving">
            <el-option v-for="customer in externalAccounts" :key="customer.key" :value="customer.key"
              :label="customer.individual ? `${customer.name} · 独立客户` : customer.name" />
            <el-option value="internal" label="内部漫剧" />
            <el-option value="pending" label="待确认" />
          </el-select>
        </el-form-item>
        <p v-if="dialogError" class="error" role="alert">{{ dialogError }}</p>
        <div class="dialog-actions">
          <el-button :disabled="saving" @click="projectDialog = false">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="saving"
            :disabled="!draftProjectId || !draftTarget || draftTarget === originalTarget">
            保存归属
          </el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="membersDialog" title="管理内部成员" width="min(480px, calc(100% - 28px))"
      destroy-on-close :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving">
      <el-form label-position="top" @submit.prevent="saveMembers">
        <el-form-item label="内部成员">
          <el-select v-model="draftMemberIds" multiple filterable placeholder="选择账号" :disabled="saving">
            <el-option v-for="member in availableMembers" :key="member.id" :value="member.id"
              :label="memberOptionLabel(member)" />
          </el-select>
        </el-form-item>
        <p v-if="dialogError" class="error" role="alert">{{ dialogError }}</p>
        <div class="dialog-actions">
          <el-button :disabled="saving" @click="membersDialog = false">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="saving">保存成员</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="individualDialog" title="添加独立客户" width="min(480px, calc(100% - 28px))"
      destroy-on-close :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving">
      <p class="individual-note muted">添加后，该账号仍用个人积分扣费，并继续使用当前配置组。</p>
      <el-form label-position="top" @submit.prevent="saveIndividual">
        <el-form-item label="外部客户账号">
          <el-select v-model="draftIndividualId" filterable placeholder="选择账号" :disabled="saving">
            <el-option v-for="member in availableIndividuals" :key="member.id" :value="member.id"
              :label="member.config_tenant_name
                ? `${memberOptionLabel(member)} · ${member.config_tenant_name}` : memberOptionLabel(member)" />
          </el-select>
        </el-form-item>
        <p v-if="dialogError" class="error" role="alert">{{ dialogError }}</p>
        <div class="dialog-actions">
          <el-button :disabled="saving" @click="individualDialog = false">取消</el-button>
          <el-button type="primary" native-type="submit" :disabled="!draftIndividualId" :loading="saving">添加</el-button>
        </div>
      </el-form>
    </el-dialog>
  </main>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { operationsOwnershipAPI } from '@/api/operationsOwnership'
import { readUsageRange, usageDateLabel, usageRangeQuery } from '@/utils/operationsUsageQuery'

const route = useRoute()
const router = useRouter()
const range = computed(() => {
  const query = route.query
  if (query.ops_scope || query.ops_customer_id || query.ops_individual_id) return readUsageRange(query)
  return readUsageRange({ ...query, ops_scope: 'internal' })
})
const snapshot = ref(null)
const selected = computed(() => {
  if (range.value.ops_customer_id) return `customer:${range.value.ops_customer_id}`
  return range.value.ops_individual_id ? `individual:${range.value.ops_individual_id}` : range.value.ops_scope
})
const externalExpanded = ref(false)
const loading = ref(false)
const saving = ref(false)
const loadError = ref('')
const actionError = ref('')
const dialogError = ref('')
const notice = ref('')

const projectDialog = ref(false)
const membersDialog = ref(false)
const individualDialog = ref(false)
const editingProject = ref(null)
const draftProjectId = ref(null)
const draftTarget = ref('')
const originalTarget = ref('')
const draftMemberIds = ref([])
const draftIndividualId = ref(null)

const customerAccountsRoute = { path: '/admin', query: { tab: 'governance', settings: 'organizations' } }
const configurationRoute = { path: '/admin', query: { tab: 'governance', settings: 'tenants' } }
const memberName = (member) => member.display_name || member.username
const memberOptionLabel = (member) => member.display_name && member.display_name !== member.username
  ? `${member.display_name}（${member.username}）` : memberName(member)
const projectName = (project) => project.title || `项目 #${project.id}`
const externalAccounts = computed(() => [
  ...(snapshot.value?.customers ?? []).map(customer => ({ ...customer, key: `customer:${customer.id}` })),
  ...(snapshot.value?.individual_customers ?? []).map(customer => ({
    ...customer, key: `individual:${customer.id}`, individual: true,
  })),
])
const activeExternal = computed(() => externalAccounts.value.find(customer => customer.key === selected.value))
const activeCustomer = computed(() => activeExternal.value?.individual ? null : activeExternal.value)
const availableIndividuals = computed(() => snapshot.value?.available_individual_users ?? [])
const scopeName = computed(() => activeExternal.value?.name ?? ({ all: '全部归属', internal: '内部漫剧', external: '外部客户合计', pending: '待确认' })[selected.value]
  ?? (range.value.ops_individual_id ? `独立客户 #${range.value.ops_individual_id}` : `客户 #${range.value.ops_customer_id}`))
const combinedScope = computed(() => selected.value === 'all' || selected.value === 'external')
const combinedProjectCount = computed(() => externalAccounts.value.reduce((count, customer) => count + customer.projects.length, 0)
  + (selected.value === 'all' ? snapshot.value.internal.projects.length + snapshot.value.pending.projects.length : 0))
const group = computed(() => activeExternal.value ?? snapshot.value?.[selected.value])
const members = computed(() => group.value?.members ?? [])
const projects = computed(() => group.value?.projects ?? [])
const availableMembers = computed(() => {
  const users = new Map()
  for (const member of snapshot.value?.internal.members ?? []) users.set(member.id, member)
  const individualIds = new Set((snapshot.value?.individual_customers ?? []).map(customer => customer.id))
  for (const member of snapshot.value?.available_users ?? []) {
    if (!individualIds.has(member.id)) users.set(member.id, member)
  }
  return Array.from(users.values())
})
const costRoute = computed(() => ({ path: '/admin/costs', query: usageRangeQuery(range.value) }))
const projectUsageRoute = computed(() => ({ path: '/admin', query: { tab: 'projectUsage', ...usageRangeQuery(range.value) } }))

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    snapshot.value = await operationsOwnershipAPI.list()
  } catch (error) {
    loadError.value = error.message
  } finally {
    loading.value = false
  }
}

function selectScope(key) {
  actionError.value = ''
  if (key === selected.value) return
  const [kind, id] = key.split(':')
  return router.replace({ query: usageRangeQuery({
    ...range.value,
    ops_scope: id ? 'external' : kind,
    ops_customer_id: kind === 'customer' ? id : '',
    ops_individual_id: kind === 'individual' ? id : '',
    drama_id: '',
  }) })
}

watch(selected, key => {
  if (key === 'external' || key.startsWith('customer:') || key.startsWith('individual:')) externalExpanded.value = true
}, { immediate: true })

function editProject(project = null) {
  editingProject.value = project
  draftProjectId.value = project?.id ?? null
  draftTarget.value = project && selected.value === 'pending' ? '' : selected.value
  originalTarget.value = project ? selected.value : ''
  dialogError.value = ''
  projectDialog.value = true
}

function editMembers() {
  draftMemberIds.value = snapshot.value.internal.members.map(member => member.id)
  dialogError.value = ''
  membersDialog.value = true
}

function editIndividual() {
  draftIndividualId.value = null
  dialogError.value = ''
  individualDialog.value = true
}

async function applyChange(operation, message, dialog) {
  if (saving.value || loading.value || loadError.value) return
  saving.value = true
  notice.value = ''
  dialogError.value = ''
  actionError.value = ''
  try {
    await operation()
    if (dialog) dialog.value = false
    notice.value = message
    await load()
  } catch (error) {
    if (dialog) dialogError.value = error.message
    else actionError.value = error.message
  } finally {
    saving.value = false
  }
}

function saveProject() {
  const projectId = draftProjectId.value
  const target = draftTarget.value
  if (!projectId || !target || target === originalTarget.value) return
  const [kind, id] = target.split(':')
  let destination = { scope: kind }
  if (kind === 'customer') destination = { scope: 'external', organization_id: Number(id) }
  if (kind === 'individual') destination = { scope: 'external', individual_user_id: Number(id) }
  return applyChange(() => operationsOwnershipAPI.assignProject(projectId, destination), '项目归属已保存。', projectDialog)
}

function saveMembers() {
  const userIds = [...draftMemberIds.value]
  return applyChange(() => operationsOwnershipAPI.setInternalMembers(userIds), '内部成员已保存。', membersDialog)
}

function saveIndividual() {
  const id = draftIndividualId.value
  if (!id) return
  return applyChange(async () => {
    await operationsOwnershipAPI.addIndividualCustomer(id)
    await selectScope(`individual:${id}`)
  }, '独立客户已添加。', individualDialog)
}

function createCustomerGroup() {
  const customer = activeCustomer.value
  if (!customer || customer.config_group_state === 'dedicated') return
  return applyChange(
    () => operationsOwnershipAPI.createCustomerGroup(customer.id),
    `已为「${customer.name}」分配专属配置组。`,
  )
}

onMounted(load)
</script>

<style scoped>
.ownership-page {
  min-height: 100dvh;
  padding: 22px max(clamp(16px, 3.5vw, 48px), calc((100% - 1376px) / 2)) 48px;
  background: var(--bg-page);
  color: var(--text-primary);
}

h1, h2, h3, p { margin: 0; }
h1 { font-size: clamp(24px, 2.5vw, 34px); line-height: 1.2; }
h2 { font-size: 20px; line-height: 1.35; }
h3 { font-size: 16px; line-height: 1.4; }
small { color: var(--text-muted); font-size: 12px; font-weight: 400; }
.muted { color: var(--text-muted); font-size: 13px; }
.notice { margin-bottom: 12px; color: var(--success, var(--text-primary)); }
.error { margin: 10px 0; color: var(--danger, var(--text-primary)); }

.page-heading, .scope-heading, .section-heading, .project-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px 16px;
}
.page-heading { padding-bottom: 18px; }
.actions, .dialog-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dialog-actions { justify-content: flex-end; }
.dialog-actions :deep(.el-button + .el-button) { margin-left: 0; }
.editing-name { margin: 0 0 14px; font-weight: 600; overflow-wrap: anywhere; }

.button-link {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 5px 11px;
  border: 1px solid var(--border-color);
  border-radius: 7px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 13px;
  text-decoration: none;
}
.button-link:hover { border-color: var(--accent); color: var(--accent); }
.text-link { color: var(--accent); font-size: 13px; text-underline-offset: 3px; }
.scope-button:focus-visible, .button-link:focus-visible, .text-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.workspace { display: grid; grid-template-columns: minmax(205px, 248px) minmax(0, 1fr); gap: 14px; align-items: start; }
.scope-list, .scope-detail, .message-panel {
  min-width: 0;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-surface);
}
.scope-list { padding: 10px; }
.scope-section + .scope-section { border-top: 1px solid var(--border-color); margin-top: 12px; padding-top: 12px; }
.scope-section h2 { margin: 4px 8px 8px; color: var(--text-muted); font-size: 12px; font-weight: 650; }
.scope-section .external-heading { margin: 0; }
.scope-section .text-link { display: inline-block; margin: 8px 8px 1px; }
.scope-actions { gap: 4px; align-items: baseline; }
.individual-note { margin-bottom: 14px; }
.scope-empty { padding: 4px 8px; }
.scope-button {
  display: grid;
  gap: 2px;
  width: 100%;
  margin: 2px 0;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  font: inherit;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.scope-button:hover { background: var(--bg-active); }
.scope-button[aria-current] { border-color: color-mix(in srgb, var(--accent) 45%, var(--border-color)); background: var(--bg-active); }
.scope-button[aria-current] span { color: var(--accent); }
.scope-button span { font-weight: 620; }
.scope-toggle { display: flex; align-items: center; min-height: 36px; gap: 8px; font-size: 14px; }
.scope-toggle small { margin-inline-start: auto; white-space: nowrap; }
.scope-chevron { width: 7px; height: 7px; margin-inline: 3px; border: solid currentColor; border-width: 0 1.5px 1.5px 0; transform: rotate(-45deg); }
.scope-toggle[aria-expanded="true"] .scope-chevron { transform: rotate(45deg); }
.external-account-list { max-block-size: min(52dvh, 24rem); overflow-y: auto; padding: 4px; }
.pending-button { margin-top: 9px; }

.scope-detail { padding: 16px; }
.scope-heading h2, .configuration-name, .member-list li, .project-list strong { overflow-wrap: anywhere; }
.detail-section { border-top: 1px solid var(--border-color); margin-top: 14px; padding-top: 14px; }
.usage-range-label { margin-top: 4px; }
.combined-counts { display: flex; flex-wrap: wrap; gap: 12px 28px; }
.combined-counts dt { color: var(--text-muted); font-size: 13px; }
.combined-counts dd { margin: 3px 0 0; font-weight: 650; }
.section-heading h3 small { margin-inline-start: .2em; }
.configuration-name { margin-top: 4px; }
.configuration-name + .muted { margin-top: 3px; }
.member-list, .project-list { list-style: none; padding: 0; margin: 10px 0 0; }
.member-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); gap: 8px; }
.member-list li, .project-list li { min-width: 0; border-radius: 8px; padding: 8px 10px; background: var(--bg-raised); }
.member-list li, .project-list li > div { display: grid; gap: 3px; }
.member-list strong, .project-list strong { font-size: 14px; }
.project-list { display: grid; gap: 6px; }
.project-list li > div { min-width: 0; flex: 1 1 210px; }
.empty { margin-top: 8px; }
.message-panel { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 12px; margin-bottom: 12px; }

@media (max-width: 720px) {
  .workspace { grid-template-columns: minmax(0, 1fr); }
  .scope-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
  .scope-section:first-child { grid-column: 1 / -1; }
  .scope-section + .scope-section { border: 0; padding: 0; margin: 0; }
  .pending-button { align-self: end; margin-top: 0; }
}
</style>
