/** 下钻结果数据层：按层级读取明细、按层限流，并把可用层组成可导出的字段明细。 */

export type DrillSortDirection = 'asc' | 'desc'

export type DrillStrategy = 'upper-first' | 'current-first'

export type DrillLevelState =
  | 'complete'
  | 'truncated'
  | 'missing-field'
  | 'empty'
  | 'deferred'
  | 'unavailable'

export type DrillSourceCell = string | number | undefined

export type DrillSourceRow = Record<string, DrillSourceCell>

export type DrillLevelConfig = {
  levelIndex: number
  dimension: string
  field: string
  sortDirection: DrillSortDirection
}

export type DrillPathConfig = {
  pathNo: string
  startDimension: string
  levelCount: number
  dimensions: string[]
  levels: DrillLevelConfig[]
  metric: string
  defaultExpandLevelIndex: number
  sortLabel: string
  maxRows: number
  rowBudget: number
}

export type DrillLevelCacheEntry = {
  pathNo: string
  levelIndex: number
  dimension: string
  version: number
  rows: DrillSourceRow[]
  refreshedAt: number
}

export type DrillCacheStore = Record<string, DrillLevelCacheEntry[]>

export type DrillDetailRow = {
  id: string
  pathNo: string
  levelIndex: number
  level: string
  levelState: DrillLevelState
  position: number
  seq: number
  dimensionValue: string
  aggregateMetric: string
  aggregateValue: number | null
  sortDirection: DrillSortDirection
  sortDirectionLabel: string
  cacheVersion: number
  truncated: boolean
  truncationAt: number | null
  levelTotalRows: number
  levelVisibleRows: number
}

export type DrillLevelLimitKind = 'none' | 'per-level' | 'budget' | 'both'

export type DrillLevelResult = {
  levelIndex: number
  dimension: string
  field: string
  state: DrillLevelState
  totalRows: number
  visibleRows: number
  allocatedRows: number
  desiredRows: number
  cap: number
  limit: number
  limitKind: DrillLevelLimitKind
  truncatedAt: number | null
  hiddenRows: number
  retained: boolean
  sortDirection: DrillSortDirection
  sortDirectionLabel: string
  cacheVersion: number
  basis: string
  rows: DrillDetailRow[]
}

export type DrillResult = {
  id: string
  requestKey: string
  pathNo: string
  pathSnapshot: Record<string, string | number | boolean>
  metric: string
  strategy: DrillStrategy
  strategyLabel: string
  budget: number
  maxRows: number
  currentLevelIndex: number
  levels: DrillLevelResult[]
  rows: DrillDetailRow[]
  retainedLevels: number[]
  truncatedLevels: number[]
  missingLevels: number[]
  deferredLevels: number[]
  cacheVersions: Record<number, number>
  cacheVersionLabel: string
  allocationBasis: string
  generatedAt: number
  attempts: number
}

export type DrillArchiveStore = Record<string, DrillResult>

export type DrillPageResult = {
  items: DrillDetailRow[]
  total: number
  page: number
  size: number
  totalPages: number
  levelIndex: number | null
}

export type DrillExportFile = {
  filename: string
  content: string
  kind: 'detail' | 'manifest'
  levelIndex: number | null
  rowCount: number
}

export type DrillExportResult = {
  mode: 'single' | 'per-level'
  files: DrillExportFile[]
  note: string
}

export type DrillStrategySummary = {
  resultId: string
  strategy: DrillStrategy
  strategyLabel: string
  retainedLevels: number[]
  retainedLevelLabels: string[]
  missingLevels: number[]
  truncated: {
    levelIndex: number
    level: string
    visibleRows: number
    totalRows: number
    truncatedAt: number | null
    basis: string
  }[]
  visibleRowsByLevel: Record<number, number>
  totalVisible: number
  summaryRows: number
  detailRows: number
  cacheVersionLabel: string
  displayOrder: string[]
}

export type DrillStrategyComparison = {
  pathNo: string
  metric: string
  budget: number
  levels: string[]
  upperFirst: DrillStrategySummary
  currentFirst: DrillStrategySummary
  conflict: boolean
  conflictBasis: string
  sortDirections: DrillSortDirection[]
  mixedSortDirections: boolean
  exportMode: 'single' | 'per-level'
  comparedAt: number
}
