<template>
  <section class="panel" data-drill-result>
    <header class="panel-head">
      <div>
        <h3>下钻结果字段明细</h3>
        <p class="page-desc">
          按层级读取缓存明细并逐层限额：缺字段层只标记该层，其他可用层继续展示；每层行数单独受限，导出与列表条目同源。
        </p>
      </div>
      <div class="page-actions">
        <label class="inline-field">
          <span>排序策略</span>
          <select v-model="strategy" @change="generate()">
            <option v-for="item in strategies" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
        <button class="btn primary" type="button" @click="generate()">生成 / 复用结果</button>
      </div>
    </header>

    <div class="toolbar">
      <label>
        <span>下钻路径</span>
        <select v-model="pathNo">
          <option v-for="item in pathOptions" :key="item.pathNo" :value="item.pathNo">
            {{ item.pathNo }} · {{ item.dimensions.join(' → ') }}
          </option>
        </select>
      </label>
      <button class="btn" type="button" @click="runCompare">对比两种做法</button>
      <button class="btn" type="button" @click="resetLevels">重置各层缓存</button>
      <button class="btn" type="button" @click="showAcceptance = !showAcceptance">
        {{ showAcceptance ? '收起验收核对' : '展开验收核对' }}
      </button>
    </div>

    <p v-if="message" class="notice">{{ message }}</p>
    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <template v-if="result">
      <dl class="meta-grid">
        <div><dt>结果编号</dt><dd class="mono">{{ result.id }}</dd></div>
        <div><dt>下钻路径</dt><dd>{{ result.pathNo }}（{{ result.pathSnapshot['层级维度列表'] }}）</dd></div>
        <div><dt>聚合指标</dt><dd>{{ result.metric }}</dd></div>
        <div><dt>策略</dt><dd>{{ result.strategyLabel }}</dd></div>
        <div><dt>路径预算 / 单层上限</dt><dd>{{ result.budget }} 行 / {{ result.maxRows }} 行</dd></div>
        <div><dt>缓存版本</dt><dd class="mono">{{ result.cacheVersionLabel }}</dd></div>
        <div><dt>请求次数</dt><dd>{{ result.attempts }}（同一 resultKey 只归档一份）</dd></div>
        <div><dt>生成时间</dt><dd>{{ formatTime(result.generatedAt) }}</dd></div>
        <div class="wide"><dt>行数分配依据</dt><dd>{{ result.allocationBasis }}</dd></div>
        <div class="wide">
          <dt>归档快照</dt>
          <dd class="mono">
            起点维度 {{ result.pathSnapshot['起点维度'] }} · 层数 {{ result.pathSnapshot['下钻层数'] }} ·
            默认展开层 {{ result.pathSnapshot['默认展开层'] }} · 排序方向 {{ result.pathSnapshot['排序方向'] }} ·
            最多展示行数 {{ result.pathSnapshot['最多展示行数'] }}
          </dd>
        </div>
      </dl>

      <div v-if="showAcceptance" class="acceptance">
        <strong>验收核对</strong>
        <ul>
          <li>
            截断位置：
            <span v-if="!result.truncatedLevels.length">无截断层</span>
            <span v-for="level in truncatedLevels" :key="level.levelIndex" class="acceptance-item">
              {{ level.dimension }} 层保留 {{ level.visibleRows }}/{{ level.totalRows }} 行，截断位置 {{ level.truncatedAt }}
              （{{ limitKindLabel(level) }}）
            </span>
          </li>
          <li>保留层：{{ retainedLabels }}</li>
          <li>缺字段层：{{ missingLabels }}</li>
          <li>缓存版本：<span class="mono">{{ result.cacheVersionLabel }}</span></li>
          <li>
            DRIL-0003 门店层 18 行只展示前 10 行时，城市层与区域层仍完整并标明门店层截断：
            <span :class="dril0003.pass ? 'check' : 'fail'">{{ dril0003.text }}</span>
          </li>
          <li>
            缺字段层与超限层同时出现（DRIL-0004 城市缺字段 + 门店截断）：
            <span :class="dril0004.pass ? 'check' : 'fail'">{{ dril0004.text }}</span>
          </li>
          <li>
            导出排序方向：
            <span :class="exportPreview?.mode === 'per-level' ? 'check' : ''">
              {{ exportPreview ? (exportPreview.mode === 'per-level' ? '已按层拆分' : '单一方向合并') : '待预览' }}
            </span>
            （不同排序方向的层不允许拼在一份文件里）
          </li>
        </ul>
      </div>

      <div class="section-title">
        <h4>层级状态</h4>
        <span class="muted">每层独立限额；表格中的行数与导出行数同源</span>
      </div>
      <table class="data-table level-table">
        <thead>
          <tr>
            <th>层</th>
            <th>维度</th>
            <th>层状态</th>
            <th>总行数</th>
            <th>可见行数</th>
            <th>截断位置</th>
            <th>保留层</th>
            <th>排序方向</th>
            <th>缓存版本</th>
            <th>截断依据</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="level in result.levels" :key="level.levelIndex">
            <td>{{ level.levelIndex + 1 }}</td>
            <td>{{ level.dimension }}</td>
            <td><span class="badge" :class="level.state">{{ drillLevelStateLabel(level.state) }}</span></td>
            <td>{{ level.totalRows }}</td>
            <td>{{ level.visibleRows }}</td>
            <td>{{ level.truncatedAt ?? '—' }}</td>
            <td>{{ level.retained ? '是' : '否' }}</td>
            <td>{{ level.sortDirectionLabel }}</td>
            <td class="mono">v{{ level.cacheVersion }}</td>
            <td class="basis">{{ level.basis }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="focusLevel(level.levelIndex)">查看明细</button>
              <button class="link" type="button" @click="refreshCache(level.levelIndex)">刷新本层缓存</button>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="section-title">
        <h4>层级缓存</h4>
        <span class="muted">刷新只替换对应层，其他层版本与行数保持不变</span>
      </div>
      <table class="data-table">
        <thead>
          <tr><th>层</th><th>维度</th><th>版本</th><th>源行数</th><th>刷新时间</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="entry in cache" :key="entry.levelIndex">
            <td>{{ entry.levelIndex + 1 }}</td>
            <td>{{ entry.dimension }}</td>
            <td class="mono">v{{ entry.version }}</td>
            <td>{{ entry.rows.length }}</td>
            <td>{{ formatTime(entry.refreshedAt) }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="refreshCache(entry.levelIndex)">刷新该层</button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="comparison" class="compare-block">
        <div class="section-title">
          <h4>两种做法对比</h4>
          <span class="badge" :class="comparison.conflict ? 'truncated' : 'complete'">
            {{ comparison.conflict ? '存在冲突' : '无冲突' }}
          </span>
        </div>
        <p class="muted">{{ comparison.conflictBasis }}</p>
        <table class="data-table">
          <thead>
            <tr>
              <th>维度</th>
              <th>上级优先 可见/总行</th>
              <th>上级优先 截断位置</th>
              <th>当前层优先 可见/总行</th>
              <th>当前层优先 截断位置</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(dimension, index) in comparison.levels" :key="dimension">
              <td>{{ dimension }}</td>
              <td>{{ comparison.upperFirst.visibleRowsByLevel[index] }}</td>
              <td>{{ truncationOf(comparison.upperFirst, index) }}</td>
              <td>{{ comparison.currentFirst.visibleRowsByLevel[index] }}</td>
              <td>{{ truncationOf(comparison.currentFirst, index) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="muted">
          {{ comparison.upperFirst.strategyLabel }}：汇总 {{ comparison.upperFirst.summaryRows }} 行 / 明细 {{ comparison.upperFirst.detailRows }} 行，保留 {{ comparison.upperFirst.retainedLevelLabels.join('、') }}；
          {{ comparison.currentFirst.strategyLabel }}：汇总 {{ comparison.currentFirst.summaryRows }} 行 / 明细 {{ comparison.currentFirst.detailRows }} 行，保留 {{ comparison.currentFirst.retainedLevelLabels.join('、') }}。
          导出方式：{{ comparison.exportMode === 'per-level' ? '按层拆分文件' : '合并为一份' }} ·
          涉及排序方向：{{ comparison.sortDirections.map(drillSortDirectionLabel).join('、') }}
        </p>
      </div>

      <div class="section-title">
        <h4>明细列表</h4>
        <span class="muted">
          当前查看：{{ viewingArchiveKey ? '归档结果' : '最新结果' }} ·
          按层级定位后翻页保持原顺序
        </span>
      </div>
      <div class="toolbar">
        <label>
          <span>层级定位</span>
          <select v-model="levelFilter" @change="changeScope">
            <option value="all">全部层级</option>
            <option v-for="level in result.levels" :key="level.levelIndex" :value="level.levelIndex">
              {{ level.levelIndex + 1 }}. {{ level.dimension }}
            </option>
          </select>
        </label>
        <label>
          <span>每页行数</span>
          <select v-model.number="pageSize" @change="changeScope">
            <option :value="5">5</option>
            <option :value="10">10</option>
            <option :value="20">20</option>
          </select>
        </label>
        <button class="btn" type="button" @click="previewExport(selectedLevelIndex, 'page')">
          导出当前页（{{ pageData.items.length }} 行）
        </button>
        <button class="btn" type="button" @click="previewExport(selectedLevelIndex, 'scope')">
          导出当前范围（{{ scopeRowTotal }} 行）
        </button>
        <button class="btn" type="button" @click="previewExport(null, 'scope')">导出全部层级</button>
      </div>

      <table class="data-table detail-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>层</th>
            <th>层状态</th>
            <th>维度值</th>
            <th>聚合指标</th>
            <th>聚合值</th>
            <th>排序方向</th>
            <th>截断位置</th>
            <th>缓存版本</th>
            <th>层级行数（可见/总）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in pageData.items" :key="row.id">
            <td>{{ row.seq }}</td>
            <td>{{ row.levelIndex + 1 }}. {{ row.level }}</td>
            <td><span class="badge" :class="row.levelState">{{ drillLevelStateLabel(row.levelState) }}</span></td>
            <td>{{ row.dimensionValue }}</td>
            <td>{{ row.aggregateMetric }}</td>
            <td>{{ row.aggregateValue ?? '—' }}</td>
            <td>{{ row.sortDirectionLabel }}</td>
            <td>{{ row.truncationAt ?? '—' }}</td>
            <td class="mono">v{{ row.cacheVersion }}</td>
            <td>{{ row.levelVisibleRows }} / {{ row.levelTotalRows }}</td>
          </tr>
          <tr v-if="!pageData.items.length">
            <td :colspan="10" class="empty-state">当前层级没有可展示的明细行</td>
          </tr>
        </tbody>
      </table>
      <div class="pager">
        <button class="btn" type="button" :disabled="pageData.page <= 1" @click="movePage(-1)">上一页</button>
        <span>第 {{ pageData.page }} / {{ pageData.totalPages }} 页 · 共 {{ pageData.total }} 行</span>
        <button
          class="btn"
          type="button"
          :disabled="pageData.page >= pageData.totalPages"
          @click="movePage(1)"
        >
          下一页
        </button>
        <span>顺序键：序号 {{ pageData.items[0]?.seq ?? '—' }} → {{ pageData.items[pageData.items.length - 1]?.seq ?? '—' }}</span>
      </div>

      <div v-if="exportPreview" class="export-block">
        <div class="section-title">
          <h4>导出预览</h4>
          <span class="badge" :class="exportConsistent ? 'complete' : 'missing-field'">
            {{ exportConsistent ? '与列表条目一致' : '与列表条目不一致' }}
          </span>
        </div>
        <p class="muted">
          {{ exportPreview.note }} · 明细文件导出行数 {{ exportRowTotal }} / 当前核对范围 {{ exportScopeTotal }} 行
        </p>
        <ul class="file-list">
          <li v-for="file in exportPreview.files" :key="file.filename">
            {{ file.filename }}（{{ file.rowCount }} 行{{ file.kind === 'manifest' ? '，层级状态' : '' }}）
          </li>
        </ul>
        <button class="btn primary" type="button" @click="downloadSelected">下载导出文件</button>      </div>

      <div class="section-title">
        <h4>归档结果</h4>
        <span class="muted">下钻路径、聚合指标、缓存版本随结果归档，可按结果编号回看明细</span>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>结果编号</th>
            <th>策略</th>
            <th>缓存版本</th>
            <th>保留层</th>
            <th>可见行数</th>
            <th>请求次数</th>
            <th>生成时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in archivedForPath" :key="item.id">
            <td class="mono">{{ item.id }}</td>
            <td>{{ item.strategyLabel }}</td>
            <td class="mono">{{ item.cacheVersionLabel }}</td>
            <td>{{ item.retainedLevels.map((index) => levelName(item, index)).join('、') }}</td>
            <td>{{ item.rows.length }}</td>
            <td>{{ item.attempts }}</td>
            <td>{{ formatTime(item.generatedAt) }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="openArchive(item.id)">回看明细</button>
            </td>
          </tr>
          <tr v-if="!archivedForPath.length">
            <td colspan="8" class="empty-state">当前路径还没有归档结果</td>
          </tr>
        </tbody>
      </table>
    </template>

    <p v-else class="empty-state">尚未读取到下钻结果</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import {
  compareDrillStrategies,
  downloadDrillExport,
  drillLevelStateLabel,
  drillSortDirectionLabel,
  exportDrillResult,
  listDrillArchivedResults,
  listDrillPaths,
  loadDrillResult,
  paginateDrillRows,
  readDrillLevels,
  refreshDrillLevel,
  requestDrillResult,
  resetDrillLevels,
  strategyOptions,
} from '@/api/local-service'
import type {
  DrillExportResult,
  DrillLevelCacheEntry,
  DrillLevelResult,
  DrillResult,
  DrillStrategy,
  DrillStrategyComparison,
  DrillStrategySummary,
} from '@/data/drill-types'

const pathNo = defineModel<string>({ required: true })
const strategies = strategyOptions()
const pathOptions = listDrillPaths()

const strategy = ref<DrillStrategy>('current-first')
const result = ref<DrillResult | null>(null)
const cache = ref<DrillLevelCacheEntry[]>([])
const levelFilter = ref<number | 'all'>('all')
const page = ref(1)
const pageSize = ref(5)
const message = ref('')
const errorMessage = ref('')
const comparison = ref<DrillStrategyComparison | null>(null)
const exportPreview = ref<DrillExportResult | null>(null)
const exportScope = ref<'page' | 'scope'>('scope')
const archived = ref<DrillResult[]>([])
const viewingArchiveKey = ref('')
const showAcceptance = ref(true)

const selectedLevelIndex = computed(() => (levelFilter.value === 'all' ? null : levelFilter.value))
const truncatedLevels = computed(() => result.value?.levels.filter((level) => level.state === 'truncated') ?? [])
const retainedLabels = computed(() =>
  result.value
    ? result.value.levels.filter((level) => level.retained).map((level) => level.dimension).join('、') || '无'
    : '—',
)
const missingLabels = computed(() =>
  result.value
    ? result.value.levels.filter((level) => level.state === 'missing-field').map((level) => level.dimension).join('、') || '无'
    : '—',
)
const archivedForPath = computed(() =>
  result.value ? archived.value.filter((item) => item.pathNo === result.value?.pathNo) : [],
)
const pageData = computed(() =>
  result.value
    ? paginateDrillRows(result.value, {
        levelIndex: selectedLevelIndex.value,
        page: page.value,
        size: pageSize.value,
      })
    : { items: [], total: 0, page: 1, size: pageSize.value, totalPages: 1, levelIndex: null },
)
const scopeRowTotal = computed(() => {
  if (!result.value) return 0
  return selectedLevelIndex.value === null
    ? result.value.rows.length
    : result.value.rows.filter((row) => row.levelIndex === selectedLevelIndex.value).length
})
const exportRowTotal = computed(() =>
  exportPreview.value
    ? exportPreview.value.files
        .filter((file) => file.kind === 'detail')
        .reduce((sum, file) => sum + file.rowCount, 0)
    : 0,
)
const exportScopeTotal = computed(() => (exportScope.value === 'page' ? pageData.value.items.length : scopeRowTotal.value))
const exportConsistent = computed(() => exportPreview.value !== null && exportRowTotal.value === exportScopeTotal.value)
const dril0003 = computed(() => {
  const current = result.value
  if (!current || current.pathNo !== 'DRIL-0003') {
    return { pass: false, text: '当前不是 DRIL-0003，切换到该路径核对' }
  }
  const store = current.levels.find((level) => level.dimension === '门店')
  const city = current.levels.find((level) => level.dimension === '城市')
  const region = current.levels.find((level) => level.dimension === '区域')
  const pass = Boolean(
    store &&
      store.totalRows === 18 &&
      store.visibleRows === 10 &&
      store.truncatedAt === 10 &&
      store.state === 'truncated' &&
      city?.state === 'complete' &&
      region?.state === 'complete',
  )
  return {
    pass,
    text: pass
      ? `通过：门店层 ${store?.visibleRows}/${store?.totalRows} 行（截断位置 ${store?.truncatedAt}），城市层 ${city?.visibleRows}/${city?.totalRows} 行完整，区域层 ${region?.visibleRows}/${region?.totalRows} 行完整`
      : `未通过：门店层 ${store?.visibleRows ?? '—'}/${store?.totalRows ?? '—'}，城市层 ${city?.state ?? '—'}，区域层 ${region?.state ?? '—'}`,
  }
})

const dril0004 = computed(() => {
  const current = result.value
  if (!current || current.pathNo !== 'DRIL-0004') {
    return { pass: false, text: '当前不是 DRIL-0004，切换到该路径核对' }
  }
  const city = current.levels.find((level) => level.dimension === '城市')
  const store = current.levels.find((level) => level.dimension === '门店')
  const region = current.levels.find((level) => level.dimension === '区域')
  const category = current.levels.find((level) => level.dimension === '品类')
  const pass = Boolean(
    city?.state === 'missing-field' &&
      store?.state === 'truncated' &&
      store?.truncatedAt === 10 &&
      region?.state === 'complete' &&
      category?.state === 'complete' &&
      region.retained &&
      category.retained,
  )
  return {
    pass,
    text: pass
      ? `通过：城市层缺字段、门店层 ${store?.visibleRows}/${store?.totalRows} 行截断于 ${store?.truncatedAt}，上级区域层 ${region?.visibleRows}/${region?.totalRows} 行与下级品类层 ${category?.visibleRows}/${category?.totalRows} 行仍完整`
      : `未通过：城市层 ${city?.state ?? '—'}，门店层 ${store?.state ?? '—'}，区域层 ${region?.state ?? '—'}，品类层 ${category?.state ?? '—'}`,
  }
})

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function levelName(item: DrillResult, index: number): string {
  return item.levels.find((level) => level.levelIndex === index)?.dimension ?? `第${index + 1}层`
}

function limitKindLabel(level: DrillLevelResult): string {
  if (level.limitKind === 'per-level') return '单层上限截断'
  if (level.limitKind === 'budget') return '路径预算截断'
  if (level.limitKind === 'both') return '单层上限与路径预算同时触发'
  return '未截断'
}

function truncationOf(summary: DrillStrategySummary, levelIndex: number): string {
  const found = summary.truncated.find((item) => item.levelIndex === levelIndex)
  return found ? `第 ${found.truncatedAt} 行` : '—'
}

function refreshArchive(): void {
  archived.value = listDrillArchivedResults()
}

function generate(keepMessage = false): void {
  errorMessage.value = ''
  if (!keepMessage) message.value = ''
  try {
    const next = requestDrillResult({ pathNo: pathNo.value, strategy: strategy.value })
    result.value = next
    cache.value = readDrillLevels(pathNo.value)
    viewingArchiveKey.value = ''
    page.value = 1
    exportPreview.value = null
    refreshArchive()
    if (!keepMessage) {
      message.value = next.attempts > 1
        ? `复用归档中同一份结果（第 ${next.attempts} 次请求），没有新增第二份字段明细`
        : `已生成下钻结果 ${next.id}，可用层 ${next.retainedLevels.length} 个，缺字段层 ${next.missingLevels.length} 个`
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '下钻结果读取失败'
  }
}

function refreshCache(levelIndex: number): void {
  try {
    cache.value = refreshDrillLevel(pathNo.value, levelIndex)
    const refreshed = cache.value.find((entry) => entry.levelIndex === levelIndex)
    generate(true)
    message.value = `只刷新「${refreshed?.dimension ?? levelIndex + 1}」层到 v${refreshed?.version}，其余层版本未变；结果按新缓存版本重新归档`
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '刷新层级缓存失败'
  }
}

function resetLevels(): void {
  try {
    cache.value = resetDrillLevels(pathNo.value)
    generate()
    message.value = '各层缓存已重置为示例版本'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '重置层级缓存失败'
  }
}

function runCompare(): void {
  errorMessage.value = ''
  try {
    const output = compareDrillStrategies(pathNo.value)
    comparison.value = output.comparison
    message.value = `已按两种做法分别生成结果：上级优先保留 ${output.upperFirst.retainedLevels.length} 层，当前层优先保留 ${output.currentFirst.retainedLevels.length} 层；${output.comparison.conflict ? '判定存在冲突' : '判定无冲突'}`
    refreshArchive()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '两种做法对比失败'
  }
}

function focusLevel(levelIndex: number): void {
  levelFilter.value = levelIndex
  page.value = 1
}

function changeScope(): void {
  page.value = 1
}

function movePage(delta: number): void {
  const next = pageData.value.page + delta
  page.value = Math.min(Math.max(1, next), pageData.value.totalPages)
}

function previewExport(levelIndex: number | null, scope: 'page' | 'scope'): void {
  if (!result.value) return
  errorMessage.value = ''
  exportScope.value = scope
  try {
    exportPreview.value = exportDrillResult(
      result.value.id,
      levelIndex,
      scope === 'page' ? { page: pageData.value.page, size: pageSize.value } : {},
    )
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '导出预览失败'
  }
}

function downloadSelected(): void {
  if (!result.value) return
  try {
    downloadDrillExport(
      result.value.id,
      selectedLevelIndex.value,
      exportScope.value === 'page' ? { page: pageData.value.page, size: pageSize.value } : {},
    )
    message.value = '导出文件已生成：明细与列表条目同源，层级状态单独成文件'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '下载导出文件失败'
  }
}

function openArchive(requestKey: string): void {
  try {
    const loaded = loadDrillResult(requestKey)
    result.value = loaded
    strategy.value = loaded.strategy
    viewingArchiveKey.value = requestKey
    cache.value = readDrillLevels(loaded.pathNo)
    levelFilter.value = 'all'
    page.value = 1
    exportPreview.value = null
    message.value = `已回看归档结果 ${loaded.id}（缓存版本 ${loaded.cacheVersionLabel}）`
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '归档结果读取失败'
  }
}

watch(
  pathNo,
  () => {
    comparison.value = null
    levelFilter.value = 'all'
    page.value = 1
    strategy.value = 'current-first'
    generate()
  },
  { immediate: true },
)

// 翻页或切换层级后旧预览会与列表脱节，直接作废，避免"一致"结论失真。
watch([page, pageSize, levelFilter], () => {
  exportPreview.value = null
})
</script>
