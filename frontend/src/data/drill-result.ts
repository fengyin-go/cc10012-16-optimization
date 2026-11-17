import type {
  DrillDetailRow,
  DrillExportFile,
  DrillExportResult,
  DrillLevelCacheEntry,
  DrillLevelResult,
  DrillLevelState,
  DrillPageResult,
  DrillPathConfig,
  DrillResult,
  DrillSourceRow,
  DrillStrategy,
  DrillStrategyComparison,
  DrillStrategySummary,
} from './drill-types'

export const DRILL_STRATEGIES: { value: DrillStrategy; label: string }[] = [
  { value: 'upper-first', label: '上级优先' },
  { value: 'current-first', label: '当前层优先' },
]

const STRATEGY_HINTS: Record<DrillStrategy, string> = {
  'upper-first': '保留更多上级汇总',
  'current-first': '保留更细的当前层明细',
}

export function strategyLabel(strategy: DrillStrategy): string {
  const found = DRILL_STRATEGIES.find((item) => item.value === strategy)
  return found ? found.label : strategy
}

export function sortDirectionLabel(direction: 'asc' | 'desc'): string {
  return direction === 'asc' ? '升序' : '降序'
}

export function levelStateLabel(state: DrillLevelState): string {
  switch (state) {
    case 'complete':
      return '完整'
    case 'truncated':
      return '已截断'
    case 'missing-field':
      return '缺字段'
    case 'empty':
      return '无明细'
    case 'deferred':
      return '预算不足'
    default:
      return '不可用'
  }
}

function compareAggregate(
  left: { value: string; metric: number | null },
  right: { value: string; metric: number | null },
  direction: 'asc' | 'desc',
): number {
  if (left.metric === null && right.metric !== null) return 1
  if (left.metric !== null && right.metric === null) return -1
  if (left.metric !== null && right.metric !== null) {
    const diff = direction === 'asc' ? left.metric - right.metric : right.metric - left.metric
    if (diff !== 0) return diff
  }
  return left.value.localeCompare(right.value, 'zh-Hans-CN')
}

function aggregateLevel(
  rows: DrillSourceRow[],
  field: string,
  metric: string,
  direction: 'asc' | 'desc',
): { state: 'ok' | 'missing-field' | 'empty'; values: { value: string; metric: number | null }[] } {
  if (rows.length === 0) {
    return { state: 'empty', values: [] }
  }
  const hasField = rows.some((row) => {
    const value = row[field]
    return value !== undefined && value !== null && String(value).trim() !== ''
  })
  if (!hasField) {
    return { state: 'missing-field', values: [] }
  }
  const grouped = new Map<string, { total: number; seen: boolean }>()
  for (const row of rows) {
    const raw = row[field]
    const value = raw === undefined || raw === null ? '' : String(raw).trim()
    if (value === '') {
      continue
    }
    const bucket = grouped.get(value) ?? { total: 0, seen: false }
    const metricValue = row[metric]
    if (typeof metricValue === 'number' && Number.isFinite(metricValue)) {
      bucket.total += metricValue
      bucket.seen = true
    }
    grouped.set(value, bucket)
  }
  const values = [...grouped.entries()]
    .map(([value, bucket]) => ({
      value,
      metric: bucket.seen ? Math.round(bucket.total * 100) / 100 : null,
    }))
    .sort((left, right) => compareAggregate(left, right, direction))
  return { state: values.length === 0 ? 'empty' : 'ok', values }
}

function allocationOrder(levelCount: number, strategy: DrillStrategy, current: number): number[] {
  const all = Array.from({ length: levelCount }, (_, index) => index)
  if (strategy === 'upper-first') {
    return all
  }
  return [current, ...all.filter((index) => index !== current)]
}

function allocateRows(
  desired: number[],
  budget: number,
  order: number[],
): number[] {
  const allocation = desired.map(() => 0)
  const available = order.filter((index) => desired[index] > 0)
  let remaining = Math.max(0, budget)
  if (remaining === 0) {
    return allocation
  }
  // 先给每个可用层留 1 行，避免预算紧张时某层整体消失。
  for (const index of available) {
    if (remaining <= 0) break
    allocation[index] = 1
    remaining -= 1
  }
  for (const index of order) {
    if (remaining <= 0) break
    const need = desired[index] - allocation[index]
    if (need <= 0) continue
    const give = Math.min(need, remaining)
    allocation[index] += give
    remaining -= give
  }
  return allocation
}

function describeAllocation(
  config: DrillPathConfig,
  strategy: DrillStrategy,
  allocation: number[],
  desired: number[],
  current: number,
): string {
  const order = allocationOrder(config.levels.length, strategy, current)
  const orderLabel = order
    .map((index) => config.levels[index]?.dimension ?? `第${index + 1}层`)
    .join(' → ')
  const detail = config.levels
    .map((level, index) => `${level.dimension} ${allocation[index]}/${desired[index]}`)
    .join('，')
  return `策略「${strategyLabel(strategy)}」（${STRATEGY_HINTS[strategy]}），总预算 ${config.rowBudget} 行，单层上限 ${config.maxRows} 行；分配顺序 ${orderLabel}；各层可见/应展示：${detail}`
}

export type BuildDrillInput = {
  pathNo: string
  config: DrillPathConfig
  cache: DrillLevelCacheEntry[]
  strategy: DrillStrategy
  pathEntry?: Record<string, string | number | boolean>
  now?: number
}

export function buildDrillResult(input: BuildDrillInput): DrillResult {
  const { pathNo, config, cache, strategy } = input
  const now = input.now ?? Date.now()
  const current = Math.min(
    Math.max(config.defaultExpandLevelIndex, 0),
    Math.max(config.levels.length - 1, 0),
  )
  const cacheByLevel = new Map(cache.map((entry) => [entry.levelIndex, entry]))
  const prepared = config.levels.map((level) => {
    const entry = cacheByLevel.get(level.levelIndex)
    if (!entry) {
      return {
        level,
        state: 'unavailable' as const,
        values: [] as { value: string; metric: number | null }[],
        cacheVersion: 0,
      }
    }
    const result = aggregateLevel(entry.rows, level.field, config.metric, level.sortDirection)
    return {
      level,
      state: result.state,
      values: result.values,
      cacheVersion: entry.version,
    }
  })

  const desired = prepared.map((item) => Math.min(item.values.length, Math.max(config.maxRows, 0)))
  const order = allocationOrder(config.levels.length, strategy, current)
  const allocation = allocateRows(desired, config.rowBudget, order)
  const allocationBasis = describeAllocation(config, strategy, allocation, desired, current)
  const rows: DrillDetailRow[] = []
  const levels: DrillLevelResult[] = []
  const cacheVersions: Record<number, number> = {}
  let seq = 0

  prepared.forEach((item, index) => {
    const { level } = item
    const totalRows = item.values.length
    const visibleRows = Math.min(allocation[index], totalRows)
    cacheVersions[level.levelIndex] = item.cacheVersion
    let state: DrillLevelState
    let limitKind: DrillLevelResult['limitKind'] = 'none'
    if (item.state === 'missing-field') {
      state = 'missing-field'
    } else if (item.state === 'empty') {
      state = 'empty'
    } else if (item.state === 'unavailable') {
      state = 'unavailable'
    } else if (visibleRows === 0) {
      state = 'deferred'
    } else if (visibleRows < totalRows) {
      state = 'truncated'
      const capBinding = totalRows > config.maxRows
      const budgetBinding = visibleRows < desired[index]
      limitKind = capBinding && budgetBinding ? 'both' : capBinding ? 'per-level' : 'budget'
    } else {
      state = 'complete'
    }
    const hiddenRows = Math.max(totalRows - visibleRows, 0)
    const truncatedAt = state === 'truncated' ? visibleRows : null
    const directionLabel = sortDirectionLabel(level.sortDirection)
    let basis: string
    if (state === 'missing-field') {
      basis = `源数据缺少「${level.field}」维度字段，本层标记缺字段并跳过聚合；上级与下级可用层不受影响`
    } else if (state === 'empty') {
      basis = `「${level.dimension}」维度字段存在，但当前缓存版本 v${item.cacheVersion} 没有可聚合的明细行`
    } else if (state === 'unavailable') {
      basis = `未读取到「${level.dimension}」层的缓存条目，本层不可用；其他层继续展示`
    } else if (state === 'deferred') {
      basis = `本层应展示 ${totalRows} 行，但 ${config.rowBudget} 行预算已按优先级分给更高优先层，本层本轮未获得行数`
    } else if (state === 'truncated') {
      const capText = totalRows > config.maxRows
        ? `单层上限 ${config.maxRows} 行`
        : `单层上限 ${config.maxRows} 行未触发`
      const budgetText = visibleRows < desired[index]
        ? `路径预算 ${config.rowBudget} 行分配后仅得 ${visibleRows} 行`
        : `路径预算 ${config.rowBudget} 行未额外限制本层`
      basis = `「${level.dimension}」层共 ${totalRows} 行，${capText}，${budgetText}；按${directionLabel}展示前 ${visibleRows} 行，截断位置 ${truncatedAt}，隐藏 ${hiddenRows} 行`
    } else {
      basis = `「${level.dimension}」层共 ${totalRows} 行，单层上限 ${config.maxRows} 行、路径预算 ${config.rowBudget} 行均未触发截断，完整展示`
    }

    const levelRows: DrillDetailRow[] = item.values.slice(0, visibleRows).map((value, position) => {
      seq += 1
      return {
        id: `${pathNo}:${strategy}:${level.levelIndex}:${position + 1}`,
        pathNo,
        levelIndex: level.levelIndex,
        level: level.dimension,
        levelState: state,
        position: position + 1,
        seq,
        dimensionValue: value.value,
        aggregateMetric: config.metric,
        aggregateValue: value.metric,
        sortDirection: level.sortDirection,
        sortDirectionLabel: directionLabel,
        cacheVersion: item.cacheVersion,
        truncated: state === 'truncated',
        truncationAt: truncatedAt,
        levelTotalRows: totalRows,
        levelVisibleRows: visibleRows,
      }
    })
    rows.push(...levelRows)
    levels.push({
      levelIndex: level.levelIndex,
      dimension: level.dimension,
      field: level.field,
      state,
      totalRows,
      visibleRows,
      allocatedRows: allocation[index],
      desiredRows: desired[index],
      cap: config.maxRows,
      limit: Math.min(config.maxRows, config.rowBudget),
      limitKind,
      truncatedAt,
      hiddenRows,
      retained: visibleRows > 0,
      sortDirection: level.sortDirection,
      sortDirectionLabel: directionLabel,
      cacheVersion: item.cacheVersion,
      basis,
      rows: levelRows,
    })
  })

  const signature = levels
    .map((level) => `${level.levelIndex}.${level.cacheVersion}`)
    .join('-')
  const requestKey = `drill:${pathNo}:${strategy}:${signature}`
  const cacheVersionLabel = levels
    .map((level) => `${level.dimension} v${level.cacheVersion}`)
    .join(' / ')

  return {
    id: requestKey,
    requestKey,
    pathNo,
    pathSnapshot: {
      ...(input.pathEntry ?? {}),
      路径编号: pathNo,
      起点维度: config.startDimension,
      下钻层数: config.levelCount,
      层级维度列表: config.dimensions.join(' / '),
      聚合指标: config.metric,
      默认展开层: config.levels[current]?.dimension ?? '',
      排序方向: config.sortLabel,
      最多展示行数: config.maxRows,
    },
    metric: config.metric,
    strategy,
    strategyLabel: strategyLabel(strategy),
    budget: config.rowBudget,
    maxRows: config.maxRows,
    currentLevelIndex: current,
    levels,
    rows,
    retainedLevels: levels.filter((level) => level.retained).map((level) => level.levelIndex),
    truncatedLevels: levels.filter((level) => level.state === 'truncated').map((level) => level.levelIndex),
    missingLevels: levels.filter((level) => level.state === 'missing-field').map((level) => level.levelIndex),
    deferredLevels: levels.filter((level) => level.state === 'deferred').map((level) => level.levelIndex),
    cacheVersions,
    cacheVersionLabel,
    allocationBasis,
    generatedAt: now,
    attempts: 1,
  }
}

export function listDrillDetailRows(
  result: DrillResult,
  levelIndex: number | null = null,
): DrillDetailRow[] {
  if (levelIndex === null) {
    return [...result.rows]
  }
  return result.rows.filter((row) => row.levelIndex === levelIndex)
}

export function paginateDrillDetail(
  result: DrillResult,
  options: { levelIndex?: number | null; page?: number; size?: number } = {},
): DrillPageResult {
  const levelIndex = options.levelIndex ?? null
  const size = Math.max(1, Math.floor(options.size ?? 10))
  const matched = listDrillDetailRows(result, levelIndex)
  const totalPages = Math.max(1, Math.ceil(matched.length / size))
  const page = Math.min(Math.max(1, Math.floor(options.page ?? 1)), totalPages)
  const start = (page - 1) * size
  return {
    items: matched.slice(start, start + size),
    total: matched.length,
    page,
    size,
    totalPages,
    levelIndex,
  }
}

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function csvLine(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(',')
}

const DETAIL_HEADER = [
  '结果编号',
  '路径编号',
  '聚合指标',
  '层级序号',
  '层级',
  '层状态',
  '维度值',
  '聚合值',
  '排序方向',
  '截断位置',
  '序号',
  '层级总行数',
  '层级可见行数',
  '缓存版本',
]

function detailFile(
  result: DrillResult,
  nameSuffix: string,
  rows: DrillDetailRow[],
): DrillExportFile {
  const lines = [csvLine(DETAIL_HEADER)]
  for (const row of rows) {
    lines.push(
      csvLine([
        result.id,
        result.pathNo,
        result.metric,
        row.levelIndex,
        row.level,
        levelStateLabel(row.levelState),
        row.dimensionValue,
        row.aggregateValue ?? '',
        row.sortDirectionLabel,
        row.truncationAt ?? '',
        row.seq,
        row.levelTotalRows,
        row.levelVisibleRows,
        row.cacheVersion,
      ]),
    )
  }
  return {
    filename: `${result.pathNo}-${nameSuffix}-下钻结果字段明细.csv`,
    content: `﻿${lines.join('\n')}`,
    kind: 'detail',
    levelIndex: rows.length > 0 ? rows[0].levelIndex : null,
    rowCount: rows.length,
  }
}

function levelManifestFile(result: DrillResult): DrillExportFile {
  const lines = [
    csvLine(['路径编号', '聚合指标', '策略', '层级序号', '层级', '层状态', '排序方向', '总行数', '可见行数', '截断位置', '隐藏行数', '保留层', '缓存版本', '截断依据']),
  ]
  for (const level of result.levels) {
    lines.push(
      csvLine([
        result.pathNo,
        result.metric,
        result.strategyLabel,
        level.levelIndex,
        level.dimension,
        levelStateLabel(level.state),
        level.sortDirectionLabel,
        level.totalRows,
        level.visibleRows,
        level.truncatedAt ?? '',
        level.hiddenRows,
        level.retained ? '是' : '否',
        level.cacheVersion,
        level.basis,
      ]),
    )
  }
  return {
    filename: `${result.pathNo}-层级状态.csv`,
    content: `﻿${lines.join('\n')}`,
    kind: 'manifest',
    levelIndex: null,
    rowCount: result.levels.length,
  }
}

export function buildDrillExport(
  result: DrillResult,
  options: { levelIndex?: number | null; rows?: DrillDetailRow[] } = {},
): DrillExportResult {
  const levelIndex = options.levelIndex ?? null
  // rows 由调用方按当前列表范围传入时，导出与列表逐行一致；不传则导整层。
  const selectedRows = options.rows ?? listDrillDetailRows(result, levelIndex)
  const directions = new Set(selectedRows.map((row) => row.sortDirection))
  const files: DrillExportFile[] = []
  let mode: 'single' | 'per-level'

  if (levelIndex !== null && directions.size <= 1) {
    // 指定单层时天然只有一个排序方向（即使只导出当前页），直接出单份文件。
    const level = result.levels.find((item) => item.levelIndex === levelIndex)
    mode = 'single'
    files.push(detailFile(result, level ? level.dimension : `第${levelIndex + 1}层`, selectedRows))
  } else if (directions.size <= 1) {
    mode = 'single'
    files.push(detailFile(result, '全部层级', selectedRows))
  } else {
    // 不同排序方向的层不能拼在一起：逐层导出，方向各自独立。
    mode = 'per-level'
    for (const level of result.levels) {
      const levelRows = selectedRows.filter((row) => row.levelIndex === level.levelIndex)
      if (levelRows.length === 0) continue
      files.push(detailFile(result, level.dimension, levelRows))
    }
  }
  files.push(levelManifestFile(result))
  const note = mode === 'single'
    ? `所选范围只有一种排序方向，合并为 1 份明细文件，另附层级状态文件`
    : `所选范围包含 ${directions.size} 种排序方向（${[...directions].map(sortDirectionLabel).join('、')}），已按层拆分为 ${files.length - 1} 份明细文件，未把不同排序方向拼在一起`
  return { mode, files, note }
}

export function summarizeDrillStrategy(result: DrillResult): DrillStrategySummary {
  const visibleRowsByLevel: Record<number, number> = {}
  let summaryRows = 0
  let detailRows = 0
  for (const level of result.levels) {
    visibleRowsByLevel[level.levelIndex] = level.visibleRows
    if (level.levelIndex === result.currentLevelIndex) {
      detailRows += level.visibleRows
    } else {
      summaryRows += level.visibleRows
    }
  }
  return {
    resultId: result.id,
    strategy: result.strategy,
    strategyLabel: result.strategyLabel,
    retainedLevels: result.retainedLevels,
    retainedLevelLabels: result.levels
      .filter((level) => level.retained)
      .map((level) => level.dimension),
    missingLevels: result.missingLevels,
    truncated: result.levels
      .filter((level) => level.state === 'truncated')
      .map((level) => ({
        levelIndex: level.levelIndex,
        level: level.dimension,
        visibleRows: level.visibleRows,
        totalRows: level.totalRows,
        truncatedAt: level.truncatedAt,
        basis: level.basis,
      })),
    visibleRowsByLevel,
    totalVisible: result.rows.length,
    summaryRows,
    detailRows,
    cacheVersionLabel: result.cacheVersionLabel,
    displayOrder: result.levels.map((level) => level.dimension),
  }
}

export function compareDrillStrategyResults(
  upperFirst: DrillResult,
  currentFirst: DrillResult,
): DrillStrategyComparison {
  const upperSummary = summarizeDrillStrategy(upperFirst)
  const currentSummary = summarizeDrillStrategy(currentFirst)
  const differences: string[] = []
  for (const level of upperFirst.levels) {
    const other = currentFirst.levels.find((item) => item.levelIndex === level.levelIndex)
    if (!other) continue
    if (other.visibleRows !== level.visibleRows || other.state !== level.state) {
      differences.push(
        `${level.dimension}：上级优先 ${level.visibleRows}/${level.totalRows} 行（${levelStateLabel(level.state)}，截断位置 ${level.truncatedAt ?? '—'}），当前层优先 ${other.visibleRows}/${other.totalRows} 行（${levelStateLabel(other.state)}，截断位置 ${other.truncatedAt ?? '—'}）`,
      )
    }
  }
  const directions = [...new Set(
    upperFirst.levels
      .filter((level) => level.visibleRows > 0)
      .map((level) => level.sortDirection),
  )]
  const mixed = directions.length > 1
  const conflict = differences.length > 0
  const conflictBasis = conflict
    ? `路径总预算 ${upperFirst.budget} 行不足以覆盖各层单层上限，两种做法分配结果不同：${differences.join('；')}。因此导出时按层拆分，避免混排。`
    : `路径总预算 ${upperFirst.budget} 行足以覆盖本次可见行，两种做法分配结果一致；各层截断位置相同${upperFirst.truncatedLevels.length > 0 ? `（${upperFirst.levels.filter((level) => level.state === 'truncated').map((level) => `${level.dimension}第 ${level.truncatedAt} 行`).join('、')}）` : ''}，冲突判定为「无冲突」。`
  return {
    pathNo: upperFirst.pathNo,
    metric: upperFirst.metric,
    budget: upperFirst.budget,
    levels: upperFirst.levels.map((level) => level.dimension),
    upperFirst: upperSummary,
    currentFirst: currentSummary,
    conflict,
    conflictBasis,
    sortDirections: directions,
    mixedSortDirections: mixed,
    exportMode: mixed ? 'per-level' : 'single',
    comparedAt: Date.now(),
  }
}
