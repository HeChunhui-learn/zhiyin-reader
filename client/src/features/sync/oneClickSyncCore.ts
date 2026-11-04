import type { PendingChange } from './pendingQueue'

/**
 * 一键同步的编排核心（无 IndexedDB / 无 fetch 依赖，便于单测）。
 *
 * 真实入口在 oneClickSync.ts：它把 IndexedDB 与 api 注入进来。
 *
 * 三条编排规则：
 *   1. 只处理当前读者的队列（deps.listPending 可能已经过滤，这里再兜一层）；
 *   2. 进度按文档分组、只补最后一条；书签合并成**一次**请求，不按文档串行；
 *   3. 某一组失败不能拖垮其余组；404（文档已删）清队列，5xx 保留待重试。
 */

export type PendingLike = Pick<PendingChange, 'id' | 'userId' | 'docId' | 'kind' | 'payload' | 'at'>

export interface SyncBodyLike {
  deviceId: string
  since: string | null
  /** 一键同步不消费 changes，关掉服务端的全量增量扫描 */
  includeChanges?: boolean
  progress?: {
    docId: string
    anchor: unknown
    lastSentenceIndex: number | null
    updatedAt: string
    baseVersion: number
  } | null
  bookmarks?: {
    created?: {
      bookmarkId: string
      docId: string
      anchor: unknown
      name: string | null
      chapterTitle?: string | null
      updatedAt: string
    }[]
  }
}

export interface SyncResultLike {
  conflicts: unknown[]
  applied?: {
    bookmarks?: {
      /** 文档已删除 / 不属于当前读者 / 缺 docId 的条目 */
      skipped?: string[]
    }
  }
}

export interface SyncDeps {
  userId: string
  deviceId: string
  listPending: () => Promise<PendingLike[]>
  clearPending: (ids: string[]) => Promise<void>
  sync: (body: SyncBodyLike, idemKey: string) => Promise<SyncResultLike>
  listConflicts: () => Promise<{ items: unknown[] }>
}

export interface OneClickSyncResult {
  /** 本次补报成功的队列条目数 */
  flushed: number
  /** 同步后仍待裁决的冲突数 */
  conflicts: number
  /** 因网络 / 服务端错误没补报成功的组数（404 不算） */
  failed: number
}

function payloadOf(row: PendingLike): Record<string, unknown> {
  return row.payload && typeof row.payload === 'object'
    ? (row.payload as Record<string, unknown>)
    : {}
}

function statusOf(e: unknown): number | undefined {
  return typeof (e as { status?: unknown })?.status === 'number'
    ? (e as { status: number }).status
    : undefined
}

/** 待同步条数：只算进度与书签，阅读时长由它自己补报 */
export function countPendingForUser(all: PendingLike[], userId: string): number {
  return all.filter(
    (p) => p.userId === userId && (p.kind === 'progress' || p.kind === 'bookmark'),
  ).length
}

function toProgress(item: PendingLike) {
  const p = payloadOf(item)
  return {
    docId: item.docId,
    anchor: p.anchor,
    lastSentenceIndex: (p.lastSentenceIndex as number | null | undefined) ?? null,
    updatedAt: String(p.updatedAt ?? ''),
    baseVersion: Number(p.baseVersion ?? 0),
  }
}

function toCreatedBookmark(item: PendingLike) {
  const p = payloadOf(item)
  return {
    bookmarkId: String(p.bookmarkId ?? ''),
    docId: item.docId,
    anchor: p.anchor,
    name: (p.name as string | null | undefined) ?? null,
    chapterTitle: (p.chapterTitle as string | null | undefined) ?? null,
    updatedAt: String(p.updatedAt ?? ''),
  }
}

export async function runOneClickSync(deps: SyncDeps): Promise<OneClickSyncResult> {
  const all = await deps.listPending()
  const mine = all
    .filter((p) => p.userId === deps.userId)
    .sort((a, b) => a.at - b.at)

  const progress = mine.filter((p) => p.kind === 'progress')
  const bookmarks = mine.filter(
    (p) => p.kind === 'bookmark' && payloadOf(p).kind === 'created',
  )

  // 一次点击一个前缀：网络抖动后重试不会把同一批变更落两遍
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  let flushed = 0
  let conflicts = 0
  let failed = 0

  /* ---- 进度：按文档分组，同一本只补最后一条 ---- */
  const progressByDoc = new Map<string, PendingLike[]>()
  for (const item of progress) {
    const list = progressByDoc.get(item.docId) ?? []
    list.push(item)
    progressByDoc.set(item.docId, list)
  }

  for (const [docId, items] of progressByDoc) {
    const latest = items[items.length - 1]
    const ids = items.map((i) => i.id)
    try {
      const res = await deps.sync(
        {
          deviceId: deps.deviceId,
          since: null,
          includeChanges: false,
          progress: toProgress(latest),
        },
        `all_${runId}_p_${docId}`,
      )
      conflicts += res.conflicts.length
      await deps.clearPending(ids)
      flushed += ids.length
    } catch (e) {
      // 文档已被删除：这条队列永远补不上，清掉别让它卡住整次同步
      if (statusOf(e) === 404) {
        await deps.clearPending(ids)
        continue
      }
      // 网络 / 5xx：保留，下次再试；但不要中断其余文档
      failed++
    }
  }

  /* ---- 书签：所有文档合并成一次请求 ---- */
  if (bookmarks.length > 0) {
    const ids = bookmarks.map((b) => b.id)
    try {
      const res = await deps.sync(
        {
          deviceId: deps.deviceId,
          since: null,
          includeChanges: false,
          bookmarks: { created: bookmarks.map(toCreatedBookmark) },
        },
        `all_${runId}_b`,
      )
      conflicts += res.conflicts.length
      const skipped = new Set(res.applied?.bookmarks?.skipped ?? [])
      // 服务端对每条要么落库要么跳过；能拿到 200 就说明这一批都处理完了
      await deps.clearPending(ids)
      flushed += ids.length - skipped.size
    } catch {
      failed++
    }
  }

  // 服务端的未决冲突才是权威：批量同步响应里的可能只是本轮的
  try {
    const res = await deps.listConflicts()
    conflicts = res.items.length
  } catch {
    /* 读不回冲突不阻断同步结果，保留响应里的计数 */
  }

  return { flushed, conflicts, failed }
}
