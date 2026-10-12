import type { FastifyInstance } from 'fastify'
import { requireUserId } from '../auth/require'
import { dal, newId, now } from '../dao'
import { ApiError, E } from '../errors'

/**
 * 阅读时长（R7-5，契约新增 §6.4）。
 *
 * 这是**纯追加型遥测**：没有版本号、没有冲突、没有软删除，
 * 完全绕开 §8 的合并机制 —— 时长不存在"哪一份才对"的问题，只有"记了几段"。
 *
 * 幂等靠 client_id：离线队列会重发，重复的那条由唯一索引挡掉。
 */

/** 单段时长上限。超过这个数基本可以断定是客户端算错了（或者标签页挂了没上报） */
const MAX_DURATION_MS = 6 * 60 * 60 * 1000

interface ReportBody {
  deviceId?: string
  clientId?: string
  durationMs?: number
  startedAt?: string
  endedAt?: string
}

/** 把毫秒转成人看的分钟数。不足 1 分钟也至少给 1，免得满屏都是"已读 0 分钟" */
function minutes(ms: number): number {
  return ms <= 0 ? 0 : Math.max(1, Math.round(ms / 60000))
}

function startOfTodayUtc(): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

function startOfWeekUtc(): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  // 周一算一周的开始
  const dow = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - dow)
  return d.toISOString()
}

export default async function readingTimeRoutes(app: FastifyInstance) {
  /* ---------------------------------------- 上报一段阅读时长 */
  app.post<{ Params: { docId: string }; Body: ReportBody }>(
    '/api/documents/:docId/reading-time',
    async (req) => {
      const userId = requireUserId(req)
      const doc = dal.getDocumentById(req.params.docId)
      if (!doc) throw E.notFound()
      if (doc.owner_id !== userId) throw E.forbiddenNotOwner()

      const { deviceId, clientId, durationMs, startedAt, endedAt } = req.body ?? {}

      const fields: string[] = []
      let message = '参数不合法。'

      if (typeof deviceId !== 'string' || !deviceId.trim()) {
        fields.push('deviceId')
        message = '缺少设备标识。'
      }
      if (typeof clientId !== 'string' || !clientId.trim()) {
        fields.push('clientId')
        message = '缺少上报标识。'
      }
      if (
        typeof durationMs !== 'number' ||
        !Number.isFinite(durationMs) ||
        durationMs <= 0 ||
        durationMs > MAX_DURATION_MS
      ) {
        fields.push('durationMs')
        message = '阅读时长不合法。'
      }
      if (fields.length) {
        throw new ApiError(400, 'VALIDATION_FAILED', message, { fields })
      }

      const at = now()
      dal.insertReadingSession({
        session_id: newId('rs'),
        user_id: userId,
        doc_id: doc.doc_id,
        device_id: deviceId as string,
        started_at: typeof startedAt === 'string' ? startedAt : at,
        ended_at: typeof endedAt === 'string' ? endedAt : at,
        duration_ms: Math.round(durationMs as number),
        client_id: clientId as string,
        created_at: at,
      })

      // 重发同一条时这里同样是 200 —— 幂等是设计意图，不是意外
      return {
        docId: doc.doc_id,
        totalMs: dal.sumReadingMs(userId, doc.doc_id),
      }
    },
  )

  /* ---------------------------------------- 单本书的累计时长 */
  app.get<{ Params: { docId: string } }>(
    '/api/documents/:docId/reading-time',
    async (req) => {
      const userId = requireUserId(req)
      const doc = dal.getDocumentById(req.params.docId)
      if (!doc) throw E.notFound()
      if (doc.owner_id !== userId) throw E.forbiddenNotOwner()

      const totalMs = dal.sumReadingMs(userId, doc.doc_id)
      return { docId: doc.doc_id, totalMs, totalMinutes: minutes(totalMs) }
    },
  )

  /* ---------------------------------------- 总览（阅读时长页用） */
  app.get('/api/reading-time/summary', async (req) => {
    const userId = requireUserId(req)

    const todayMs = dal.sumReadingMsSince(userId, startOfTodayUtc())
    const weekMs = dal.sumReadingMsSince(userId, startOfWeekUtc())

    // 按书分组的结果顺便就是总时长 —— 不必再单独查一次全量 SUM
    const books = []
    let totalMs = 0
    for (const r of dal.listReadingMsByDocument(userId)) {
      const doc = dal.getDocumentById(r.doc_id)
      // 删文档时外键级联会一并带走会话记录，理论上不会有孤儿；
      // 真漏了一条也宁可不显示，免得界面上冒出一行"（已删除）"
      if (!doc) continue
      totalMs += r.ms
      books.push({
        docId: r.doc_id,
        title: doc.title ?? doc.file_name,
        totalMs: r.ms,
        totalMinutes: minutes(r.ms),
      })
    }

    return {
      totalMs,
      totalMinutes: minutes(totalMs),
      todayMs,
      todayMinutes: minutes(todayMs),
      weekMs,
      weekMinutes: minutes(weekMs),
      books,
    }
  })
}
