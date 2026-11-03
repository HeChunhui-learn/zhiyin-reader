import {
  ApiError,
  api,
  type Anchor,
  type BookmarkPayload,
  type SyncRequest,
} from '../../api/client'
import { getDeviceId } from '../../api/device'
import { clearPending, listPending, type PendingChange } from './pendingQueue'

/**
 * 一键同步。
 *
 * 平时的进度/书签是各写各的：成功的即时落库，失败的进 IndexedDB 待同步队列。
 * 这个入口把队列里攒下的变更一次性补报，再读回未决冲突，让读者不用等下一次
 * 自动同步、也不用逐本打开文档。
 *
 * 只处理 progress / bookmark 两类；readingTime 是纯追加的遥测，由
 * useReadingTime 自己补报，不混进 §8 的合并机制。
 */

export interface OneClickSyncResult {
  /** 本次补报成功的队列条目数 */
  flushed: number
  /** 同步后仍待裁决的冲突数 */
  conflicts: number
}

interface QueuedProgress {
  docId: string
  anchor: Anchor
  lastSentenceIndex: number | null
  updatedAt: string
  baseVersion: number
}

type QueuedBookmark = BookmarkPayload & { kind: 'created' }

function groupByDoc(items: PendingChange[]): Map<string, PendingChange[]> {
  const map = new Map<string, PendingChange[]>()
  for (const item of items) {
    const list = map.get(item.docId) ?? []
    list.push(item)
    map.set(item.docId, list)
  }
  return map
}

function toProgress(item: PendingChange): QueuedProgress {
  const p = item.payload as QueuedProgress
  return {
    docId: item.docId,
    anchor: p.anchor,
    lastSentenceIndex: p.lastSentenceIndex ?? null,
    updatedAt: p.updatedAt,
    baseVersion: p.baseVersion ?? 0,
  }
}

function toCreatedBookmark(item: PendingChange): BookmarkPayload {
  const p = item.payload as QueuedBookmark
  return {
    bookmarkId: p.bookmarkId,
    docId: item.docId,
    anchor: p.anchor,
    name: p.name ?? null,
    chapterTitle: p.chapterTitle ?? null,
    updatedAt: p.updatedAt,
  }
}

/** 待补报的进度/书签条数，用于徽标显示 */
export async function pendingSyncCount(): Promise<number> {
  const all = await listPending()
  return all.filter((p) => p.kind === 'progress' || p.kind === 'bookmark').length
}

export async function syncAllPending(): Promise<OneClickSyncResult> {
  const deviceId = getDeviceId()
  const pending = await listPending()
  const progress = pending.filter((p) => p.kind === 'progress')
  const bookmarks = pending.filter(
    (p) => p.kind === 'bookmark' && (p.payload as { kind?: string }).kind === 'created',
  )

  // 一次点击一个幂等键：网络抖动后重试不会把同一批变更落两遍
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  let flushed = 0
  let conflicts = 0

  for (const [docId, items] of groupByDoc(progress)) {
    // 同一本可能排了多条进度，只补报最后一条；更早的已经被覆盖
    const latest = items[items.length - 1]
    const body: SyncRequest = {
      deviceId,
      since: null,
      progress: toProgress(latest),
    }
    try {
      const res = await api.sync(body, `all_${runId}_p_${docId}`)
      conflicts += res.conflicts.length
      await clearPending(items.map((i) => i.id))
      flushed += items.length
    } catch (e) {
      // 文档已被删除：这条队列记录永远补不上，清掉别让它卡住整次同步
      if (e instanceof ApiError && e.status === 404) {
        await clearPending(items.map((i) => i.id))
        continue
      }
      throw e
    }
  }

  for (const [docId, items] of groupByDoc(bookmarks)) {
    const body: SyncRequest = {
      deviceId,
      since: null,
      bookmarks: { created: items.map(toCreatedBookmark) },
    }
    try {
      const res = await api.sync(body, `all_${runId}_b_${docId}`)
      conflicts += res.conflicts.length
      await clearPending(items.map((i) => i.id))
      flushed += items.length
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        await clearPending(items.map((i) => i.id))
        continue
      }
      throw e
    }
  }

  // 服务端的未决冲突才是权威：批量同步响应里的可能只是本轮的
  try {
    const res = await api.listConflicts()
    conflicts = res.items.length
  } catch {
    /* 读不回冲突不阻断同步结果，保留响应里的计数 */
  }

  return { flushed, conflicts }
}
