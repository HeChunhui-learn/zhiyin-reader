import type { FastifyInstance } from 'fastify'
import { requireUserId } from '../auth/require'
import { dal, newId, now, type SyncRecordRow } from '../dao'
import { ApiError, E } from '../errors'
import { normalizeAnchor } from '../sync/anchor'
import type { ConflictEnvelope } from '../sync/merge'
import { applyBookmark, applyProgress, bookmarkToDto, progressToDto } from '../sync/service'

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

/**
 * 幂等键缓存。
 *
 * 契约 §1 说"服务端在 24 小时内对相同键返回首次结果"。
 * 这里用进程内存实现 —— 单机部署够用，重启即失效。
 * 真要跨重启需要建表，本期不做（记在 CLAUDE.md 的遗留里）。
 */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const idempotency = new Map<string, { at: number; body: unknown }>()

function idempotencyGet(userId: string, key: string): unknown | null {
  const hit = idempotency.get(`${userId}:${key}`)
  if (!hit) return null
  if (Date.now() - hit.at > IDEMPOTENCY_TTL_MS) {
    idempotency.delete(`${userId}:${key}`)
    return null
  }
  return hit.body
}

function idempotencyPut(userId: string, key: string, body: unknown): void {
  idempotency.set(`${userId}:${key}`, { at: Date.now(), body })
}

/** 把冲突写进 T_SyncRecord，保证"未决冲突不丢失"（契约 §2.2.6 的可靠性要求） */
function persistConflict(
  userId: string,
  docId: string,
  deviceId: string,
  conflict: ConflictEnvelope,
): SyncRecordRow {
  const row: SyncRecordRow = {
    record_id: newId('sr'),
    user_id: userId,
    doc_id: docId,
    device_id: deviceId || null,
    state: '冲突',
    local_delta: JSON.stringify(conflict.local),
    remote_changes: JSON.stringify(conflict.remote),
    conflict_json: JSON.stringify(conflict),
    version: 1,
    updated_at: now(),
  }
  dal.insertSyncRecord(row)
  return row
}

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
    if (r.conflict) {
      conflicts.push(r.conflict)
      persistConflict(userId, docId, deviceId, r.conflict)
    }
  }
  return applied
}

export default async function syncRoutes(app: FastifyInstance) {
  app.post<{ Body: SyncBody }>('/api/sync', async (req, reply) => {
    const userId = requireUserId(req)

    const idemKey = req.headers['idempotency-key']
    if (typeof idemKey === 'string' && idemKey) {
      const cached = idempotencyGet(userId, idemKey)
      if (cached) {
        reply.header('X-Idempotent-Replay', 'true')
        return cached
      }
    }

    const b = req.body ?? {}
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
      if (r.conflict) {
        conflicts.push(r.conflict)
        persistConflict(userId, doc.doc_id, deviceId, r.conflict)
      }
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

    if (typeof idemKey === 'string' && idemKey) idempotencyPut(userId, idemKey, body)
    return body
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
    // 这是材料审查 A25 指出的模糊点，这里把 relatedId 定为必填（客户端从
    // 冲突项的 resolved.bookmarkId 取）。请求体扩展已在交付说明里记明。
    if (scope === 'bookmark') {
      const original = dal.getBookmarkById(key)
      if (!original || original.user_id !== userId) throw E.notFound()

      if (choice === 'both' || !relatedId) {
        const copy = relatedId ? dal.getBookmarkById(relatedId) : undefined
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
