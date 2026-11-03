import type { FastifyInstance } from 'fastify'
import { requireUserId } from '../auth/require'
import { dal, now } from '../dao'
import { ApiError, E } from '../errors'
import { normalizeAnchor } from '../sync/anchor'
import type { ConflictEnvelope } from '../sync/merge'
import {
  applyBookmark,
  applyProgress,
  bookmarkToDto,
  progressToDto,
  syncRecordToConflict,
} from '../sync/service'
import { withIdempotency } from '../idempotency'

/**
 * 契约 §8：批量增量同步。
 * 一次请求完成"上传本地增量 + 拉取服务端增量 + 冲突裁决"。
 */

interface SyncBody {
  deviceId?: string
  since?: string | null
  progress?: {
    docId?: string
    anchor?: unknown
    lastSentenceIndex?: number | null
    updatedAt?: string
    baseVersion?: number
  } | null
  bookmarks?: {
    created?: BookmarkIn[]
    updated?: BookmarkIn[]
    deleted?: BookmarkIn[]
  }
}

interface BookmarkIn {
  bookmarkId?: string
  /** 契约 §8.1：只有 created 条目带 docId，updated / deleted 靠 bookmarkId 反查 */
  docId?: string
  /** 同样只有 created 带；缺省时沿用库里已有的锚点 */
  anchor?: unknown
  name?: string | null
  updatedAt?: string
  deletedAt?: string | null
  baseVersion?: number
}

/*
 * 幂等键与冲突落库都不在本文件实现了。
 *
 * 幂等：`server/src/idempotency.ts`（A2 把它从进程内存的 Map 换成了
 * T_Idempotency 表，契约 §1 的"24 小时内有效"这才算数 —— 原来一重启就失效）。
 * 冲突落库：下沉到 `sync/service.ts` 的 persistConflict，因为单项接口
 * （PATCH /api/bookmarks/:id）也要落，只写在批量同步这条路径上是不够的。
 */

function applyBookmarkList(
  userId: string,
  deviceId: string,
  op: 'created' | 'updated' | 'deleted',
  list: BookmarkIn[],
  docIdHint: string | undefined,
  conflicts: ConflictEnvelope[],
): number {
  let applied = 0
  for (const item of list) {
    if (!item.bookmarkId) continue
    // 契约 §8.1：updated / deleted 条目只给 bookmarkId，docId 要从库里反查
    const existing = dal.getBookmarkById(item.bookmarkId)
    const docId = item.docId ?? existing?.doc_id ?? docIdHint
    if (!docId) continue

    const r = applyBookmark(
      userId,
      op,
      {
        bookmarkId: item.bookmarkId,
        docId,
        anchor: item.anchor === undefined || item.anchor === null
          ? (existing ? (JSON.parse(existing.anchor_json) as never) : normalizeAnchor(undefined))
          : normalizeAnchor(item.anchor),
        name: item.name ?? null,
        updatedAt: item.updatedAt ?? now(),
        deletedAt: item.deletedAt ?? null,
      },
      item.baseVersion,
      deviceId,
    )
    if (r.applied) applied++
    // 落库由 applyBookmark 内部完成（A4 把 persistConflict 下沉到了 service 层）
    if (r.conflict) conflicts.push(r.conflict)
  }
  return applied
}

/**
 * 批量同步的实际逻辑。
 *
 * 从路由里抽出来是为了配合幂等：`withIdempotency` 要求"查键 → 干活 → 写结果"
 * 之间不能有 await，否则两个并发重放会双双落库。所以这里必须是**同步**函数 ——
 * 恰好 DAO 全是 better-sqlite3 的同步 API，满足这个前提。
 */
function doSync(userId: string, b: SyncBody) {
  const deviceId = b.deviceId ?? ''
  const since = b.since ?? null
  const conflicts: ConflictEnvelope[] = []

  /* ---- 进度 ---- */
  let progressApplied: { version: number; outcome: string } | null = null
  let progressDocId: string | undefined

  if (b.progress?.docId) {
    const doc = dal.getDocumentById(b.progress.docId)
    if (!doc || doc.owner_id !== userId) throw E.notFound()
    progressDocId = doc.doc_id

    const r = applyProgress(userId, deviceId, {
      docId: doc.doc_id,
      anchor: normalizeAnchor(b.progress.anchor),
      lastSentenceIndex: b.progress.lastSentenceIndex ?? null,
      updatedAt: b.progress.updatedAt ?? now(),
      baseVersion: b.progress.baseVersion ?? 0,
    })
    progressApplied = { version: r.version, outcome: r.outcome }
    // 进度冲突不落库（decideProgress 只产出 superseded，服务端已当场裁决），
    // 但仍要回给客户端，让界面能说一句"已被其他设备更新"
    if (r.conflict) conflicts.push(r.conflict)
  }

  /* ---- 书签 ---- */
  const bm = b.bookmarks ?? {}
  const created = applyBookmarkList(userId, deviceId, 'created', bm.created ?? [], undefined, conflicts)
  const updated = applyBookmarkList(userId, deviceId, 'updated', bm.updated ?? [], undefined, conflicts)
  const deleted = applyBookmarkList(userId, deviceId, 'deleted', bm.deleted ?? [], undefined, conflicts)

  /* ---- 服务端增量 ---- */

  // 本次请求碰过的书签不再回传给客户端，否则会把自己的改动当成他端变更
  const touched = new Set<string>()
  for (const list of [bm.created, bm.updated, bm.deleted]) {
    for (const it of list ?? []) if (it.bookmarkId) touched.add(it.bookmarkId)
  }

  const changedBookmarks = dal
    .listBookmarksSince(userId, progressDocId, since, true)
    .filter((r) => !touched.has(r.bookmark_id))

  const changesBookmarks = {
    created: changedBookmarks
      .filter((r) => !r.deleted_at && r.version === 1)
      .map(bookmarkToDto),
    updated: changedBookmarks
      .filter((r) => !r.deleted_at && r.version > 1)
      .map((r) => ({
        bookmarkId: r.bookmark_id,
        name: r.name,
        anchor: JSON.parse(r.anchor_json),
        version: r.version,
        updatedAt: r.updated_at,
      })),
    deleted: changedBookmarks
      .filter((r) => !!r.deleted_at)
      .map((r) => ({ bookmarkId: r.bookmark_id, deletedAt: r.deleted_at })),
  }

  // 他端进度：取最近更新的一条（不属于本设备的）
  let changesProgress: unknown = null
  if (progressDocId) {
    const others = dal
      .listProgressByDocument(userId, progressDocId)
      .filter((r) => r.device_id !== deviceId)
      .filter((r) => !since || r.updated_at > since)
    if (others.length > 0) {
      const latest = others[0] // DAO 已按 updated_at DESC 排序
      changesProgress = {
        ...progressToDto(latest, deviceId),
        deviceId: latest.device_id,
      }
    }
  }

  const body = {
    serverTime: now(),
    applied: {
      progress: progressApplied,
      bookmarks: { created, updated, deleted },
    },
    conflicts,
    changes: {
      progress: changesProgress,
      bookmarks: changesBookmarks,
    },
  }

  return body
}

/**
 * 裁决完就把对应的未决冲突记录销账。
 *
 * 不销账的话，下一次进入阅读页 GET /api/sync/conflicts 又会把它读回来
 * 重新弹一遍 —— 读者明明已经裁决过了。
 *
 * 按 scope + key 匹配，不要求 serverVersion 也对上：裁决接口的请求体里
 * 本来就没有这个字段（客户端只发 scope / key / choice），而且同一条书签
 * 历史累积的几轮冲突都该随着这次裁决一起了结。
 *
 * T_SyncRecord 没有 scope / key 列，§7.2 又规定已有表定义不许改（只能追加新表），
 * 所以把 conflict_json 解析出来在 JS 里对。一次裁决要扫的未决冲突本来就只有几条。
 */
function markConflictResolved(userId: string, scope: string, key: string): number {
  let n = 0
  for (const row of dal.listPendingConflicts(userId)) {
    const c = syncRecordToConflict(row)
    if (c && c.scope === scope && c.key === key) {
      dal.updateSyncState(row.record_id, '已同步')
      n++
    }
  }
  return n
}

/** 契约 §8：批量增量同步的路由 */
export default async function syncRoutes(app: FastifyInstance) {
  app.post<{ Body: SyncBody }>('/api/sync', async (req, reply) => {
    const userId = requireUserId(req)

    // A2：幂等键落 T_Idempotency 表（R5 存在进程内存里，重启即失效）。
    // withIdempotency 要求"查键 → 干活 → 写结果"之间没有 await，
    // doSync 恰好是纯同步的，两个并发重放不会双双落库。
    const outcome = withIdempotency(req.headers, 'sync', userId, () => doSync(userId, req.body ?? {}))

    if (outcome.replayed) reply.header('X-Idempotent-Replay', 'true')
    return outcome.body
  })

  /**
   * A4 新增：把未决冲突读回来（契约 §2.2.6「未决冲突不得丢失」的兑现）。
   *
   * 契约原文没有这个接口。R5 已经把冲突写进了 T_SyncRecord，但界面从来没读回来 ——
   * 冲突只活在当次会话的内存里，一刷新就"未决冲突等于丢了"（演示脚本第三段
   * "关页面再打开冲突还在"那一幕也因此过不了）。属于「只加新接口、不改老接口」，
   * 按手册 §7.3 改完告知即可，不必走变更流程。
   */
  app.get<{ Querystring: { docId?: string } }>('/api/sync/conflicts', async (req) => {
    const userId = requireUserId(req)
    const rows = dal.listPendingConflicts(userId, req.query.docId)

    const seen = new Set<string>()
    const items: ConflictEnvelope[] = []

    for (const row of rows) {
      const c = syncRecordToConflict(row)
      if (!c) continue

      // 兼容 R5 留下的历史行：那时进度冲突也落了库。它是服务端当场按
      // "不回退保护"裁决完的（superseded），不该再当作"未决"弹给读者。
      if (c.resolution === 'superseded') continue

      // 同一个冲突可能被反复同步、每次落一行；listPendingConflicts 已按
      // updated_at DESC 排序，所以第一次见到的就是最新那条
      const dedupe = `${c.scope}:${c.key}:${c.serverVersion}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      items.push(c)
    }

    return { serverTime: now(), items }
  })

  /* ---------------------------------------- 契约 §8.4 用户裁决 */
  app.post<{
    Body: {
      scope?: string
      key?: string
      conflictAt?: string
      choice?: 'local' | 'remote' | 'both'
      deviceId?: string
      /** keep_both 时服务端生成的那条副本的 id（取自冲突项 resolved.bookmarkId） */
      relatedId?: string
    }
  }>('/api/sync/resolve', async (req) => {
    const userId = requireUserId(req)
    const { scope, key, choice, relatedId } = req.body ?? {}

    if (!scope || !key || !choice) {
      throw new ApiError(400, 'VALIDATION_FAILED', '缺少 scope / key / choice。', {
        fields: ['scope', 'key', 'choice'],
      })
    }

    // 契约的 request 里没有 relatedId —— 但 keep_both 之后要"二选一"必须知道另一条是谁。
    // 这是 docs/system-design.md §5.3 指出的模糊点，这里把 relatedId 定为必填（客户端从
    // 冲突项的 resolved.bookmarkId 取）。请求体扩展已在交付说明里记明。
    if (scope === 'bookmark') {
      const original = dal.getBookmarkById(key)
      if (!original || original.user_id !== userId) throw E.notFound()

      if (choice === 'both' || !relatedId) {
        const copy = relatedId ? dal.getBookmarkById(relatedId) : undefined
        // 「两份都保留」也是裁决完了：读者认了这个结果，不必再弹
        markConflictResolved(userId, scope, key)
        return {
          scope,
          choice,
          kept: [
            bookmarkToDto(original),
            ...(copy && copy.user_id === userId ? [bookmarkToDto(copy)] : []),
          ],
        }
      }

      const copy = dal.getBookmarkById(relatedId)
      if (!copy || copy.user_id !== userId) throw E.notFound()

      // local  = 保留本机那份（服务端生成的副本），删掉原件
      // remote = 保留云端那份（原件），删掉本机副本
      const toDelete = choice === 'local' ? original : copy
      const toKeep = choice === 'local' ? copy : original

      const stamp = now()
      dal.forceUpdateBookmark(toDelete.bookmark_id, { updated_at: stamp, deleted_at: stamp })

      markConflictResolved(userId, scope, key)
      return {
        scope,
        choice,
        kept: [bookmarkToDto(dal.getBookmarkById(toKeep.bookmark_id)!)],
        deleted: bookmarkToDto(dal.getBookmarkById(toDelete.bookmark_id)!),
      }
    }

    // 进度：superseded 的冲突不需要读者做选择，读者若点了"采用本机"，
    // 就再提交一次（客户端拿着新版本号重发即可）。这里如实说明。
    return {
      scope,
      choice,
      kept: [],
      note: '进度冲突由服务端按"不回退保护"自动裁决，无需读者选择',
    }
  })
}
