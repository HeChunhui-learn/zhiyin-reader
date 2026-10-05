import type { FastifyInstance } from 'fastify'
import { requireUserId } from '../auth/require'
import { dal, now } from '../dao'
import { ApiError, E } from '../errors'
import { normalizeAnchor } from '../sync/anchor'
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
}

/** 统一的 409 组装 */
function conflict409(conflict: unknown): ApiError {
  return new ApiError(409, 'SYNC_VERSION_CONFLICT', '这条书签已被其他设备修改。', {
    conflict,
  })
}

export default async function bookmarkRoutes(app: FastifyInstance) {
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

    // 幂等：已存在且内容相同返回 200，其余新增返回 201（契约 §7.1）
    const code = r.applied ? 201 : 200
    return reply.code(code).send({
      bookmarkId: b.bookmarkId!,
      version: r.version,
      name: r.row?.name ?? b.name ?? null,
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
}
