import { STORE_PENDING, tx } from '../cache/db'

/**
 * 离线待同步队列。
 *
 * 契约 §6.3：进度上报任一次失败即写入本地待同步队列，由 §8 的批量同步补报。
 * 契约 §2.2.6 的可靠性要求：冲突处理中断后未决冲突不得丢失。
 *
 * 存 IndexedDB 而不是内存，这样刷新页面甚至关掉浏览器再打开也还在。
 *
 * **队列按读者隔离**：同一个浏览器可能先后登录不同账号，队列里必须记下
 * 归属读者，否则 B 登录后会把 A 的离线书签补报到 B 的身份下（审查发现）。
 * 旧版本没有 userId 的行一律忽略，宁可少补报也不跨账号写入。
 */

export interface PendingChange {
  id: string
  /** 归属读者；旧版本写入的行没有这个字段，读出来按"不属于任何人"处理 */
  userId: string | null
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

function payloadOf(row: PendingChange): Record<string, unknown> {
  return row.payload && typeof row.payload === 'object'
    ? (row.payload as Record<string, unknown>)
    : {}
}

/**
 * 纯过滤：当前读者 + 可选文档范围。
 *
 * userId 为空时返回空数组 —— 未登录状态下绝不能把队列里的东西当成"无主"补报。
 */
export function selectPending(
  all: PendingChange[],
  userId: string | null,
  docId?: string,
): PendingChange[] {
  if (!userId) return []
  return all
    .filter((p) => p.userId === userId)
    .filter((p) => !docId || p.docId === docId)
    .sort((a, b) => a.at - b.at)
}

/**
 * 一次进度上报成功后，哪些队列行可以清掉。
 *
 * 只清同一文档里不晚于这次成功时间的行：请求飞行期间新排进来的那条
 * （时间戳更晚）必须留着，不能把它一起删掉。
 */
export function pickSyncedProgress(
  all: PendingChange[],
  docId: string,
  updatedAt: string,
): PendingChange[] {
  return all.filter((p) => {
    if (p.kind !== 'progress' || p.docId !== docId) return false
    const at = payloadOf(p).updatedAt
    return typeof at === 'string' && at <= updatedAt
  })
}

/** 在线创建书签成功后，清掉同 bookmarkId 的离线 created 行 */
export function pickSyncedBookmark(
  all: PendingChange[],
  bookmarkId: string,
): PendingChange[] {
  return all.filter((p) => {
    if (p.kind !== 'bookmark') return false
    const payload = payloadOf(p)
    return payload.kind === 'created' && payload.bookmarkId === bookmarkId
  })
}

export async function enqueuePending(
  docId: string,
  kind: PendingChange['kind'],
  payload: unknown,
  userId: string | null,
): Promise<void> {
  const row: PendingChange = { id: uuid(), userId, docId, kind, payload, at: Date.now() }
  await tx(STORE_PENDING, 'readwrite', (s) => s.put(row))
}

export async function listPending(userId: string | null, docId?: string): Promise<PendingChange[]> {
  const all = (await tx<PendingChange[]>(STORE_PENDING, 'readonly', (s) => s.getAll())) ?? []
  return selectPending(all, userId, docId)
}

export async function clearPending(ids: string[]): Promise<void> {
  for (const id of ids) {
    await tx(STORE_PENDING, 'readwrite', (s) => s.delete(id))
  }
}

/** 待同步条数：进度与书签才算，阅读时长由它自己补报 */
export async function pendingCount(userId: string | null): Promise<number> {
  const all = await listPending(userId)
  return all.filter((p) => p.kind === 'progress' || p.kind === 'bookmark').length
}
