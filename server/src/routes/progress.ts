import type { FastifyInstance } from 'fastify'
import { requireUserId } from '../auth/require'
import { dal } from '../dao'
import { ApiError, E } from '../errors'
import { normalizeAnchor } from '../sync/anchor'
import { applyProgress, progressToDto } from '../sync/service'

/** 契约 §6：阅读进度。单值数据（每设备一行），合并规则见 §8.5 */
export default async function progressRoutes(app: FastifyInstance) {
  /** §6.1 拉取该文档全部设备的进度 —— 必须是所有设备，否则新设备拉不到别端进度 */
  app.get<{ Params: { docId: string }; Querystring: { deviceId?: string } }>(
    '/api/documents/:docId/progress',
    async (req) => {
      const userId = requireUserId(req)
      const doc = dal.getDocumentById(req.params.docId)
      if (!doc || doc.owner_id !== userId) throw E.notFound()

      const rows = dal.listProgressByDocument(userId, doc.doc_id)
      const currentDevice = req.query.deviceId ?? ''
      return { docId: doc.doc_id, items: rows.map((r) => progressToDto(r, currentDevice)) }
    },
  )

  /** §6.2 上报进度（条件更新） */
  app.put<{
    Params: { docId: string }
    Body: {
      deviceId?: string
      anchor?: unknown
      lastSentenceIndex?: number | null
      updatedAt?: string
      baseVersion?: number
    }
  }>('/api/documents/:docId/progress', async (req) => {
    const userId = requireUserId(req)
    const doc = dal.getDocumentById(req.params.docId)
    if (!doc || doc.owner_id !== userId) throw E.notFound()

    const { deviceId, anchor, lastSentenceIndex, updatedAt, baseVersion } = req.body ?? {}

    if (!deviceId || typeof deviceId !== 'string') {
      throw new ApiError(400, 'VALIDATION_FAILED', '缺少设备标识。', { fields: ['deviceId'] })
    }
    if (!updatedAt || typeof updatedAt !== 'string') {
      throw new ApiError(400, 'VALIDATION_FAILED', '缺少修改时间。', { fields: ['updatedAt'] })
    }

    const result = applyProgress(userId, deviceId, {
      docId: doc.doc_id,
      anchor: normalizeAnchor(anchor),
      lastSentenceIndex: lastSentenceIndex ?? null,
      updatedAt,
      baseVersion: typeof baseVersion === 'number' ? baseVersion : 0,
    })

    if (result.outcome === 'conflict' && result.conflict) {
      throw new ApiError(409, 'SYNC_VERSION_CONFLICT', '进度已被其他设备修改。', {
        conflict: result.conflict,
      })
    }

    return {
      progressId: result.progressId,
      version: result.version,
      updatedAt: result.updatedAt,
      serverReceivedAt: result.serverReceivedAt,
      outcome: result.outcome,
    }
  })
}
