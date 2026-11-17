import { DRILL_CACHE_SEED } from './drill-fixtures'
import type { DrillArchiveStore, DrillCacheStore, DrillLevelCacheEntry, DrillResult } from './drill-types'

// 下钻缓存与结果归档沿用本地存储约定：真正读写都在数据层，页面只经 local-service 调用。
const CACHE_STORAGE_KEY = 'data-explore-studio:drill-cache'
const ARCHIVE_STORAGE_KEY = 'data-explore-studio:drill-results'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
}

function writeJson<T>(key: string, value: T): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

let cacheStore: DrillCacheStore | null = null
let archiveStore: DrillArchiveStore | null = null

function ensureCache(): DrillCacheStore {
  if (cacheStore === null) {
    const seeded = readJson<DrillCacheStore>(CACHE_STORAGE_KEY, DRILL_CACHE_SEED)
    // 示例数据之后新增的路径也要能读到缓存，缺的路径用种子补齐。
    cacheStore = { ...clone(DRILL_CACHE_SEED), ...seeded }
  }
  return cacheStore
}

export function listDrillLevelCache(pathNo: string): DrillLevelCacheEntry[] {
  const entries = ensureCache()[pathNo] ?? []
  return clone(entries).sort((left, right) => left.levelIndex - right.levelIndex)
}

export function saveDrillLevelCacheEntry(pathNo: string, entry: DrillLevelCacheEntry): DrillLevelCacheEntry[] {
  const current = ensureCache()[pathNo] ?? []
  // 只替换命中的那一层，其他层的行数与版本原样保留，避免重复行或丢掉截断位置。
  const found = current.some((item) => item.levelIndex === entry.levelIndex)
  const next: DrillLevelCacheEntry[] = found
    ? current.map((item) => (item.levelIndex === entry.levelIndex ? clone(entry) : item))
    : [...current, clone(entry)].sort((left, right) => left.levelIndex - right.levelIndex)
  cacheStore = { ...ensureCache(), [pathNo]: next }
  writeJson(CACHE_STORAGE_KEY, cacheStore)
  return clone(next)
}

export function resetDrillCache(pathNo: string): DrillLevelCacheEntry[] {
  const seeded = clone(DRILL_CACHE_SEED[pathNo] ?? [])
  cacheStore = { ...ensureCache(), [pathNo]: seeded }
  writeJson(CACHE_STORAGE_KEY, cacheStore)
  return clone(seeded)
}

export function listDrillResults(): DrillResult[] {
  if (archiveStore === null) {
    archiveStore = readJson<DrillArchiveStore>(ARCHIVE_STORAGE_KEY, {})
  }
  return Object.values(archiveStore)
    .map((item) => clone(item))
    .sort((left, right) => left.generatedAt - right.generatedAt)
}

export function getDrillResult(requestKey: string): DrillResult | null {
  if (archiveStore === null) {
    archiveStore = readJson<DrillArchiveStore>(ARCHIVE_STORAGE_KEY, {})
  }
  const found = archiveStore[requestKey]
  return found ? clone(found) : null
}

export function saveDrillResult(result: DrillResult): void {
  if (archiveStore === null) {
    archiveStore = readJson<DrillArchiveStore>(ARCHIVE_STORAGE_KEY, {})
  }
  // 以 requestKey 为归档主键：并发重试和缓存签名变化都覆盖同一条结果，不会多出第二份明细。
  archiveStore = { ...archiveStore, [result.requestKey]: clone(result) }
  writeJson(ARCHIVE_STORAGE_KEY, archiveStore)
}

export function clearDrillResults(): void {
  archiveStore = {}
  writeJson(ARCHIVE_STORAGE_KEY, archiveStore)
}
