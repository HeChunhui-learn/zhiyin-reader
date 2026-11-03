/**
 * 图片本地缓存。
 *
 * 依据 docs/system-design.md §6.2 / §8：
 *   · 图片缓存上限 200MB 或单文档 300 张（先到者为准）
 *   · 超出时按最后访问时间淘汰最早的条目
 *
 * 这里是"本地副本"这一层；上方还有一层内存里的 object URL 缓存，
 * 由调用方在图片离开视口时显式 revoke（见本文件末尾的 objectUrl 系列）。
 *
 * 存储细节见 features/cache/db.ts，与音频缓存共用同一个 IndexedDB。
 */

import {
  STORE_IMAGES,
  evictByLru,
  tx,
} from '../cache/db'

export const MAX_IMAGES_PER_DOC = 300
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024 // 200MB

export interface CachedImage {
  imageId: string
  docId: string
  blob: Blob
  bytes: number
  lastAccess: number
}

/* ------------------------------------------------------------- 对外接口 */

export async function cachePut(
  docId: string,
  imageId: string,
  blob: Blob,
): Promise<void> {
  await tx(STORE_IMAGES, 'readwrite', (s) =>
    s.put({
      imageId,
      docId,
      blob,
      bytes: blob.size,
      lastAccess: Date.now(),
    } satisfies CachedImage),
  )
  void enforceLimits()
}

/** 取图并刷新访问时间（LRU 的"最近使用"） */
export async function cacheGet(imageId: string): Promise<Blob | null> {
  const row = await tx<CachedImage | undefined>(STORE_IMAGES, 'readonly', (s) =>
    s.get(imageId),
  )
  if (!row) return null
  // 异步刷新 lastAccess，不阻塞取图
  void tx(STORE_IMAGES, 'readwrite', (s) => s.put({ ...row, lastAccess: Date.now() }))
  return row.blob
}

export async function cacheHas(imageId: string): Promise<boolean> {
  const key = await tx<IDBValidKey | undefined>(STORE_IMAGES, 'readonly', (s) =>
    s.getKey(imageId),
  )
  return key !== undefined && key !== null
}

export async function cacheDelete(imageId: string): Promise<void> {
  await tx(STORE_IMAGES, 'readwrite', (s) => s.delete(imageId))
}

export async function cacheClear(): Promise<void> {
  await tx(STORE_IMAGES, 'readwrite', (s) => s.clear())
}

export interface CacheStats {
  count: number
  bytes: number
}

export async function cacheStats(): Promise<CacheStats> {
  const rows = (await tx<CachedImage[]>(STORE_IMAGES, 'readonly', (s) => s.getAll())) ?? []
  return {
    count: rows.length,
    bytes: rows.reduce((n, r) => n + (r.bytes ?? 0), 0),
  }
}

/** 按 docs/system-design.md §6.2 / §8 的两条上限淘汰，返回淘汰条数 */
export async function enforceLimits(): Promise<number> {
  const rows = (await tx<CachedImage[]>(STORE_IMAGES, 'readonly', (s) => s.getAll())) ?? []
  return evictByLru<CachedImage>(
    STORE_IMAGES,
    (r) => r.imageId,
    rows,
    MAX_IMAGES_PER_DOC,
    MAX_TOTAL_BYTES,
  )
}

/* -------------------------------------------------- 内存中的 object URL 层 */

/**
 * object URL 必须显式 revoke，否则对应的 Blob 不会被回收（docs/system-design.md §6.2 / §8）。
 * 这里做一层薄封装：同一个 imageId 复用同一个 URL，释放时统一撤销。
 */
const urls = new Map<string, string>()

export function objectUrl(imageId: string, blob: Blob): string {
  const existing = urls.get(imageId)
  if (existing) return existing
  const url = URL.createObjectURL(blob)
  urls.set(imageId, url)
  return url
}

export function releaseObjectUrl(imageId: string): void {
  const url = urls.get(imageId)
  if (!url) return
  URL.revokeObjectURL(url)
  urls.delete(imageId)
}

export function releaseAllObjectUrls(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url)
  urls.clear()
}

export function objectUrlCount(): number {
  return urls.size
}
