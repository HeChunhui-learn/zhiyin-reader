import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { requireUserId } from '../auth/require'
import { dal, now, type DocumentRow } from '../dao'
import { E } from '../errors'
import { cleanupDocumentResources, withDocumentResourceLock } from './resources'

/** 契约 §4.1：支持的格式 */
const FORMATS = new Set(['EPUB', 'TXT', 'MD'])
/** 契约 §4.1 的错误码里提到 413；正文 JSON 的体量上限 */
const MAX_PARAGRAPHS = 20000

interface ImportParagraph {
  paraIndex?: number
  text?: string
  /** 课程材料的字段清单里没有这一列，建库时补的，见 docs/system-design.md §7 裁决 4 */
  type?: string
  sentences?: { sentenceIndex?: number; startOffset?: number; endOffset?: number }[]
}

interface ImportBody {
  fileName?: string
  fileFormat?: string
  fileSize?: number
  contentHash?: string
  title?: string
  author?: string
  paragraphs?: ImportParagraph[]
  imageRefs?: { imageId?: string; paraIndex?: number; src?: string; alt?: string }[]
}

function toListItem(
  userId: string,
  d: DocumentRow,
  paragraphCount: number,
  favorites: Set<string>,
) {
  // 契约 §4.4：progress 取该用户在该文档上最近更新的一条设备记录。
  // 「不回退保护」是客户端恢复时的事（要跟本机已读位置比），列表这里给最新的就够。
  const rows = dal.listProgressByDocument(userId, d.doc_id)
  const latest = rows[0] // DAO 已按 updated_at DESC 排序
  const percent =
    latest && paragraphCount > 0
      ? Math.max(0, Math.min(1, latest.paragraph_index / paragraphCount))
      : 0

  return {
    docId: d.doc_id,
    title: d.title ?? d.file_name,
    author: d.author ?? '未知',
    fileFormat: d.file_format,
    // 封面要等 R3 抽取图片之后才有，先给 null
    coverImageId: null,
    paragraphCount,
    isFavorite: favorites.has(d.doc_id),
    progress: latest
      ? {
          paragraphIndex: latest.paragraph_index,
          percent,
          updatedAt: latest.updated_at,
        }
      : null,
  }
}

export default async function documentRoutes(app: FastifyInstance) {
  /* ---------------------------------------- 契约 §4.4 书架列表与检索 */
  app.get<{
    Querystring: { keyword?: string; category?: string; page?: string; pageSize?: string }
  }>('/api/documents', async (req) => {
    const userId = requireUserId(req)
    const q = req.query

    const page = Math.max(1, Math.floor(Number(q.page ?? 1)) || 1)
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(q.pageSize ?? 20)) || 20))
    const category = q.category ?? 'all'

    const { total, rows } = dal.searchDocuments(userId, {
      keyword: q.keyword?.trim() || undefined,
      category,
      page,
      pageSize,
    })

    // 收藏标记一次取全，别在 map 里逐条查
    const favorites = dal.listFavoriteDocIds(userId)

    return {
      total,
      page,
      pageSize,
      items: rows.map((d) => toListItem(userId, d, dal.countParagraphs(d.doc_id), favorites)),
    }
  })

  /* ---------------------------------------- 契约 §4.5 文档详情 */
  app.get<{ Params: { docId: string } }>('/api/documents/:docId', async (req) => {
    const userId = requireUserId(req)
    const doc = dal.getDocumentById(req.params.docId)
    if (!doc) throw E.notFound()
    if (doc.owner_id !== userId) throw E.forbiddenNotOwner()

    return {
      docId: doc.doc_id,
      title: doc.title ?? doc.file_name,
      author: doc.author ?? '未知',
      fileName: doc.file_name,
      fileFormat: doc.file_format,
      fileSize: doc.file_size,
      importedAt: doc.imported_at,
      paragraphCount: dal.countParagraphs(doc.doc_id),
      imageCount: dal.countImages(doc.doc_id),
      bookmarkCount: 0, // R5
      resourceUrl: doc.resource_url,
    }
  })

  /* ---------------------------------------- 契约 §4.5 正文内容（分段取用 + ETag） */
  app.get<{
    Params: { docId: string }
    Querystring: { from?: string; to?: string }
  }>('/api/documents/:docId/content', async (req, reply) => {
    const userId = requireUserId(req)
    const doc = dal.getDocumentById(req.params.docId)
    if (!doc) throw E.notFound()
    if (doc.owner_id !== userId) throw E.forbiddenNotOwner()

    const total = dal.countParagraphs(doc.doc_id)
    const from = Math.max(0, Math.floor(Number(req.query.from ?? 0)) || 0)
    const to = Math.min(total - 1, Math.floor(Number(req.query.to ?? total - 1)) || 0)

    const slice = from > to ? [] : dal.listParagraphRange(doc.doc_id, from, to - from + 1)
    const paragraphs = slice.map((p) => ({
      paraIndex: p.para_index,
      // ★ 补充字段：契约 §4.5 的示例里没有 type，但没有它渲染不出标题
      type: p.para_type,
      text: p.text,
      sentences: [] as { sentenceIndex: number; startOffset: number; endOffset: number }[],
    }))

    // 契约 §4.5：imageRefs 带 imageUrl。为空表示还没有任何设备上传过这张图，
    // 前端据此决定"本地有就补传、本地也没有就显示图片不可用"（契约 §4.3）
    const imageRefs = dal
      .listImagesByDocument(doc.doc_id)
      .filter((i) => i.para_index >= from && i.para_index <= to)
      .map((i) => ({
        imageId: i.image_id,
        paraIndex: i.para_index,
        src: i.src,
        alt: i.alt,
        imageUrl: i.remote_url,
      }))

    const body = {
      docId: doc.doc_id,
      from,
      to,
      totalParagraphs: total,
      paragraphs,
      imageRefs,
    }

    const etag = `W/"${createHash('sha1')
      .update(`${doc.doc_id}:${doc.content_hash ?? ''}:${from}:${to}:${total}`)
      .digest('hex')
      .slice(0, 20)}"`

    if (req.headers['if-none-match'] === etag) {
      return reply.code(304).send()
    }
    reply.header('ETag', etag)
    return body
  })

  /* ---------------------------------------- 契约 §4.1 创建文档（提交解析结果） */
  app.post<{ Body: ImportBody }>('/api/documents', {
    schema: { body: {
      type: 'object',
      properties: {
        fileFormat: { type: 'string' }, fileName: { type: 'string', minLength: 1, maxLength: 1024 },
        fileSize: { type: 'integer', minimum: 0 }, contentHash: { type: 'string', maxLength: 256 },
        title: { type: 'string', maxLength: 4096 }, author: { type: 'string', maxLength: 4096 },
        paragraphs: { type: 'array', items: { type: 'object', properties: {
          paraIndex: { type: 'integer', minimum: 0 }, type: { type: 'string' }, text: { type: 'string' },
          sentences: { type: 'array', items: { type: 'object', properties: {
            sentenceIndex: { type: 'integer', minimum: 0 }, startOffset: { type: 'integer', minimum: 0 }, endOffset: { type: 'integer', minimum: 0 },
          } } },
        } } },
        imageRefs: { type: 'array', maxItems: 20000, items: { type: 'object', properties: {
          imageId: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^/\\\\]+$' },
          paraIndex: { type: 'integer', minimum: 0 }, src: { type: 'string' }, alt: { type: 'string' },
        } } },
      },
    } },
  }, async (req, reply) => {
    const userId = requireUserId(req)
    const b = req.body ?? {}

    const format = (b.fileFormat ?? '').toUpperCase()
    if (!FORMATS.has(format)) throw E.unsupportedFormat()

    if (!b.fileName || !Array.isArray(b.paragraphs) || b.paragraphs.length === 0) {
      throw E.parseFailed('缺少文件名或段落为空')
    }
    if (b.paragraphs.length > MAX_PARAGRAPHS) throw E.payloadTooLarge()

    const contentHash = b.contentHash ?? ''
    if (contentHash) {
      const dup = dal.getOwnDocumentByHash(userId, contentHash)
      if (dup) throw E.duplicateDocument(dup.doc_id)
    }

    const docId = `doc_${randomUUID().replace(/-/g, '').slice(0, 12)}`

    // 段落 id 先算出来，句子要引用它
    const paraRows = b.paragraphs.map((p, i) => {
      const paraId = `para_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      return {
        paraId,
        para_index: p.paraIndex ?? i,
        para_type: ['h1', 'h2', 'p', 'img'].includes(p.type ?? '') ? p.type! : 'p',
        text: p.text ?? '',
      }
    })

    const sentenceRows = b.paragraphs.flatMap((p, i) =>
      (p.sentences ?? []).map((s, k) => ({
        sentence_id: `sent_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        para_id: paraRows[i].paraId,
        sentence_index: s.sentenceIndex ?? k,
        start_offset: s.startOffset ?? 0,
        end_offset: s.endOffset ?? 0,
      })),
    )

    const imageRows = (b.imageRefs ?? []).map((r) => ({
      image_id: r.imageId ?? `img_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      doc_id: docId,
      para_index: r.paraIndex ?? 0,
      src: r.src ?? null,
      alt: r.alt ?? null,
      cache_key: null,
      local_url: null,
      remote_url: null,
    }))

    const importedAt = now()
    dal.insertDocumentWithContent(
      {
        doc_id: docId,
        owner_id: userId,
        file_name: b.fileName,
        file_format: format,
        file_size: b.fileSize ?? null,
        title: (b.title ?? '').trim() || b.fileName.replace(/\.[^.]+$/, ''),
        author: (b.author ?? '').trim() || null,
        content_hash: contentHash || null,
        resource_url: null,
        imported_at: importedAt,
      },
      paraRows.map((p) => ({
        para_id: p.paraId,
        doc_id: docId,
        para_index: p.para_index,
        para_type: p.para_type,
        text: p.text,
      })),
      sentenceRows,
      imageRows,
    )

    return reply.code(201).send({
      docId,
      title: (b.title ?? '').trim() || b.fileName.replace(/\.[^.]+$/, ''),
      paragraphCount: paraRows.length,
      imageCount: imageRows.length,
      importedAt,
    })
  })

  /* ---------------------------------------- 契约 §4.6 删除文档 */
  app.delete<{ Params: { docId: string } }>(
    '/api/documents/:docId',
    async (req, reply) => {
      const userId = requireUserId(req)
      return withDocumentResourceLock(req.params.docId, async () => {
        const doc = dal.getDocumentById(req.params.docId)
        if (!doc) throw E.notFound()
        if (doc.owner_id !== userId) throw E.forbiddenNotOwner()
        await cleanupDocumentResources(doc.doc_id)
        dal.deleteDocument(doc.doc_id)
        return reply.code(204).send()
      })
    },
  )

  /* ---------------------------------------- 收藏（R7-4） */
  /*
   * 两个动词都做成**幂等**的：重复收藏、重复取消都返回 200，
   * 不报 409 也不带版本号 —— 收藏没有冲突语义，别把它拖进 §8 那套版本机制。
   * 前端乐观更新失败回滚时，重发一次不会出岔子。
   */

  app.put<{ Params: { docId: string } }>(
    '/api/documents/:docId/favorite',
    async (req) => {
      const userId = requireUserId(req)
      const doc = dal.getDocumentById(req.params.docId)
      if (!doc) throw E.notFound()
      if (doc.owner_id !== userId) throw E.forbiddenNotOwner()

      dal.addFavorite(userId, doc.doc_id, now())
      return { docId: doc.doc_id, isFavorite: true }
    },
  )

  app.delete<{ Params: { docId: string } }>(
    '/api/documents/:docId/favorite',
    async (req) => {
      const userId = requireUserId(req)
      const doc = dal.getDocumentById(req.params.docId)
      if (!doc) throw E.notFound()
      if (doc.owner_id !== userId) throw E.forbiddenNotOwner()

      dal.removeFavorite(userId, doc.doc_id)
      return { docId: doc.doc_id, isFavorite: false }
    },
  )
}
