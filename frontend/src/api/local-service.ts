import { MODULE_BY_KEY } from '@/data/modules'
import { DRILL_PATH_CONFIGS } from '@/data/drill-fixtures'
import {
  buildDrillExport,
  buildDrillResult,
  compareDrillStrategyResults,
  levelStateLabel,
  paginateDrillDetail,
  sortDirectionLabel,
  strategyLabel,
} from '@/data/drill-result'
import {
  getDrillResult,
  listDrillLevelCache,
  listDrillResults,
  resetDrillCache,
  saveDrillLevelCacheEntry,
  saveDrillResult,
} from '@/data/drill-store'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  DrillDetailRow,
  DrillExportResult,
  DrillLevelCacheEntry,
  DrillLevelState,
  DrillPageResult,
  DrillResult,
  DrillSortDirection,
  DrillStrategy,
  DrillStrategyComparison,
} from '@/data/drill-types'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ===== 多维下钻结果 =====
// 读取顺序：路径配置 → 各层缓存明细 → 按层聚合与限额 → 归档结果 → 字段明细。
// 某一层缺字段只标记该层，不丢弃整条路径；缓存刷新只替换命中的那一层。

export type DrillRequestInput = {
  pathNo: string
  strategy?: DrillStrategy
  levelIndex?: number | null
  page?: number
  size?: number
}

function drillConfig(pathNo: string) {
  const config = DRILL_PATH_CONFIGS[pathNo]
  if (!config) {
    throw new Error(`没有登记编号为 ${pathNo} 的下钻路径`)
  }
  return config
}

function drillPathEntry(pathNo: string): EntryRow | undefined {
  return listRows('drill').find((row) => String(row['路径编号'] ?? '') === pathNo)
}

export function readDrillLevels(pathNo: string): DrillLevelCacheEntry[] {
  drillConfig(pathNo)
  return listDrillLevelCache(pathNo)
}

/** 生成（或复用）下钻结果。同一 requestKey 只归档一份，重试只更新 attempts。 */
export function requestDrillResult(input: DrillRequestInput): DrillResult {
  const config = drillConfig(input.pathNo)
  const strategy: DrillStrategy = input.strategy ?? 'current-first'
  const cache = listDrillLevelCache(input.pathNo)
  const signature = config.levels
    .map((level) => {
      const entry = cache.find((item) => item.levelIndex === level.levelIndex)
      return `${level.levelIndex}.${entry?.version ?? 0}`
    })
    .join('-')
  const requestKey = `drill:${input.pathNo}:${strategy}:${signature}`
  const existing = getDrillResult(requestKey)
  if (existing) {
    const retried: DrillResult = { ...existing, attempts: (existing.attempts ?? 1) + 1 }
    saveDrillResult(retried)
    return retried
  }
  const built = buildDrillResult({
    pathNo: input.pathNo,
    config,
    cache,
    strategy,
    pathEntry: drillPathEntry(input.pathNo) as unknown as Record<string, string | number | boolean> | undefined,
  })
  saveDrillResult(built)
  return built
}

export function listDrillArchivedResults(): DrillResult[] {
  return listDrillResults().filter((item) => item.pathNo in DRILL_PATH_CONFIGS)
}

export function loadDrillResult(requestKey: string): DrillResult {
  const archived = getDrillResult(requestKey)
  if (!archived) {
    throw new Error(`没有找到编号为 ${requestKey} 的下钻结果`)
  }
  return archived
}

export function refreshDrillLevel(
  pathNo: string,
  levelIndex: number,
  rows?: DrillLevelCacheEntry['rows'],
): DrillLevelCacheEntry[] {
  const config = drillConfig(pathNo)
  const levelConfig = config.levels.find((level) => level.levelIndex === levelIndex)
  if (!levelConfig) {
    throw new Error(`下钻路径 ${pathNo} 没有第 ${levelIndex + 1} 层`)
  }
  const current = listDrillLevelCache(pathNo)
  const previous = current.find((item) => item.levelIndex === levelIndex)
  return saveDrillLevelCacheEntry(pathNo, {
    pathNo,
    levelIndex,
    dimension: levelConfig.dimension,
    version: (previous?.version ?? 0) + 1,
    rows: rows ?? previous?.rows ?? [],
    refreshedAt: Date.now(),
  })
}

export function resetDrillLevels(pathNo: string): DrillLevelCacheEntry[] {
  drillConfig(pathNo)
  return resetDrillCache(pathNo)
}

export function compareDrillStrategies(pathNo: string): {
  upperFirst: DrillResult
  currentFirst: DrillResult
  comparison: DrillStrategyComparison
} {
  const upperFirst = requestDrillResult({ pathNo, strategy: 'upper-first' })
  const currentFirst = requestDrillResult({ pathNo, strategy: 'current-first' })
  return {
    upperFirst,
    currentFirst,
    comparison: compareDrillStrategyResults(upperFirst, currentFirst),
  }
}

export type DrillExportScope = {
  levelIndex?: number | null
  page?: number | null
  size?: number
}

function drillExportRows(result: DrillResult, scope: DrillExportScope): DrillDetailRow[] | undefined {
  if (scope.page === null || scope.page === undefined) {
    return undefined
  }
  const pageData = paginateDrillDetail(result, {
    levelIndex: scope.levelIndex ?? null,
    page: scope.page,
    size: scope.size,
  })
  return pageData.items
}

export function exportDrillResult(
  requestKey: string,
  levelIndex: number | null = null,
  scope: { page?: number | null; size?: number } = {},
): DrillExportResult {
  const result = loadDrillResult(requestKey)
  return buildDrillExport(result, {
    levelIndex,
    rows: drillExportRows(result, { levelIndex, ...scope }),
  })
}

export function downloadDrillExport(
  requestKey: string,
  levelIndex: number | null = null,
  scope: { page?: number | null; size?: number } = {},
): DrillExportResult {
  const exported = exportDrillResult(requestKey, levelIndex, scope)
  for (const file of exported.files) {
    const blob = new Blob([file.content], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = file.filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }
  return exported
}

export function listDrillPaths(): {
  pathNo: string
  dimensions: string[]
  metric: string
  maxRows: number
  budget: number
  sortLabel: string
}[] {
  return Object.values(DRILL_PATH_CONFIGS)
    .sort((left, right) => left.pathNo.localeCompare(right.pathNo))
    .map((config) => ({
      pathNo: config.pathNo,
      dimensions: [...config.dimensions],
      metric: config.metric,
      maxRows: config.maxRows,
      budget: config.rowBudget,
      sortLabel: config.sortLabel,
    }))
}

export function strategyOptions(): { value: DrillStrategy; label: string }[] {
  return [
    { value: 'upper-first', label: strategyLabel('upper-first') },
    { value: 'current-first', label: strategyLabel('current-first') },
  ]
}

/** 分页只读已归档结果，不触发新的请求与归档，翻页顺序保持稳定。 */
export function paginateDrillRows(
  result: DrillResult,
  options: { levelIndex?: number | null; page?: number; size?: number } = {},
): DrillPageResult {
  return paginateDrillDetail(result, options)
}

export function drillLevelStateLabel(state: DrillLevelState): string {
  return levelStateLabel(state)
}

export function drillSortDirectionLabel(direction: DrillSortDirection): string {
  return sortDirectionLabel(direction)
}
