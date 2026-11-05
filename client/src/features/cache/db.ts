/**
 * 本地缓存的公共层。
 *
 * 图片缓存与音频缓存放在同一个 IndexedDB 里的两个 store：
 * 它们的上限与淘汰策略是同一套（docs/system-design.md §6.2 / §8），放在一起才好统一管理。
 *
 * IndexedDB 不可用时（隐私模式、旧浏览器）整体降级为"没有缓存"，
 * 所有读写都安静地返回空值，绝不抛错把界面搞崩。
 */

export const DB_NAME = 'zhiyin-cache'
export const DB_VERSION = 4

export const STORE_IMAGES = 'images'
export const STORE_AUDIO = 'audio'
/** 离线待同步队列：网络失败时把变更记在这里，下次同步补报（契约 §6.3、§8） */
export const STORE_PENDING = 'pending'
/**
 * 阅读背景图（R7-3）。读者自己挑的壁纸，只有一条记录。
 * 二进制**不上传服务端** —— 它是读者偏好，不是文档内容，不该跟着文档走。
 */
export const STORE_READER_BG = 'readerbg'

export type StoreName =
  | typeof STORE_IMAGES
  | typeof STORE_AUDIO
  | typeof STORE_PENDING
  | typeof STORE_READER_BG

let dbPromise: Promise<IDBDatabase | null> | null = null

export function openCacheDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }

    req.onupgradeneeded = () => {
      const db = req.result
      // 老版本升上来时只建缺的 store
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        const s = db.createObjectStore(STORE_IMAGES, { keyPath: 'imageId' })
        s.createIndex('docId', 'docId', { unique: false })
        s.createIndex('lastAccess', 'lastAccess', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORE_AUDIO)) {
        const s = db.createObjectStore(STORE_AUDIO, { keyPath: 'cacheKey' })
        s.createIndex('docId', 'docId', { unique: false })
        s.createIndex('lastAccess', 'lastAccess', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORE_PENDING)) {
        const s = db.createObjectStore(STORE_PENDING, { keyPath: 'id' })
        s.createIndex('docId', 'docId', { unique: false })
        s.createIndex('at', 'at', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORE_READER_BG)) {
        // 只有一条记录，固定主键，换图即覆盖，不留孤儿
        db.createObjectStore(STORE_READER_BG, { keyPath: 'id' })
      }
    }

    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })

  return dbPromise
}

/** 在一个 store 上跑一次请求；出错一律返回 null，调用方按"没有"处理 */
export function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openCacheDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null)
          return
        }
        try {
          const t = db.transaction(store, mode)
          const req = fn(t.objectStore(store))
          req.onsuccess = () => resolve(req.result as T)
          req.onerror = () => resolve(null)
          t.onabort = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

export function isCacheAvailable(): Promise<boolean> {
  return openCacheDb().then((db) => db !== null)
}

export interface CacheRow {
  docId: string
  bytes: number
  lastAccess: number
}

/**
 * 按最近访问时间淘汰，两条上限先到者为准（docs/system-design.md §6.2 / §8）：
 *   · 单个文档超过 maxPerDoc 条
 *   · 总量超过 maxBytes
 * 返回被删掉的条目数。
 */
export async function evictByLru<T extends CacheRow>(
  store: StoreName,
  keyOf: (row: T) => IDBValidKey,
  rows: T[],
  maxPerDoc: number,
  maxBytes: number,
): Promise<number> {
  if (rows.length === 0) return 0

  const doomed = new Set<IDBValidKey>()
  const byDoc = new Map<string, T[]>()
  for (const r of rows) {
    const list = byDoc.get(r.docId)
    if (list) list.push(r)
    else byDoc.set(r.docId, [r])
  }

  for (const list of byDoc.values()) {
    if (list.length <= maxPerDoc) continue
    list
      .sort((a, b) => a.lastAccess - b.lastAccess)
      .slice(0, list.length - maxPerDoc)
      .forEach((r) => doomed.add(keyOf(r)))
  }

  let total = rows.reduce((n, r) => (doomed.has(keyOf(r)) ? n : n + r.bytes), 0)
  if (total > maxBytes) {
    const rest = rows
      .filter((r) => !doomed.has(keyOf(r)))
      .sort((a, b) => a.lastAccess - b.lastAccess)
    for (const r of rest) {
      if (total <= maxBytes) break
      doomed.add(keyOf(r))
      total -= r.bytes
    }
  }

  for (const k of doomed) {
    await tx(store, 'readwrite', (s) => s.delete(k))
  }
  return doomed.size
}
