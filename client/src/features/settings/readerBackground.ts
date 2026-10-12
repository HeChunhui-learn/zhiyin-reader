/**
 * 阅读背景图。
 *
 * 存**原始 Blob** 进 IndexedDB，不走 localStorage：后者只有约 5MB，
 * 而且 base64 还要再膨胀三分之一 —— 一张手机壁纸就把它撑爆，
 * 爆的时候会连累同一次写入里的其他偏好项。
 *
 * 存法参照 features/render/imageCache.ts：数据一层（IndexedDB），
 * 上面再套一层内存里的 object URL。**object URL 必须显式 revoke**，
 * 否则对应的 Blob 不会被回收。
 */

import { STORE_READER_BG, tx } from '../cache/db'

/** 只有一张，固定键 */
export const BG_IMAGE_ID = 'current'

/** 单张背景图上限。比正文插图（10MB）小一档：它是读者自己挑的壁纸，用不着那么大 */
export const MAX_BG_BYTES = 8 * 1024 * 1024

export interface StoredBackground {
  id: string
  blob: Blob
  bytes: number
  fileName: string
  updatedAt: number
}

/** 写入背景图。类型和大小不合规时抛中文错误，由界面显示出来 */
export async function putBackground(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) {
    throw new Error('只能选图片文件（png / jpg / webp 等）。')
  }
  if (file.size > MAX_BG_BYTES) {
    throw new Error(`背景图不能超过 ${Math.round(MAX_BG_BYTES / 1024 / 1024)}MB。`)
  }

  const row: StoredBackground = {
    id: BG_IMAGE_ID,
    blob: file,
    bytes: file.size,
    fileName: file.name,
    updatedAt: Date.now(),
  }
  await tx(STORE_READER_BG, 'readwrite', (s) => s.put(row))

  // 换了图，旧 URL 立刻作废，否则会一直指着上一张
  releaseBackgroundUrl()
}

/**
 * 取背景图。返回 null 表示"没有"或"IndexedDB 用不了"——
 * 两者对调用方是一回事：不画背景就是了。
 */
export async function getBackground(): Promise<Blob | null> {
  const row = await tx<StoredBackground | undefined>(STORE_READER_BG, 'readonly', (s) =>
    s.get(BG_IMAGE_ID),
  )
  return row?.blob ?? null
}

export async function clearBackground(): Promise<void> {
  await tx(STORE_READER_BG, 'readwrite', (s) => s.delete(BG_IMAGE_ID))
  releaseBackgroundUrl()
}

/* -------------------------------------------------- 内存中的 object URL 层 */

let currentUrl: string | null = null

/**
 * 每次都从同一个 Blob 造 URL，所以同一个进程里复用一份。
 * 注意不能把 URL 存进 localStorage —— 它只在本页面生命周期内有效，
 * 刷新之后就是一条死链。
 */
export function backgroundUrl(blob: Blob): string {
  if (!currentUrl) currentUrl = URL.createObjectURL(blob)
  return currentUrl
}

export function releaseBackgroundUrl(): void {
  if (!currentUrl) return
  URL.revokeObjectURL(currentUrl)
  currentUrl = null
}
