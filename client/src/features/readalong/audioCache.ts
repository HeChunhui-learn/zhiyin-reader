/**
 * 音频本地缓存。
 *
 * 依据 04 §4.1.3：音频缓存上限为**单文档 60MB**，超出时按最后访问时间淘汰。
 * 缓存键由契约 §9.2 规定：sha256(engine + voice + rate + text)，
 * 客户端命中时**不发起**合成请求 —— 这是"二次朗读不重复合成"的关键。
 */

import { STORE_AUDIO, evictByLru, tx } from '../cache/db'

export const MAX_AUDIO_BYTES_PER_DOC = 60 * 1024 * 1024 // 60MB

export interface CachedAudio {
  cacheKey: string
  docId: string
  blob: Blob
  bytes: number
  lastAccess: number
}

export async function audioCachePut(
  docId: string,
  cacheKey: string,
  blob: Blob,
): Promise<void> {
  await tx(STORE_AUDIO, 'readwrite', (s) =>
    s.put({
      cacheKey,
      docId,
      blob,
      bytes: blob.size,
      lastAccess: Date.now(),
    } satisfies CachedAudio),
  )
  void enforceAudioLimits()
}

export async function audioCacheGet(cacheKey: string): Promise<Blob | null> {
  const row = await tx<CachedAudio | undefined>(STORE_AUDIO, 'readonly', (s) =>
    s.get(cacheKey),
  )
  if (!row) return null
  void tx(STORE_AUDIO, 'readwrite', (s) =>
    s.put({ ...row, lastAccess: Date.now() }),
  )
  return row.blob
}

export async function audioCacheClear(): Promise<void> {
  await tx(STORE_AUDIO, 'readwrite', (s) => s.clear())
}

export interface AudioCacheStats {
  count: number
  bytes: number
}

export async function audioCacheStats(): Promise<AudioCacheStats> {
  const rows = (await tx<CachedAudio[]>(STORE_AUDIO, 'readonly', (s) => s.getAll())) ?? []
  return {
    count: rows.length,
    bytes: rows.reduce((n, r) => n + (r.bytes ?? 0), 0),
  }
}

/** 单文档 60MB 上限，超出按最近使用时间淘汰 */
export async function enforceAudioLimits(): Promise<number> {
  const rows = (await tx<CachedAudio[]>(STORE_AUDIO, 'readonly', (s) => s.getAll())) ?? []
  return evictByLru<CachedAudio>(
    STORE_AUDIO,
    (r) => r.cacheKey,
    rows,
    Number.MAX_SAFE_INTEGER, // 音频只按体积限制，不按条数
    MAX_AUDIO_BYTES_PER_DOC,
  )
}
