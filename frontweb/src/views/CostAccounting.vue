<template>
  <main class="cost-workspace">
    <header class="page-heading">
      <h1>消耗与成本</h1>
      <div class="actions">
        <router-link class="button" :to="{ path: '/admin/ownership', query: linkedRange }">客户与项目</router-link>
        <router-link class="button" :to="{ path: '/admin', query: { tab: 'projectUsage', ...linkedRange } }">项目用量</router-link>
      </div>
    </header>
    <nav class="tabs" aria-label="成本工作区">
      <button :aria-current="tab === 'query' ? 'page' : undefined" @click="showOverview">消耗概览</button>
      <button :aria-current="tab === 'reports' ? 'page' : undefined" @click="showReports">客户月报</button>
    </nav>

    <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
    <p v-if="notice" class="feedback" role="status">{{ notice }}</p>

    <div v-show="tab === 'query' && !callGroup">
      <section class="panel filters" aria-label="消耗筛选">
        <div class="filter-grid">
          <UsageDateRange class="filter-date-range" :key="dateInputKey"
            :date-from="filters.date_from" :date-to="filters.date_to"
            :disabled="filtersDisabled" @change="changeDates" />
          <UsageOwnershipFilters :range="filters" :customers="customers" :individual-customers="individualCustomers"
            :projects="projectOptions" :projects-loading="projectsLoading" :disabled="filtersDisabled" @change="chooseOwnership" />
          <label>执行用户
            <select :value="filters.user_id" aria-label="执行用户" :disabled="filtersDisabled || !currentOptions"
              @change="changeFilters({ user_id: $event.target.value })">
              <option value="">全部用户</option>
              <option v-if="currentOptions?.has_unknown_user" value="0">未知用户</option>
              <option v-for="user in userOptions" :key="user.id" :value="String(user.id)">{{ userLabel(user) }}</option>
              <option v-if="missingUser" :value="filters.user_id" disabled>{{ groupLabel('user', filters.user_id) }}</option>
            </select>
          </label>
          <label>模型
            <select :value="filters.model" :disabled="filtersDisabled || !currentOptions"
              @change="changeFilters({ model: $event.target.value })">
              <option value="">全部模型</option>
              <option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option>
              <option v-if="filters.model && !modelOptions.includes(filters.model)" :value="filters.model" disabled>{{ filters.model }}</option>
            </select>
          </label>
        </div>
        <div class="filter-footer">
          <div class="filter-notes">
            <p v-if="optionsLoading" class="muted" role="status">正在更新执行用户和模型…</p>
            <div v-else-if="optionsFailed" class="actions">
              <p role="alert">未能读取筛选选项。</p>
              <button type="button" @click="loadFilterOptions">重试</button>
            </div>
            <div v-if="filterNavigationError" class="actions">
              <p role="alert">未能应用筛选。</p>
              <button type="button" :disabled="filtersDisabled" @click="applyPendingFilters">重试</button>
            </div>
            <div v-if="filters.organization_id || filters.customer_kind" class="actions">
              <p>扣费账户 · {{ groupLabel('customer', filters.customer_kind || filters.organization_id) }}</p>
              <button type="button" :disabled="filtersDisabled" @click="changeFilters({ organization_id: '', customer_kind: '' })">清除扣费账户条件</button>
            </div>
            <div v-if="filters.drama_id && !projectOptionsScope" class="actions">
              <p>{{ groupLabel('project', filters.drama_id) }}</p>
              <button type="button" :disabled="filtersDisabled" @click="changeFilters({ drama_id: '' })">清除项目条件</button>
            </div>
          </div>
          <div class="form-actions">
            <button type="button" :disabled="filtersDisabled" :aria-pressed="!filters.date_from && !filters.date_to" @click="changeDates()">全部日期</button>
            <button type="button" :disabled="filtersDisabled" @click="reset">重置</button>
          </div>
        </div>
      </section>

      <section class="overview" aria-labelledby="cost-overview">
        <div class="section-heading">
          <h2 id="cost-overview">概览</h2>
          <p v-if="summary" class="applied-range" :class="{ 'result-hidden': overviewResultsHidden }">{{ scopeText(resultRange) }}</p>
        </div>
        <div class="overview-content">
          <p v-if="updatingResults" class="overview-state muted" role="status">正在更新消耗结果…</p>
          <p v-else-if="failedFilterApply" class="overview-state muted">结果将在筛选更新后显示。</p>
          <div v-else-if="overviewError" class="overview-state actions">
            <p role="alert">{{ overviewError }}</p>
            <button type="button" @click="query">重试</button>
          </div>
          <div v-if="summary" class="overview-data" :class="{ 'result-hidden': overviewResultsHidden }" :inert="overviewResultsHidden">
            <div class="metrics" aria-label="消耗汇总">
              <article class="metric-card metric-primary">
                <h3>已扣积分</h3>
                <div class="metric-value"><strong class="metric-number">{{ number(summary.charged_micro / 10000) }}</strong> 积分</div>
                <p class="metric-note">项目 {{ number(summary.project_charged_micro / 10000) }} · 非项目 {{ number(summary.non_project_charged_micro / 10000) }}，含已记录的补扣</p>
              </article>
              <article class="metric-card metric-secondary">
                <h3>供应商成本估算</h3>
                <div class="metric-value"><strong class="metric-number">{{ costMoney(summary.supplier_priced_calls ? summary.supplier_amount_micro : null) }}</strong></div>
                <p class="metric-note">已计价 {{ number(summary.supplier_priced_calls) }} / {{ number(summary.calls - summary.released_calls) }} 条（已排除无用量的释放记录）</p>
                <p v-if="summary.missing_usage_calls || summary.missing_price_calls || summary.unverified_calls" class="coverage-links">
                  <button v-if="summary.missing_usage_calls" type="button" @click="openCalls('status', 'missing_usage', $event)">缺用量 {{ number(summary.missing_usage_calls) }} 条</button>
                  <button v-if="summary.missing_price_calls" type="button" @click="openCalls('status', 'missing_price', $event)">缺价格或规格 {{ number(summary.missing_price_calls) }} 条</button>
                  <button v-if="summary.unverified_calls" type="button" @click="openCalls('status', 'unverified', $event)">待核实 {{ number(summary.unverified_calls) }} 条</button>
                </p>
              </article>
            </div>
            <div class="usage-strip" aria-label="实际用量">
              <span>业务记录 <strong>{{ number(summary.calls) }} 条</strong></span>
              <span>用量 <strong>{{ number(summary.total_tokens) }} Token</strong></span>
              <span>图片 <strong>{{ number(summary.image) }} 张</strong></span>
              <span>处理时长 <strong>{{ number(summary.millisecond / 1000 + summary.second) }} 秒</strong></span>
              <details class="usage-breakdown">
                <summary>用量详情</summary>
                <p>输入 {{ number(summary.input_token) }}<template v-if="summary.input_image_token"> · {{ meterNames.input_image_token }} {{ number(summary.input_image_token) }}</template> · 缓存 {{ number(summary.cache_token) }} · 输出 {{ number(summary.output_token) }} Token（其中视频 {{ number(summary.video_output_token) }}）</p>
                <p>字符 {{ number(summary.character) }} · 处理中或待对账 {{ number(summary.processing_calls) }} 条 · 已释放且无用量 {{ number(summary.released_calls) }} 条</p>
              </details>
            </div>
          </div>
        </div>
      </section>

      <section v-if="summary" class="panel breakdown" aria-labelledby="cost-breakdown">
        <div class="section-heading">
          <h2 id="cost-breakdown" ref="breakdownHeading" tabindex="-1">{{ overviewView === 'all' ? '逐笔明细' : '消耗构成' }}</h2>
          <div class="actions">
            <label>查看方式<select ref="overviewViewControl" :value="overviewView" :aria-disabled="breakdownControlsDisabled" @change="changeOverviewView">
              <option value="all">全部明细</option>
              <option v-for="g in groups" :key="g.key" :value="g.key">按{{ g.label }}</option>
            </select></label>
          </div>
        </div>
        <div class="breakdown-content">
          <div class="breakdown-data" :class="{ 'result-hidden': overviewResultsHidden }" :inert="overviewResultsHidden">
            <p v-if="!overviewResults.total" class="muted">当前范围内无记录。</p>
            <div v-else class="table-scroll" tabindex="0" :aria-label="resultView === 'all' ? '全部明细表' : '消耗构成表'">
              <CostActivityRecords v-if="resultView === 'all'" :items="overviewResults.items" @inspect="openCall" />
              <table v-else>
                <thead><tr><th>{{ groups.find(g => g.key === resultView)?.label }}</th><th>{{ showProjectOwners ? '项目负责人 / 执行用户' : '执行用户' }}</th><th>业务记录</th><th>供应商成本估算</th><th>已扣积分</th><th v-if="filterableGroups.includes(resultView)">操作</th></tr></thead>
                <tbody>
                  <tr v-for="row in overviewResults.items" :key="row.key">
                    <td>{{ groupDisplay(row) }}</td>
                    <td>
                      <div v-for="person in groupPeople(row).slice(0, 2)" :key="person.id" class="cost-owner">
                        <strong v-if="person.display_name">{{ person.display_name }}</strong>
                        <small v-if="person.display_name">{{ person.username || `用户 #${person.id}（用户名不可用）` }}</small>
                        <span v-else>{{ person.username || `用户 #${person.id}（用户名不可用）` }}</span>
                      </div>
                      <small v-if="groupPeople(row).length > 2">另有 {{ groupPeople(row).length - 2 }} 位{{ groupUsesProjectOwner(row) ? '项目所有者' : '执行用户' }}</small>
                      <span v-if="groupHasUnknownPerson(row) || !groupPeople(row).length" class="muted">{{ groupUsesProjectOwner(row) ? '未知项目所有者' : '未知执行用户' }}</span>
                    </td>
                    <td>{{ number(row.calls) }}</td>
                    <td>{{ costMoney(row.supplier_priced_calls ? row.supplier_amount_micro : null) }}<small>{{ number(row.supplier_priced_calls) }} 条已计价</small></td>
                    <td>{{ number(row.charged_micro / 10000) }}</td>
                    <td v-if="filterableGroups.includes(resultView)">
                      <button :disabled="busy" @click="openCalls(resultView, row.key, $event)">查看明细</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div v-if="overviewResultsHidden" class="breakdown-feedback">
            <div class="breakdown-message actions">
              <p v-if="updatingResults" class="muted" aria-hidden="true">正在读取表格…</p>
              <p v-else-if="failedFilterApply" class="muted">结果将在筛选更新后显示。</p>
              <template v-else>
                <p class="muted">表格读取失败。</p>
                <button type="button" @click="retryOverview(overviewViewControl)">重试表格</button>
              </template>
            </div>
          </div>
        </div>
        <div v-if="overviewResults.total" class="pagination">
          <button :aria-disabled="breakdownControlsDisabled || overviewPage <= 1" @click="changeOverviewPage(-1)">上一页</button>
          <div class="breakdown-page-state">
            <span :class="{ 'result-hidden': overviewResultsHidden }">第 {{ overviewPage }} 页 · {{ number(overviewResults.total) }} {{ resultView === 'all' ? '条' : '组' }}</span>
            <span v-if="updatingResults" aria-hidden="true">正在读取…</span>
            <button v-else-if="overviewError && !failedFilterApply" type="button" @click="retryOverview(nextPageControl)">重试本页</button>
          </div>
          <button ref="nextPageControl" :aria-disabled="breakdownControlsDisabled || overviewPage * pageSize >= overviewResults.total" @click="changeOverviewPage(1)">下一页</button>
        </div>
      </section>

      <details class="panel price-status">
        <summary>供应商价格与统计口径<span class="muted">
          {{ supplierPrices?.latest ? `最近价格 ${supplierPrices.latest.day}` : '尚无价格快照' }}
          <span v-if="supplierPrices?.latest && supplierPrices.latest.day !== today" class="warning"> · 今日价格尚未获取</span>
        </span></summary>
        <div class="price-body">
          <p>供应商成本按实际用量和调用当日的供应商价格估算。当日缺价时使用调用日前最近的价格。平台积分扣费独立展示。</p>
          <p>插帧 ¥0.60/分钟，画质增强 ¥2.50/分钟，按实际处理时长计算。</p>
          <p>全部时间为北京时间。已结算按结算时间，未结算账本记录按预授权时间。独立供应商记录按提交时间。</p>
          <p v-if="summary" :class="{ 'result-hidden': overviewResultsHidden }">沿用旧价格 {{ number(summary.supplier_stale_calls) }} 条 · 固定费率 {{ number(summary.supplier_fixed_calls) }} 条。</p>
          <p v-if="supplierPrices?.error" class="warning">{{ supplierPrices.error }}。仍可使用最近成功的价格估算。</p>
          <button :disabled="busy || priceRefreshing || supplierPrices?.status === 'completed'" @click="syncPrices">
            {{ priceRefreshing ? '正在获取价格…' : supplierPrices?.status === 'completed' ? '今日价格已获取' : '获取今日价格' }}
          </button>
        </div>
      </details>
    </div>

    <section v-if="tab === 'query' && callGroup" class="panel calls-view" aria-labelledby="cost-calls" :aria-busy="callsBusy">
      <header class="calls-heading">
        <button @click="leaveCalls">{{ resultView === 'all' ? '返回全部明细' : '返回消耗构成' }}</button>
        <h2 id="cost-calls" ref="callsHeading" tabindex="-1">消耗明细<span v-if="callGroup !== 'all'"> · {{ groupLabel(callGroup, callKey) }}</span></h2>
        <p class="applied-range">{{ scopeText(callFilters) }}</p>
      </header>
      <div v-if="callViews.length > 1" class="actions call-views" role="group" aria-label="明细查看方式">
        <button v-for="view in callViews" :key="view.key" :aria-pressed="callView === view.key" @click="changeCallView(view.key)">{{ view.label }}</button>
      </div>
      <p v-if="callsBusy" role="status">正在读取{{ callViewLabel }}…</p>
      <div v-else-if="callsError" class="feedback error" role="alert">
        <p>{{ callsError }}</p><button @click="loadCalls">重试</button>
      </div>
      <p v-else-if="!callResults.total" class="muted">当前范围内无记录。</p>
      <div v-else-if="callView === 'records'" class="table-scroll" tabindex="0" aria-label="逐笔记录表">
        <CostActivityRecords :items="callResults.items" @inspect="openCall" />
      </div>
      <div v-else class="table-scroll" tabindex="0" :aria-label="callViewLabel + '表'">
        <table class="call-summary-table">
          <thead><tr><th>{{ detailGroupTitles[callView] }}</th><th>业务记录</th><th>供应商成本估算</th><th>已扣积分</th></tr></thead>
          <tbody>
            <tr v-for="row in callResults.items" :key="row.key">
              <td>{{ detailGroupLabel(row) }}</td>
              <td>{{ number(row.calls) }}</td>
              <td>{{ costMoney(row.supplier_priced_calls ? row.supplier_amount_micro : null) }}<small>{{ number(row.supplier_priced_calls) }} 条已计价</small></td>
              <td>{{ number(row.charged_micro / 10000) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!callsBusy && !callsError && callResults.total" class="pagination">
        <button :disabled="callPage <= 1" @click="changeCallPage(-1)">上一页</button>
        <span>第 {{ callPage }} 页 · {{ number(callResults.total) }} {{ callView === 'records' ? '条' : '组' }}</span>
        <button :disabled="callPage * pageSize >= callResults.total" @click="changeCallPage(1)">下一页</button>
      </div>
    </section>

    <dialog ref="detailPanel" class="call-drawer" aria-labelledby="call-detail" @close="afterDetailClose">
      <header class="drawer-heading">
        <h2 id="call-detail">调用依据</h2>
        <button autofocus @click="detailPanel.close()">关闭详情</button>
      </header>
      <div class="drawer-content" tabindex="0" aria-label="调用依据内容">
        <p v-if="detailBusy" role="status">正在读取调用依据…</p>
        <p v-else-if="detailError" class="feedback error" role="alert">{{ detailError }}</p>
        <template v-else-if="detail">
          <p>{{ detail.project_title || '非项目操作' }} · {{ detail.model }}</p>
          <dl>
            <dt>业务记录</dt><dd>{{ detail.id }}</dd>
            <template v-if="detail.ops_scope">
              <dt>消耗归属</dt><dd>{{ activityOwnership(detail) }}</dd>
              <dt>扣费账户</dt><dd>{{ billingAccountLabel(detail) }}</dd>
            </template>
            <dt>功能 / 操作来源</dt><dd>{{ sourceKindLabel(detail.source_kind) }}<small v-if="detail.source_id">来源记录 ID：{{ detail.source_id }}</small></dd>
            <dt>服务</dt><dd>{{ serviceTypeLabel(detail.service_type) }}</dd>
            <dt>已有 AI 连接</dt><dd>{{ detail.config_name || '历史记录未保存连接归属' }}<small v-if="detail.config_id">配置 #{{ detail.config_id }} · 共享连接 {{ detail.connection_id || '未使用' }} · {{ detail.provider || '未知供应商' }}</small></dd>
            <dt>供应商请求</dt><dd>{{ detail.provider_request_id || '未保存' }}</dd>
            <dt>价格适用时间</dt><dd>{{ chinaTime(detail.price_at) }}</dd>
            <dt>供应商成本估算</dt><dd>{{ costMoney(detail.supplier_amount_micro) }}<small>{{ detail.reason }}</small></dd>
            <dt>原扣费 / 关联补扣</dt><dd>{{ detail.original_charged_micro == null ? '未结算' : number(detail.original_charged_micro / 10000) }} / {{ number(detail.supplement_micro / 10000) }} 积分</dd>
            <dt>供应商价格依据</dt><dd>{{ detail.supplier?.source_label || '尚无可用价格' }}<small v-if="detail.supplier?.price_day">{{ detail.supplier.price_day }}{{ detail.supplier.stale ? ' · 沿用此前价格' : '' }}</small></dd>
          </dl>
          <h3>供应商价格与实际用量</h3>
          <p v-if="!detail.supplier?.rates?.length">{{ detail.reason }}</p>
          <div v-else class="table-scroll" tabindex="0" aria-label="供应商计费明细">
            <table>
              <thead><tr><th>计量</th><th>实际 / 计费数量</th><th>单价（元） / 单位数量</th><th>规格</th><th>估算小计（元）</th></tr></thead>
              <tbody><tr v-for="r in detail.supplier.rates" :key="r.meter"><td>{{ meterNames[r.meter] || r.meter }}</td><td>{{ number(r.quantity) }} / {{ number(r.billable_quantity) }}</td><td>{{ number(r.unit_price_cny) }} / {{ r.unit_size }}</td><td>{{ r.rate_id || '标准' }}</td><td>{{ costMoney(r.subtotal_micro) }}</td></tr></tbody>
            </table>
          </div>
          <details><summary>供应商价格快照与调用规格</summary><pre>{{ JSON.stringify({ pricing_context: detail.pricing_context, supplier: detail.supplier, usage_evidence: detail.usage_evidence }, null, 2) }}</pre></details>
          <details><summary>平台积分依据</summary><p>{{ detail.platform_reason }}</p><pre>{{ JSON.stringify(detail.rates, null, 2) }}</pre></details>
          <details v-if="detail.attempts.length">
            <summary>调用尝试与旧成本修订（不重复计入汇总）</summary>
            <article v-for="a in detail.attempts" :key="a.id" class="revision">
              <p>{{ a.origin === 'historical_summary' ? '旧历史补录' : `尝试 ${a.attempt}` }} · {{ a.model }} · {{ chinaTime(a.submitted_at) }}</p>
              <p v-for="r in a.revisions" :key="r.id">旧修订 #{{ r.id }}：{{ costMoney(r.amount_micro, r.currency || 'CNY') }} · {{ r.price?.source || '无价格' }} · {{ r.reason }}</p>
            </article>
          </details>
        </template>
      </div>
    </dialog>


    <template v-if="tab === 'reports'">
      <section class="panel"><h2>客户月报</h2><p>保存每日供应商价格口径的成本月报，冻结用量、价格日期与估算金额。旧版本保持原值。</p><form class="inline-form" @submit.prevent="saveReport"><label>客户<select v-model="reportForm.organization_id" required><option value="">请选择客户</option><option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option></select></label><label>自然月<input v-model="reportForm.month" type="month" required></label><button class="primary" :disabled="busy">保存月报新版本</button></form></section>
      <section class="panel">
        <h2>已保存版本</h2>
        <p v-if="!reportsLoaded && !reportsError" role="status">正在读取月报…</p>
        <p v-else-if="reportsError" class="warning">{{ reportsError }} <button @click="loadReports">重试</button></p>
        <p v-else-if="!reports.length">尚无月报</p>
        <div v-else class="table-scroll" tabindex="0" aria-label="已保存月报表">
          <table>
            <thead><tr><th>客户</th><th>月份 / 版本</th><th>保存时间</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="r in reports" :key="r.id">
                <td>{{ customers.find(c => c.id === r.organization_id)?.name || `客户 #${r.organization_id}` }}</td>
                <td>{{ r.month }} · v{{ r.version }}</td>
                <td>{{ chinaTime(r.generated_at) }}</td>
                <td><button :disabled="busy" @click="showReport(r.id)">查看月报</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section v-if="report" class="panel"><h2>{{ report.summary.organization_name }} · {{ report.month }} · v{{ report.version }}</h2><template v-if="report.summary.basis === 'supplier_daily_v1'"><p>每日供应商价格估算 · {{ report.summary.calls }} 条业务记录</p><p>供应商成本估算 {{ costMoney(report.summary.supplier_priced_calls ? report.summary.supplier_amount_micro : null) }} · {{ report.summary.supplier_priced_calls }} 条已计价</p><p>沿用旧价格 {{ report.summary.supplier_stale_calls }} 条 · 固定费率 {{ report.summary.supplier_fixed_calls }} 条 · 缺价格或规格 {{ report.summary.missing_price_calls }} 条</p><p>原平台扣费 {{ number(report.summary.charged_micro / 10000) }} 积分</p></template><template v-else-if="report.summary.basis === 'billing_activity_v1'"><p>旧版平台价目复算（不代表供应商成本） · {{ report.summary.calls }} 条业务记录</p><p>模型计价折合 {{ costMoney(report.summary.calculated_calls ? report.summary.model_amount_micro : null) }} · 供应商费率估算 {{ costMoney(report.summary.supplier_priced_calls ? report.summary.supplier_amount_micro : null) }}（{{ report.summary.supplier_priced_calls }} 条有来源）</p><p>原扣费 {{ number(report.summary.charged_micro / 10000) }} 积分</p></template><p v-else>旧版独立成本规则快照：{{ costMoney(report.summary.cny_micro) }} · {{ report.summary.calls }} 条。此版本保留原值，与当前原调用口径不同。</p><div class="actions"><a class="button" :href="exportUrl(false)">导出汇总 CSV</a><a class="button" :href="exportUrl(true)">导出明细 CSV</a></div></section>
    </template>
  </main>
</template>
<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CostActivityRecords from './CostActivityRecords.vue'
import UsageDateRange from '@/components/UsageDateRange.vue'
import UsageOwnershipFilters from '@/components/UsageOwnershipFilters.vue'
import { costsAPI as api } from '@/api/costs'
import { adminAPI } from '@/api/account'
import { chinaTime, costMoney, meterNames, sourceKindLabel, serviceTypeLabel } from '@/utils/costPresentation'
import { ownershipLabels, activityOwnership, billingAccountLabel } from '@/utils/costOwnership'
import { defaultUsageDates, readUsageRange, usageDateLabel, usageProjectOptionsScope, usageRangeParams, usageRangeQuery } from '@/utils/operationsUsageQuery'

const route = useRoute()
const router = useRouter()
const today = defaultUsageDates().date_to
const basis = 'supplier_daily_v1'
const pageSize = 20
const groups = [
  { key: 'project', label: '项目' }, { key: 'ops_customer', label: '归属客户' },
  { key: 'customer', label: '扣费账户' }, { key: 'user', label: '用户' },
  { key: 'model', label: '模型' }, { key: 'operation', label: '功能来源' },
  { key: 'hour', label: '小时' }, { key: 'day', label: '日期' }, { key: 'month', label: '月份' },
]
const filterableGroups = ['ops_customer', 'customer', 'project', 'user', 'model', 'operation']
const groupFields = { project: 'drama_id', user: 'user_id', model: 'model', operation: 'source_kind', status: 'cost_status' }
const costStatuses = { calculated: '成本已计价', missing_usage: '缺实际用量', missing_price: '缺供应商价格或规格', released: '已释放且无用量', unverified: '待核实' }
const detailGroupTitles = { user: '执行用户', operation: '功能来源', day: '日期', month: '月份' }
const additionalFilterKeys = ['organization_id', 'user_id', 'model', 'source_kind', 'cost_status', 'customer_kind']
const defaultView = range => range.ops_scope === 'external' && !range.ops_customer_id && !range.ops_individual_id ? 'ops_customer' : 'project'
const number = value => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 4 })
const pageNumber = value => Math.max(1, Number.parseInt(value, 10) || 1)
const customerLabel = value => ({ personal: '个人账户', unknown: '未知客户' })[value] || value
const emptyPage = () => ({ items: [], total: 0 })

function readFilters(query = {}) {
  return {
    ...readUsageRange(query),
    ...Object.fromEntries(additionalFilterKeys.map(key => [key, typeof query[key] === 'string' ? query[key] : ''])),
  }
}

function additionalParams(range) {
  return Object.fromEntries(additionalFilterKeys.filter(key => range[key] !== '').map(key => [key, range[key]]))
}

function scopedOptionParams(range) {
  const { organization_id, customer_kind } = range
  return {
    ...usageRangeParams(range),
    ...(organization_id ? { organization_id } : {}),
    ...(customer_kind ? { customer_kind } : {}),
  }
}

const applied = computed(() => readFilters(route.query))
const appliedKey = computed(() => JSON.stringify(applied.value))
const filters = reactive({ ...applied.value })
const dateInputReset = ref(0)
const dateInputKey = computed(() => [
  filters.ops_scope, filters.ops_customer_id, filters.ops_individual_id, filters.drama_id, dateInputReset.value,
].join(':'))
const pendingFilterApply = ref(false)
const navigatingFilters = ref(false)
const filterNavigationError = ref(false)
const resultRange = ref(applied.value)
const tab = ref('query')
const taskBusy = ref(false)
const filtersDisabled = computed(() => taskBusy.value || navigatingFilters.value)
const overviewLoading = ref(false)
const overviewError = ref('')
const busy = computed(() => taskBusy.value || overviewLoading.value)
const error = ref('')
const notice = ref('')
const summary = ref(null)
const overviewResults = ref(emptyPage())
const routeView = computed(() => route.query.group_by === 'all' ? 'all' : groups.find(group => group.key === route.query.group_by)?.key || defaultView(applied.value))
const overviewView = ref(routeView.value)
const overviewViewControl = ref(null)
const nextPageControl = ref(null)
const overviewPage = computed(() => pageNumber(route.query.group_page))
const overviewKey = computed(() => JSON.stringify(overviewQuery()))
const resultView = ref(routeView.value)
const supplierPrices = ref(null)
const priceRefreshing = ref(false)

const customers = ref([])
const individualCustomers = ref([])
const projectNames = reactive(new Map())
const userNames = reactive(new Map())
const resolvedOptions = shallowRef(null)
const optionsFailedKey = ref('')
const optionParams = computed(() => scopedOptionParams(filters))
const optionKey = computed(() => JSON.stringify(optionParams.value))
const projectOptionsScope = computed(() => usageProjectOptionsScope(filters))
const projectOptionsKey = computed(() => JSON.stringify(projectOptionsScope.value))
const currentOptions = computed(() => resolvedOptions.value?.key === optionKey.value ? resolvedOptions.value.data : null)
const optionsFailed = computed(() => optionsFailedKey.value === optionKey.value)
const optionsLoading = computed(() => !currentOptions.value && !optionsFailed.value)
const failedFilterApply = computed(() => pendingFilterApply.value && (optionsFailed.value || filterNavigationError.value))
const updatingResults = computed(() => overviewLoading.value || (pendingFilterApply.value && !failedFilterApply.value))
const overviewResultsHidden = computed(() => updatingResults.value || failedFilterApply.value || Boolean(overviewError.value))
const breakdownControlsDisabled = computed(() => taskBusy.value || overviewResultsHidden.value)
const projectOptions = computed(() => resolvedOptions.value?.projectKey === projectOptionsKey.value ? resolvedOptions.value.data.projects || [] : [])
const projectsLoading = computed(() => optionsLoading.value && resolvedOptions.value?.projectKey !== projectOptionsKey.value)
const userOptions = computed(() => currentOptions.value?.users || [])
const modelOptions = computed(() => currentOptions.value?.models || [])
const reports = ref([])
const report = ref(null)
const reportsLoaded = ref(false)
const reportsError = ref('')
const reportForm = reactive({ organization_id: '', month: today.slice(0, 7) })
const missingUser = computed(() => filters.user_id && !hasUserOption(filters.user_id))
const callGroup = computed(() => {
  const group = route.query.calls
  const key = route.query.call_key
  if (group === 'all') return group
  if (group === 'status') return typeof key === 'string' && Object.hasOwn(costStatuses, key) ? group : ''
  return filterableGroups.includes(group) && typeof key === 'string' && key ? group : ''
})
const callKey = computed(() => callGroup.value === 'user' && applied.value.user_id ? applied.value.user_id : route.query.call_key || '')
const callPage = computed(() => pageNumber(route.query.call_page))
const callFilters = computed(() => ({ ...applied.value, ...groupFilter(callGroup.value, callKey.value) }))
const linkedRange = computed(() => usageRangeQuery(callGroup.value ? callFilters.value : filters))
const callViews = computed(() => {
  const views = [{ key: 'records', label: '逐笔记录' }]
  if (!callFilters.value.user_id) views.push({ key: 'user', label: '按用户汇总' })
  if (callGroup.value === 'project' && callKey.value === 'unknown') {
    views.push({ key: 'operation', label: '按来源汇总' })
  }
  if (callGroup.value === 'project') {
    views.push({ key: 'day', label: '按日汇总' }, { key: 'month', label: '按月汇总' })
  }
  return views
})
const selectedCallView = computed(() => callViews.value.find(view => view.key === route.query.call_view) || callViews.value[0])
const callView = computed(() => selectedCallView.value.key)
const callViewLabel = computed(() => selectedCallView.value.label)
const callResults = ref(emptyPage())
const callsBusy = ref(false)
const callsError = ref('')
const callsHeading = ref(null)
const breakdownHeading = ref(null)
const detail = ref(null)
const detailBusy = ref(false)
const detailError = ref('')
const detailPanel = ref(null)
let detailOrigin = null
let callOrigin = null
let callOriginOverview = ''
let overviewScroll = 0
let overviewRequest = 0
let callsRequest = 0
let detailRequest = 0
let optionsRequest = 0
let pricePoll = null
let disposed = false

function groupFilter(group, key) {
  if (group === 'ops_customer') {
    if (key === 'internal' || key === 'pending') return { ops_scope: key, ops_customer_id: '', ops_individual_id: '' }
    if (key.startsWith('individual:')) return { ops_scope: 'external', ops_customer_id: '', ops_individual_id: key.slice('individual:'.length) }
    return { ops_scope: 'external', ops_customer_id: key, ops_individual_id: '' }
  }
  if (group === 'customer') {
    const unassigned = key === 'personal' || key === 'unknown'
    return { organization_id: unassigned ? '0' : key, customer_kind: unassigned ? key : '' }
  }
  const field = groupFields[group]
  return field ? { [field]: key === 'unknown' ? '0' : key } : {}
}

function userLabel({ id, username, display_name }) {
  if (username && display_name && username !== display_name) return `${display_name}（${username}）`
  return display_name || username || `用户 #${id}`
}

function hasUserOption(id) {
  if (id === '0') return currentOptions.value?.has_unknown_user
  return userOptions.value.some(user => String(user.id) === id)
}

function groupLabel(group, key) {
  if (group === 'status') return costStatuses[key]
  if (group === 'ops_customer') {
    if (key.startsWith('individual:')) {
      const id = key.slice('individual:'.length)
      return individualCustomers.value.find(c => String(c.id) === id)?.name || `独立客户 #${id}`
    }
    if (key === 'external') return '外部客户合计'
    return ownershipLabels[key] || customers.value.find(c => String(c.id) === key)?.name || `客户 #${key}`
  }
  if (group === 'customer') {
    if (key === '0') return '个人账户或未知客户'
    return customers.value.find(c => String(c.id) === key)?.name || (['personal', 'unknown'].includes(key) ? customerLabel(key) : `客户 #${key}`)
  }
  if (group === 'project') {
    if (key === '0' || key === 'unknown') return '非项目操作'
    return projectNames.get(key) || `项目 #${key}`
  }
  if (group === 'user') {
    if (key === '0' || key === 'unknown') return '未知用户'
    return userNames.get(key) || `用户 #${key}`
  }
  if (group === 'operation') return sourceKindLabel(key === '0' || key === 'unknown' ? null : key)
  return key
}

function scopeText(range) {
  const ownership = range.ops_individual_id ? `individual:${range.ops_individual_id}` : range.ops_customer_id || range.ops_scope || 'all'
  const selected = [
    groupLabel('ops_customer', ownership),
    (range.customer_kind || range.organization_id) && `扣费账户 ${groupLabel('customer', range.customer_kind || range.organization_id)}`,
    range.drama_id && groupLabel('project', range.drama_id),
    range.user_id && `执行用户 ${groupLabel('user', range.user_id)}`,
    range.model,
    range.source_kind && groupLabel('operation', range.source_kind),
    range.cost_status && costStatuses[range.cost_status],
  ].filter(Boolean)
  const dates = usageDateLabel(range)
  return [range.date_from || range.date_to ? `${dates}（北京时间）` : dates, ...selected].join(' · ')
}

const showProjectOwners = computed(() => resultView.value === 'project' && !resultRange.value.user_id)
const groupUsesProjectOwner = row => showProjectOwners.value && row.key !== 'unknown'
const groupPeople = row => groupUsesProjectOwner(row) ? row.owners || [] : row.executors || []
const groupHasUnknownPerson = row => groupUsesProjectOwner(row) ? row.has_unknown_owner : row.has_unknown_executor
function groupDisplay(row) {
  if (resultView.value === 'project' && row.key === 'unknown') return '非项目操作'
  if (resultView.value === 'operation') return groupLabel('operation', row.key)
  return row.label
}

function executorLabel(row) {
  if (row.key === 'unknown') return '未知用户'
  const executor = row.executors?.[0]
  return executor?.display_name || executor?.username || row.label
}

function detailGroupLabel(row) {
  if (callView.value === 'user') return executorLabel(row)
  if (callView.value === 'operation') return groupLabel('operation', row.key)
  return row.label
}

function overviewQuery(range = applied.value, view = routeView.value, page = overviewPage.value) {
  return {
    ...usageRangeQuery(range),
    ...additionalParams(range),
    group_by: view === defaultView(range) ? undefined : view,
    group_page: page > 1 ? String(page) : undefined,
  }
}

async function perform(action, message = '') {
  if (busy.value) return
  taskBusy.value = true
  error.value = ''
  notice.value = ''
  try {
    await action()
    notice.value = message
  } catch (e) {
    error.value = e.message || '读取失败，请重试'
  } finally {
    taskBusy.value = false
  }
}

async function query() {
  const requestId = ++overviewRequest
  const routeKey = overviewKey.value
  const range = applied.value
  const view = routeView.value
  const requestedPage = overviewPage.value
  const pagination = view === 'all'
    ? { page: requestedPage }
    : { group_by: view, group_page: requestedPage }
  overviewLoading.value = true
  overviewError.value = ''
  error.value = ''
  notice.value = ''
  try {
    const result = await api.activity({ ...usageRangeParams(range), ...additionalParams(range), basis, time_order: 'desc', ...pagination })
    if (requestId !== overviewRequest || routeKey !== overviewKey.value) return
    supplierPrices.value = result.supplier_prices
    watchPrices()
    summary.value = result.summary
    overviewResults.value = view === 'all' ? result.calls : result.breakdown
    resultRange.value = range
    resultView.value = view
  } catch (e) {
    if (requestId !== overviewRequest || routeKey !== overviewKey.value) return
    overviewError.value = e.message || '读取消耗结果失败，请重试'
  } finally {
    if (requestId === overviewRequest) overviewLoading.value = false
  }
}

function load(range = applied.value, requestedPage = overviewPage.value) {
  const destination = overviewQuery(range, overviewView.value, requestedPage)
  if (JSON.stringify(destination) === overviewKey.value) return query()
  return router.replace({ query: destination })
}

async function applyPendingFilters() {
  if (!pendingFilterApply.value || !currentOptions.value || navigatingFilters.value) return
  if (optionKey.value !== JSON.stringify(scopedOptionParams(applied.value))) {
    if (filters.user_id && !hasUserOption(filters.user_id)) filters.user_id = ''
    if (filters.model && !modelOptions.value.includes(filters.model)) filters.model = ''
  }
  const range = { ...filters }
  let view = routeView.value
  if (['project', 'ops_customer'].includes(view) &&
    (range.ops_scope !== applied.value.ops_scope || range.ops_customer_id !== applied.value.ops_customer_id || range.ops_individual_id !== applied.value.ops_individual_id)) {
    view = defaultView(range)
  }
  const destination = overviewQuery(range, view, 1)
  if (JSON.stringify(destination) === overviewKey.value) {
    pendingFilterApply.value = false
    return
  }
  filterNavigationError.value = false
  navigatingFilters.value = true
  try {
    const failure = await router.push({ query: destination })
    if (failure && pendingFilterApply.value) filterNavigationError.value = true
  } catch {
    filterNavigationError.value = true
  } finally {
    navigatingFilters.value = false
  }
}

function changeFilters(patch, resetPage = false) {
  if (filtersDisabled.value) return
  if (!resetPage && Object.keys(patch).every(key => patch[key] === filters[key])) return
  Object.assign(filters, patch)
  filterNavigationError.value = false
  pendingFilterApply.value = true
  return applyPendingFilters()
}

function chooseOwnership(patch) {
  if (Object.hasOwn(patch, 'ops_scope') || Object.hasOwn(patch, 'ops_customer_id') || Object.hasOwn(patch, 'ops_individual_id')) {
    return changeFilters({ organization_id: '', customer_kind: '', ...patch })
  }
  return changeFilters(patch)
}

function changeDates(range) {
  const { date_from = '', date_to = '' } = range || {}
  if (Boolean(date_from) !== Boolean(date_to)) return
  if (!range) dateInputReset.value++
  return changeFilters({ date_from, date_to })
}

function changeOverviewView(event) {
  if (breakdownControlsDisabled.value) {
    event.target.value = overviewView.value
    return
  }
  overviewView.value = event.target.value
  return load(applied.value, 1)
}

function changeOverviewPage(delta) {
  const nextPage = overviewPage.value + delta
  if (breakdownControlsDisabled.value || nextPage < 1 || (nextPage - 1) * pageSize >= overviewResults.value.total) return
  return load(applied.value, nextPage)
}

function retryOverview(focusTarget) {
  focusTarget?.focus({ preventScroll: true })
  return query()
}

function reset() {
  dateInputReset.value++
  return changeFilters(readFilters(), true)
}

function openCalls(group, key, event) {
  callOrigin = event.currentTarget
  callOriginOverview = overviewKey.value
  overviewScroll = window.scrollY
  return router.push({
    query: { ...overviewQuery(), calls: group, call_key: key || undefined },
    state: { costOverview: true },
  })
}

function leaveCalls() {
  if (router.options.history.state.costOverview) router.back()
  else return router.replace({ query: overviewQuery() })
}

function showOverview() {
  tab.value = 'query'
  if (callGroup.value) leaveCalls()
}

function showReports() {
  tab.value = 'reports'
  if (callGroup.value) leaveCalls()
}

async function loadCalls() {
  const requestId = ++callsRequest
  const view = callView.value
  const pagination = view === 'records'
    ? { page: callPage.value }
    : { group_by: view, group_page: callPage.value }
  callsBusy.value = true
  callsError.value = ''
  try {
    const range = callFilters.value
    const result = await api.activity({ ...usageRangeParams(range), ...additionalParams(range), basis, time_order: 'desc', ...pagination })
    if (requestId === callsRequest) callResults.value = view === 'records' ? result.calls : result.breakdown
  } catch (e) {
    if (requestId === callsRequest) callsError.value = e.message || '明细读取失败'
  } finally {
    if (requestId === callsRequest) callsBusy.value = false
  }
}

function changeCallView(view) {
  if (view === callView.value) return
  return router.replace({
    query: { ...route.query, call_view: view === 'records' ? undefined : view, call_page: undefined },
  })
}

function changeCallPage(delta) {
  const nextPage = callPage.value + delta
  return router.replace({ query: { ...route.query, call_page: nextPage > 1 ? String(nextPage) : undefined } })
}

watch([callGroup, callKey, callPage, callView, appliedKey], async ([group, key], previous) => {
  if (!group) {
    callsRequest++
    if (!previous?.[0]) return
    await nextTick()
    if (tab.value === 'query') {
      if (callOrigin?.isConnected && callOriginOverview === overviewKey.value) {
        window.scrollTo({ top: overviewScroll, behavior: 'instant' })
        callOrigin.focus({ preventScroll: true })
      } else {
        breakdownHeading.value?.focus()
      }
    }
    return
  }
  callsBusy.value = true
  if (group !== previous?.[0] || key !== previous?.[1]) {
    tab.value = 'query'
    await nextTick()
    window.scrollTo({ top: 0, behavior: 'instant' })
    callsHeading.value?.focus({ preventScroll: true })
  }
  if (callGroup.value) await loadCalls()
}, { immediate: true })

async function openCall(id, event) {
  detailOrigin = event.currentTarget
  const requestId = ++detailRequest
  detail.value = null
  detailBusy.value = true
  detailError.value = ''
  detailPanel.value.showModal()
  try {
    const record = await api.activityDetail(id, { basis, ops_scope: 'all' })
    if (requestId === detailRequest) detail.value = record
  } catch (e) {
    if (requestId === detailRequest) detailError.value = e.message || '调用依据读取失败'
  } finally {
    if (requestId === detailRequest) detailBusy.value = false
  }
}

function afterDetailClose() {
  detailRequest++
  detailOrigin?.focus({ preventScroll: true })
  detailOrigin = null
}

function saveReport() {
  return perform(async () => {
    report.value = await api.saveReport({ ...reportForm, basis })
    await loadReports()
  }, '月报新版本已保存。')
}

function showReport(id) {
  return perform(async () => { report.value = await api.report(id) })
}

function exportUrl(detailRows) {
  return `/api/v1/admin/costs/reports/${encodeURIComponent(report.value.id)}/export?detail=${detailRows}`
}

function watchPrices() {
  priceRefreshing.value = supplierPrices.value?.status === 'processing'
  if (priceRefreshing.value && !pricePoll && !disposed) pricePoll = setTimeout(pollPrices, 2500)
}

async function pollPrices() {
  pricePoll = null
  if (disposed) return
  try {
    supplierPrices.value = await api.supplierPrices()
    watchPrices()
    if (!priceRefreshing.value && !busy.value && !pendingFilterApply.value) await query()
  } catch (e) {
    priceRefreshing.value = false
    error.value = e.message || '无法读取价格状态，请刷新'
  }
}

function syncPrices() {
  return perform(async () => {
    supplierPrices.value = await api.syncSupplierPrices()
    watchPrices()
    if (!priceRefreshing.value) await query()
  })
}

watch(overviewKey, () => {
  if (route.name !== 'admin-costs') return
  pendingFilterApply.value = false
  filterNavigationError.value = false
  Object.assign(filters, applied.value)
  overviewView.value = routeView.value
  query()
}, { immediate: true })

async function loadFilterOptions() {
  const requestId = ++optionsRequest
  const key = optionKey.value
  const projectKey = projectOptionsKey.value
  optionsFailedKey.value = ''
  try {
    const data = await api.filterOptions({ ...optionParams.value, scoped_usage: '1' })
    if (requestId !== optionsRequest || key !== optionKey.value) return
    resolvedOptions.value = { key, projectKey, data }
    individualCustomers.value = data.individual_customers || []
    for (const project of data.projects || []) if (project.title) projectNames.set(String(project.id), project.title)
    for (const user of data.users || []) userNames.set(String(user.id), userLabel(user))
  } catch {
    if (requestId === optionsRequest && key === optionKey.value) optionsFailedKey.value = key
    return
  }
  return applyPendingFilters()
}

watch(optionKey, loadFilterOptions, { immediate: true })

onMounted(() => {
  adminAPI.customerOrganizations().then(value => { customers.value = value }).catch(() => {})
})

async function loadReports() {
  reportsError.value = ''
  try {
    reports.value = await api.reports()
    reportsLoaded.value = true
  } catch (e) {
    reportsError.value = e.message || '月报读取失败'
  }
}

watch(tab, value => {
  if (value === 'reports' && !reportsLoaded.value) loadReports()
})

onUnmounted(() => {
  disposed = true
  overviewRequest++
  optionsRequest++
  clearTimeout(pricePoll)
})
</script>
<style scoped src="./CostAccounting.css"></style>
