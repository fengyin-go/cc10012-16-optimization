import type {
  DrillLevelCacheEntry,
  DrillPathConfig,
  DrillSourceRow,
  DrillSortDirection,
} from './drill-types'

// 下钻示例数据：源数据是门店粒度，区域/城市层由同一份源数据按维度聚合，
// 因此某一层缺字段时只会影响该层，不会让整条路径变空。

type StoreSeed = [region: string, city: string, store: string, sales: number, category: string]

const STORE_SEEDS: StoreSeed[] = [
  ['华东', '上海', '上海一店', 1280, '生鲜'],
  ['华东', '上海', '上海二店', 960, '粮油'],
  ['华东', '上海', '上海三店', 1420, '家电'],
  ['华东', '上海', '上海四店', 740, '服饰'],
  ['华东', '杭州', '杭州一店', 880, '生鲜'],
  ['华东', '杭州', '杭州二店', 1120, '美妆'],
  ['华南', '广州', '广州一店', 1350, '母婴'],
  ['华南', '广州', '广州二店', 790, '家电'],
  ['华南', '深圳', '深圳一店', 1510, '生鲜'],
  ['华南', '深圳', '深圳二店', 1040, '服饰'],
  ['华南', '深圳', '深圳三店', 680, '粮油'],
  ['华北', '北京', '北京一店', 1680, '家电'],
  ['华北', '北京', '北京二店', 1210, '美妆'],
  ['华北', '天津', '天津一店', 530, '母婴'],
  ['西南', '成都', '成都一店', 920, '生鲜'],
  ['西南', '成都', '成都二店', 1440, '服饰'],
  ['西南', '重庆', '重庆一店', 660, '粮油'],
  ['西南', '重庆', '重庆二店', 1070, '家电'],
]

const DRILL_0001_STORES = new Set([
  '上海一店',
  '上海二店',
  '杭州一店',
  '广州一店',
  '广州二店',
  '深圳一店',
  '北京一店',
  '北京二店',
  '天津一店',
])

function toRow([region, city, store, sales, category]: StoreSeed, withCity = true): DrillSourceRow {
  const row: DrillSourceRow = {
    区域: region,
    门店: store,
    品类: category,
    销售额: sales,
  }
  if (withCity) {
    row.城市 = city
  }
  return row
}

export const DRILL_SOURCES: Record<string, DrillSourceRow[]> = {
  'DRIL-0001': STORE_SEEDS.filter((seed) => DRILL_0001_STORES.has(seed[2])).map((seed) => toRow(seed)),
  // 城市维度在源数据里整体缺失：城市层应标记缺字段，区域层与门店层照常可用。
  'DRIL-0002': STORE_SEEDS.map((seed) => toRow(seed, false)),
  'DRIL-0003': STORE_SEEDS.map((seed) => toRow(seed)),
  // 城市缺字段 + 门店层超限同时出现，用来验证上级区域层与下级品类层仍然完整可见。
  'DRIL-0004': STORE_SEEDS.map((seed) => toRow(seed, false)),
}

function level(
  levelIndex: number,
  dimension: string,
  sortDirection: DrillSortDirection,
): DrillPathConfig['levels'][number] {
  return { levelIndex, dimension, field: dimension, sortDirection }
}

export const DRILL_PATH_CONFIGS: Record<string, DrillPathConfig> = {
  'DRIL-0001': {
    pathNo: 'DRIL-0001',
    startDimension: '区域',
    levelCount: 3,
    dimensions: ['区域', '城市', '门店'],
    levels: [level(0, '区域', 'desc'), level(1, '城市', 'desc'), level(2, '门店', 'desc')],
    metric: '销售额',
    defaultExpandLevelIndex: 2,
    sortLabel: '降序',
    maxRows: 10,
    // 预算刻意收紧：上级优先会多留城市汇总，当前层优先会把预算让给门店明细。
    rowBudget: 16,
  },
  'DRIL-0002': {
    pathNo: 'DRIL-0002',
    startDimension: '区域',
    levelCount: 3,
    dimensions: ['区域', '城市', '门店'],
    levels: [level(0, '区域', 'asc'), level(1, '城市', 'desc'), level(2, '门店', 'desc')],
    metric: '销售额',
    defaultExpandLevelIndex: 2,
    sortLabel: '区域升序 / 明细降序',
    maxRows: 10,
    // 区域层 4 行 + 缺字段的城市层 0 行 + 门店层 10 行，正好用满预算。
    rowBudget: 14,
  },
  'DRIL-0003': {
    pathNo: 'DRIL-0003',
    startDimension: '区域',
    levelCount: 3,
    dimensions: ['区域', '城市', '门店'],
    levels: [level(0, '区域', 'desc'), level(1, '城市', 'desc'), level(2, '门店', 'desc')],
    metric: '销售额',
    defaultExpandLevelIndex: 2,
    sortLabel: '降序',
    maxRows: 10,
    // 门店层 18 行只展示前 10 行；区域 4 行、城市 8 行完整可见。
    rowBudget: 30,
  },
  'DRIL-0004': {
    pathNo: 'DRIL-0004',
    startDimension: '区域',
    levelCount: 4,
    dimensions: ['区域', '城市', '门店', '品类'],
    levels: [
      level(0, '区域', 'desc'),
      level(1, '城市', 'desc'),
      level(2, '门店', 'desc'),
      level(3, '品类', 'desc'),
    ],
    metric: '销售额',
    defaultExpandLevelIndex: 2,
    sortLabel: '降序',
    maxRows: 10,
    // 城市层缺字段、门店层 18 行截到 10 行时，区域层 4 行与品类层 6 行仍应完整。
    rowBudget: 30,
  },
}

const CACHE_VERSIONS: Record<string, number[]> = {
  'DRIL-0001': [1, 1, 1],
  'DRIL-0002': [2, 1, 4],
  'DRIL-0003': [3, 2, 5],
  'DRIL-0004': [1, 2, 3, 1],
}

const BASE_REFRESHED_AT = Date.UTC(2026, 10, 17, 1, 0, 0)

export const DRILL_CACHE_SEED: Record<string, DrillLevelCacheEntry[]> = Object.fromEntries(
  Object.entries(DRILL_PATH_CONFIGS).map(([pathNo, config]) => {
    const versions = CACHE_VERSIONS[pathNo] ?? config.levels.map(() => 1)
    const entries = config.levels.map((item, index) => ({
      pathNo,
      levelIndex: item.levelIndex,
      dimension: item.dimension,
      version: versions[index] ?? 1,
      rows: DRILL_SOURCES[pathNo] ?? [],
      refreshedAt: BASE_REFRESHED_AT + index * 60_000,
    }))
    return [pathNo, entries]
  }),
)
