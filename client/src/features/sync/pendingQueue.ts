import { STORE_PENDING, tx } from '../cache/db'

/**
 * 离线待同步队列。
 *
 * 契约 §6.3：进度上报任一次失败即写入本地待同步队列，由 §8 的批量同步补报。
 * 契约 §2.2.6 的可靠性要求：冲突处理中断后未决冲突不得丢失。
 *
 * 存 IndexedDB 而不是内存，这样刷新页面甚至关掉浏览器再打开也还在。
 */

export interface PendingChange {
  id: string
  docId: string
  /**
   * progress / bookmark 两条走 §8 的批量同步；
   * readingTime（R7-5）不进那套合并机制 —— 它是纯追加的遥测，
   * 自己补报即可（见 useReadingTime 里的 replayPending）。
   */
  kind: 'progress' | 'bookmark' | 'readingTime'
  /** 与 §8.1 请求体里对应集合的元素形状一致 */
  payload: unknown
  at: number
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '')
  }
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`
}

export async function enqueuePending(
  docId: string,
  kind: PendingChange['kind'],
  payload: unknown,
): Promise<void> {
  const row: PendingChange = { id: uuid(), docId, kind, payload, at: Date.now() }
  await tx(STORE_PENDING, 'readwrite', (s) => s.put(row))
}

export async function listPending(docId?: string): Promise<PendingChange[]> {
  const all = (await tx<PendingChange[]>(STORE_PENDING, 'readonly', (s) => s.getAll())) ?? []
  const filtered = docId ? all.filter((p) => p.docId === docId) : all
  return filtered.sort((a, b) => a.at - b.at)
}

export async function clearPending(ids: string[]): Promise<void> {
  for (const id of ids) {
    await tx(STORE_PENDING, 'readwrite', (s) => s.delete(id))
  }
}

export async function pendingCount(): Promise<number> {
  const all = (await tx<PendingChange[]>(STORE_PENDING, 'readonly', (s) => s.getAll())) ?? []
  return all.length
}
