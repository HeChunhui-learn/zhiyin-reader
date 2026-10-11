import type { FastifyInstance } from 'fastify'
import { requireUserId } from '../auth/require'
import { dal, now, type BookmarkRow } from '../dao'
import { ApiError, E } from '../errors'
import { normalizeAnchor, type Anchor } from '../sync/anchor'
import { applyBookmark, bookmarkToDto } from '../sync/service'

/**
 * 契约 §7：书签单项接口（书签管理界面即时调用），批量同步见 §8。
 * 书签以客户端生成的标识为逻辑主键，软删除，带版本号做条件更新。
 */

interface BookmarkBody {
  bookmarkId?: string
  docId?: string
  anchor?: unknown
  name?: string | null
  updatedAt?: string
  baseVersion?: number
  deletedAt?: string
  /** ★ B4：创建时带上的章节标题 */
  chapterTitle?: string | null
  /** ★ B1：显式指定排序位；不传则服务端追加到末尾 */
  sortOrder?: number
}

/** 统一的 409 组装 */
function conflict409(conflict: unknown): ApiError {
  return new ApiError(409, 'SYNC_VERSION_CONFLICT', '这条书签已被其他设备修改。', {
    conflict,
  })
}

/**
 * 列表 DTO（B1/B3）。
 *
 * 为什么不复用 sync/service.ts 的 bookmarkToDto：那个文件在任务书的禁区里，
 * 而它没有 sortOrder / chapterTitle。列表相关的新字段在本文件内自成一份，
 * 增量同步的那份保持原样，互不影响。
 */
function bookmarkListDto(row: BookmarkRow) {
  return {
    bookmarkId: row.bookmark_id,
    docId: row.doc_id,
    name: row.name,
    anchor: JSON.parse(row.anchor_json) as Anchor,
    sortOrder: row.sort_order ?? 0,
    chapterTitle: row.chapter_title ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

export default async function bookmarkRoutes(app: FastifyInstance) {
  /**
   * §7.7 拖动排序：整表重排。
   *
   * **一个事务，全成功或全失败** —— 任一条 baseVersion 不匹配即整体回滚，
   * 不接受部分成功（任务书 §B1 坑 3）。
   */
  app.post<{
    Body: {
      docId?: string
      items?: { bookmarkId?: string; sortOrder?: number; baseVersion?: number }[]
      updatedAt?: string
    }
  }>('/api/bookmarks/reorder', async (req) => {
    const userId = requireUserId(req)
    const b = req.body ?? {}
    const items = b.items ?? []

    if (!b.docId) throw E.validation(['docId'])
    if (!Array.isArray(items) || items.length === 0) throw E.validation(['items'])

    const ids = items.map((i) => i.bookmarkId)
    if (ids.some((id) => !id)) throw E.validation(['items.bookmarkId'])
    if (new Set(ids).size !== ids.length) throw E.validation(['items.bookmarkId'])
    for (const it of items) {
      if (typeof it.sortOrder !== 'number' || !Number.isInteger(it.sortOrder)) {
        throw E.validation(['items.sortOrder'])
      }
      if (typeof it.baseVersion !== 'number') throw E.validation(['items.baseVersion'])
    }

    // 先整体校验归属，再落库：不属于本用户/本文档的一律 404，避免越权改别人的书签
    for (const it of items) {
      const row = dal.getBookmarkById(it.bookmarkId!)
      if (!row || row.user_id !== userId || row.doc_id !== b.docId) throw E.notFound()
    }

    const updatedAt = b.updatedAt ?? now()
    const r = dal.reorderBookmarks(
      userId,
      b.docId,
      items.map((it) => ({
        bookmarkId: it.bookmarkId!,
        sortOrder: it.sortOrder!,
        baseVersion: it.baseVersion!,
      })),
      updatedAt,
    )

    if (!r.ok) {
      // 冲突条目：给出双方版本，resolution 用 superseded（附录 B 的约定：
      // 拖动排序取较新者，不用 keep_both，否则会多出一堆重复书签）
      const submitted = items.find((it) => it.bookmarkId === r.failedId)
      throw new ApiError(
        409,
        'SYNC_VERSION_CONFLICT',
        '书签顺序已被其他设备修改，本批调整已整体撤销。',
        {
          conflict: {
            scope: 'bookmark',
            key: r.failedId,
            baseVersion: submitted?.baseVersion ?? 0,
            serverVersion: r.serverVersion,
            local: { bookmarkId: r.failedId, sortOrder: submitted?.sortOrder ?? 0 },
            remote: { bookmarkId: r.failedId, version: r.serverVersion },
            resolution: 'superseded',
            resolved: null,
            note: '顺序取服务端较新的一份。',
          },
        },
      )
    }

    return {
      docId: b.docId,
      applied: r.rows.length,
      items: r.rows.map((row) => ({
        bookmarkId: row.bookmark_id,
        sortOrder: row.sort_order ?? 0,
        version: row.version,
      })),
    }
  })

  /** §7.1 新增书签 */
  app.post<{ Body: BookmarkBody }>('/api/bookmarks', async (req, reply) => {
    const userId = requireUserId(req)
    const b = req.body ?? {}

    const fields: string[] = []
    if (!b.bookmarkId) fields.push('bookmarkId')
    if (!b.docId) fields.push('docId')
    if (fields.length) {
      throw new ApiError(400, 'VALIDATION_FAILED', '缺少必要参数。', { fields })
    }

    const doc = dal.getDocumentById(b.docId!)
    if (!doc || doc.owner_id !== userId) throw E.notFound()

    const updatedAt = b.updatedAt ?? now()
    const r = applyBookmark(
      userId,
      'created',
      {
        bookmarkId: b.bookmarkId!,
        docId: b.docId!,
        anchor: normalizeAnchor(b.anchor),
        name: b.name ?? null,
        updatedAt,
      },
      undefined,
      '',
    )

    if (r.conflict) throw conflict409(r.conflict)

    // 新列走 setBookmarkMeta，不用 updateBookmarkIfVersion：
    // 后者会递增 version，把契约 §7.1 要求的新建 version=1 顶成 2。
    // sort_order 缺省时由 insertBookmark 兜底分配 max+1，这里只在显式传入时覆盖。
    if (b.chapterTitle !== undefined || b.sortOrder !== undefined) {
      dal.setBookmarkMeta(b.bookmarkId!, {
        ...(b.chapterTitle !== undefined ? { chapter_title: b.chapterTitle } : {}),
        ...(b.sortOrder !== undefined ? { sort_order: b.sortOrder } : {}),
      })
    }

    // 幂等：已存在且内容相同返回 200，其余新增返回 201（契约 §7.1）
    const fresh = dal.getBookmarkById(b.bookmarkId!)
    const code = r.applied ? 201 : 200
    return reply.code(code).send({
      bookmarkId: b.bookmarkId!,
      version: fresh?.version ?? r.version,
      name: fresh?.name ?? b.name ?? null,
      sortOrder: fresh?.sort_order ?? 0,
      chapterTitle: fresh?.chapter_title ?? null,
    })
  })

  /** §7.2 重命名 / 移动书签（条件更新） */
  app.patch<{ Params: { bookmarkId: string }; Body: BookmarkBody }>(
    '/api/bookmarks/:bookmarkId',
    async (req) => {
      const userId = requireUserId(req)
      const b = req.body ?? {}
      const existing = dal.getBookmarkById(req.params.bookmarkId)
      if (!existing || existing.user_id !== userId) throw E.notFound()

      if (typeof b.baseVersion !== 'number') {
        throw new ApiError(400, 'VALIDATION_FAILED', '条件更新必须携带 baseVersion。', {
          fields: ['baseVersion'],
        })
      }

      const currentAnchor = JSON.parse(existing.anchor_json) as Record<string, unknown>
      const r = applyBookmark(
        userId,
        'updated',
        {
          bookmarkId: existing.bookmark_id,
          docId: existing.doc_id,
          anchor: normalizeAnchor(b.anchor ?? currentAnchor),
          name: b.name !== undefined ? b.name : existing.name,
          updatedAt: b.updatedAt ?? now(),
        },
        b.baseVersion,
        '',
      )

      if (r.conflict) throw conflict409(r.conflict)
      return { bookmarkId: existing.bookmark_id, version: r.version }
    },
  )

  /** §7.3 删除书签（软删除）。注意契约把版本号放在 query 上 */
  app.delete<{
    Params: { bookmarkId: string }
    Querystring: { baseVersion?: string; deviceId?: string }
  }>('/api/bookmarks/:bookmarkId', async (req) => {
    const userId = requireUserId(req)
    const existing = dal.getBookmarkById(req.params.bookmarkId)
    if (!existing || existing.user_id !== userId) throw E.notFound()

    const baseVersion = Number(req.query.baseVersion)
    if (!Number.isFinite(baseVersion)) {
      throw new ApiError(400, 'VALIDATION_FAILED', '条件更新必须携带 baseVersion。', {
        fields: ['baseVersion'],
      })
    }

    const deletedAt = now()
    const r = applyBookmark(
      userId,
      'deleted',
      {
        bookmarkId: existing.bookmark_id,
        docId: existing.doc_id,
        anchor: JSON.parse(existing.anchor_json) as never,
        name: existing.name,
        updatedAt: deletedAt,
        deletedAt,
      },
      baseVersion,
      req.query.deviceId ?? '',
    )

    if (r.conflict) throw conflict409(r.conflict)
    return {
      bookmarkId: existing.bookmark_id,
      version: r.version,
      deletedAt: r.row?.deleted_at ?? deletedAt,
    }
  })

  /** §7.4 增量拉取（含墓碑） */
  app.get<{ Querystring: { docId?: string; since?: string; includeDeleted?: string } }>(
    '/api/bookmarks',
    async (req) => {
      const userId = requireUserId(req)
      const { docId, since, includeDeleted } = req.query

      const rows = dal.listBookmarksSince(
        userId,
        docId,
        since ?? null,
        includeDeleted === 'true',
      )

      return {
        serverTime: now(),
        // 契约 §7.4 的 items 示例里没列 createdAt，但界面要按创建时间排序，
        // 多给一个字段对客户端无害，这里保留
        items: rows.map((r) => bookmarkToDto(r)),
      }
    },
  )

  /**
   * §7.5 分页列表（B3）。界面列表走这里；§7.4 的 GET /api/bookmarks 只服务增量同步。
   *
   * 分成两个接口是有意的：契约 §1 规定 pageSize 默认 20，如果直接给 §7.4 加分页，
   * 那些不带分页参数的调用方（增量同步）会被静默截断到 20 条 —— 变更拉不全且不报错。
   */
  app.get<{
    Querystring: {
      docId?: string
      sort?: string
      order?: string
      page?: string
      pageSize?: string
    }
  }>('/api/bookmarks/page', async (req) => {
    const userId = requireUserId(req)
    const q = req.query
    if (!q.docId) throw E.validation(['docId'])

    const doc = dal.getDocumentById(q.docId)
    if (!doc || doc.owner_id !== userId) throw E.notFound()

    const sort = q.sort === 'createdAt' || q.sort === 'chapter' ? q.sort : 'order'
    const order = q.order === 'desc' ? 'desc' : 'asc'
    const page = Math.max(1, Number(q.page ?? 1) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20) || 20))

    const { total, rows } = dal.listBookmarksPaged(userId, q.docId, sort, order, page, pageSize)
    return { total, page, pageSize, items: rows.map(bookmarkListDto) }
  })
}
