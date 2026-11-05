import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { auth, closeApp, importBody, makeApp, registerAndLogin } from './helpers'
import { BODY_LIMIT } from '../src/app'
import { MAX_FILE_BYTES } from '../src/routes/resources'

/**
 * DC-01 ~ DC-14 文档与正文（契约 §4）、IM-01 ~ IM-11 图片资源（§4.3 / §5），
 * 以及 R7-4 的收藏与 R7-5 的阅读时长、头像。
 *
 * 图片这里用真实的 PNG 字节（1×1 透明 PNG），不是替身 ——
 * 走的是真实的落盘 + 读回路径。
 */

let app: FastifyInstance
beforeAll(async () => {
  app = await makeApp()
})
afterAll(async () => {
  await closeApp(app)
})

/** 1×1 透明 PNG */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

async function importDoc(
  s: { accessToken: string },
  over: Partial<Parameters<typeof importBody>[0]> = {},
) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/documents',
    headers: auth(s as never),
    // 段落默认给一段 —— 用例只关心标题或格式时不必每次都写 paragraphs
    payload: importBody({ paragraphs: [{ text: '正文。' }], ...over }),
  })
  if (r.statusCode !== 201) throw new Error(`导入失败 ${r.statusCode}: ${r.body}`)
  return r.json().docId as string
}

describe('DC-01 ~ DC-04 导入文档（契约 §4.1）', () => {
  it('DC-01 TXT 导入 → 201，返回 paragraphCount / imageCount', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST', url: '/api/documents', headers: auth(s),
      payload: importBody({ paragraphs: [{ text: '第一段。' }, { text: '第二段。' }], title: '导入测试' }),
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().paragraphCount).toBe(2)
    expect(r.json().imageCount).toBe(0)
    expect(r.json().docId).toMatch(/^doc_/)
  })

  it('DC-01 支持 EPUB / TXT / MD 三种格式名', async () => {
    const s = await registerAndLogin(app)
    for (const fmt of ['EPUB', 'TXT', 'MD']) {
      const r = await app.inject({
        method: 'POST', url: '/api/documents', headers: auth(s),
        payload: importBody({ fileFormat: fmt, paragraphs: [{ text: 'x。' }] }),
      })
      expect(r.statusCode, fmt).toBe(201)
    }
  })

  it('DC-02 ★ 重复导入同一文件 → 409 CONFLICT_DOCUMENT_DUPLICATE，details.docId 给出已存在的文档', async () => {
    const s = await registerAndLogin(app)
    const body = importBody({ paragraphs: [{ text: '内容。' }], contentHash: 'sha256:dup_test_hash' })
    const first = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: body })
    const docId = first.json().docId

    const again = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: body })
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('CONFLICT_DOCUMENT_DUPLICATE')
    expect(again.json().details.docId).toBe(docId)
  })

  it('DC-02 不同读者可以导入同一份内容（去重只在读者自己的书架内）', async () => {
    const a = await registerAndLogin(app)
    const b = await registerAndLogin(app)
    const body = importBody({ paragraphs: [{ text: '共享内容。' }], contentHash: 'sha256:shared_hash_x' })
    const first = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(a), payload: body })
    expect(first.statusCode).toBe(201)
    const second = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(b), payload: body })
    expect(second.statusCode).toBe(201)
  })

  it('DC-03 不支持的格式（.pdf）→ 415 UNSUPPORTED_FORMAT', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST', url: '/api/documents', headers: auth(s),
      payload: importBody({ fileFormat: 'PDF', paragraphs: [{ text: 'x。' }] }),
    })
    expect(r.statusCode).toBe(415)
    expect(r.json().code).toBe('UNSUPPORTED_FORMAT')
  })

  it('DC-04 无段落 → 422 PARSE_FAILED', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST', url: '/api/documents', headers: auth(s),
      payload: importBody({ paragraphs: [] }),
    })
    expect(r.statusCode).toBe(422)
    expect(r.json().code).toBe('PARSE_FAILED')
  })

  it('DC-04 缺文件名 → 422 PARSE_FAILED', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST', url: '/api/documents', headers: auth(s),
      payload: { fileFormat: 'TXT', paragraphs: [{ paraIndex: 0, type: 'p', text: 'x。', sentences: [] }] },
    })
    expect(r.statusCode).toBe(422)
  })

  it('段落类型 h1 / h2 / p / img 都被保留（裁决 4 的 para_type）', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s, {
      paragraphs: [
        { type: 'h1', text: '第一章' },
        { type: 'h2', text: '第一节' },
        { type: 'p', text: '正文。' },
        { type: 'img', text: '' },
      ],
    })
    const r = await app.inject({ method: 'GET', url: `/api/documents/${docId}/content`, headers: auth(s) })
    expect(r.json().paragraphs.map((p: { type: string }) => p.type)).toEqual(['h1', 'h2', 'p', 'img'])
  })

  it('未知段落类型退回 p（不因脏数据 500）', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s, { paragraphs: [{ type: 'weird', text: 'x。' }] })
    const r = await app.inject({ method: 'GET', url: `/api/documents/${docId}/content`, headers: auth(s) })
    expect(r.json().paragraphs[0].type).toBe('p')
  })

  it('未带令牌导入 → 401', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/documents', payload: importBody({ paragraphs: [{ text: 'x。' }] }),
    })
    expect(r.statusCode).toBe(401)
  })
})

describe('DC-05 ~ DC-14 书架、正文与检索', () => {
  it('DC-05 书架列表 → 200，返回 {total, page, pageSize, items}', async () => {
    const s = await registerAndLogin(app)
    await importDoc(s, { title: '列表书' })
    const r = await app.inject({ method: 'GET', url: '/api/documents', headers: auth(s) })
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b).toHaveProperty('total')
    expect(b).toHaveProperty('page')
    expect(b).toHaveProperty('pageSize')
    expect(Array.isArray(b.items)).toBe(true)
    expect(b.total).toBeGreaterThanOrEqual(1)
  })

  it('DC-06 列表项字段名与契约一致（含 fileFormat / paragraphCount / progress）', async () => {
    const s = await registerAndLogin(app)
    await importDoc(s, { title: '字段书' })
    const r = await app.inject({ method: 'GET', url: '/api/documents', headers: auth(s) })
    const item = r.json().items[0]
    expect(item).toHaveProperty('docId')
    expect(item).toHaveProperty('title')
    expect(item).toHaveProperty('author')
    expect(item).toHaveProperty('fileFormat')
    expect(item).toHaveProperty('paragraphCount')
    expect(item).toHaveProperty('progress')
    // R7-4 新增
    expect(item).toHaveProperty('isFavorite')
  })

  it('DC-05 分页参数生效，pageSize 上限 100', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/documents?pageSize=9999', headers: auth(s) })
    expect(r.json().pageSize).toBe(100)
  })

  it('DC-07 正文内容接口返回 {paragraphs, imageRefs, totalParagraphs}', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s, { paragraphs: [{ text: '甲。' }, { text: '乙。' }] })
    const r = await app.inject({ method: 'GET', url: `/api/documents/${docId}/content`, headers: auth(s) })
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.paragraphs).toHaveLength(2)
    expect(b.totalParagraphs).toBe(2)
    expect(Array.isArray(b.imageRefs)).toBe(true)
    expect(b.docId).toBe(docId)
  })

  it('DC-07 句子的 sentences 数组存在（形状对齐契约 §4.5）', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s)
    const r = await app.inject({ method: 'GET', url: `/api/documents/${docId}/content`, headers: auth(s) })
    expect(r.json().paragraphs[0]).toHaveProperty('sentences')
  })

  it('★ DC-08 响应带 ETag，If-None-Match 命中返回 304', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s)
    const first = await app.inject({ method: 'GET', url: `/api/documents/${docId}/content`, headers: auth(s) })
    const etag = first.headers.etag
    expect(etag).toBeTruthy()

    const second = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/content`,
      headers: { ...auth(s), 'if-none-match': etag as string },
    })
    expect(second.statusCode).toBe(304)
    expect(second.body).toBe('')
  })

  it('DC-09 按 from/to 分段取用，只返回指定区间', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s, {
      paragraphs: [{ text: '第0段。' }, { text: '第1段。' }, { text: '第2段。' }, { text: '第3段。' }],
    })
    const r = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/content?from=1&to=2`, headers: auth(s),
    })
    const b = r.json()
    expect(b.from).toBe(1)
    expect(b.to).toBe(2)
    expect(b.paragraphs.map((p: { paraIndex: number }) => p.paraIndex)).toEqual([1, 2])
    expect(b.totalParagraphs).toBe(4) // 总数仍是全量
  })

  it('★ DC-10 访问他人文档 → 403 FORBIDDEN_NOT_OWNER', async () => {
    const owner = await registerAndLogin(app)
    const docId = await importDoc(owner)
    const other = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: `/api/documents/${docId}`, headers: auth(other) })
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('FORBIDDEN_NOT_OWNER')
  })

  it('DC-11 访问不存在的文档 → 404', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/documents/doc_nope', headers: auth(s) })
    expect(r.statusCode).toBe(404)
  })

  it('★ DC-12 按关键字检索（标题 / 作者 / 文件名）', async () => {
    const s = await registerAndLogin(app)
    await importDoc(s, { title: '独一无二的标题甲' })
    await importDoc(s, { title: '另一个标题乙' })

    const hit = await app.inject({ method: 'GET', url: '/api/documents?keyword=独一无二', headers: auth(s) })
    expect(hit.json().total).toBe(1)
    expect(hit.json().items[0].title).toBe('独一无二的标题甲')

    const miss = await app.inject({ method: 'GET', url: '/api/documents?keyword=不存在的关键词', headers: auth(s) })
    expect(miss.json().total).toBe(0)
  })

  it('★ DC-13 category=bookmarked 只返回有书签的文档', async () => {
    const s = await registerAndLogin(app)
    const withBm = await importDoc(s, { title: '有书签的' })
    await importDoc(s, { title: '没书签的' })

    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: {
        bookmarkId: `bm_cat_${Date.now()}`, docId: withBm,
        anchor: { chapterIndex: 0, paragraphIndex: 0, sentenceIndex: 0, charOffset: 0, scrollOffset: 0 },
        name: '分类用', updatedAt: new Date().toISOString(),
      },
    })

    const r = await app.inject({ method: 'GET', url: '/api/documents?category=bookmarked', headers: auth(s) })
    const ids = r.json().items.map((i: { docId: string }) => i.docId)
    expect(ids).toContain(withBm)
    expect(r.json().items.every((i: { docId: string }) => i.docId === withBm)).toBe(true)
  })

  it('★ DC-14 导入时上传原始文件 → 200，resourceUrl 回写', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s, { fileName: '原文件.txt' })

    const put = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/file`,
      // 契约 §4.2 的原始文件走 application/octet-stream（server/src/app.ts 的 binaryTypes）
      headers: { ...auth(s), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('原始文件内容'),
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().fileUrl).toBe(`/api/documents/${docId}/file`)

    const detail = await app.inject({ method: 'GET', url: `/api/documents/${docId}`, headers: auth(s) })
    expect(detail.json().resourceUrl).toBe(`/api/documents/${docId}/file`)
  })

  it('DC-14 原始文件能读回，带 Content-Disposition', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s, { fileName: '读回.txt' })
    await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/file`,
      headers: { ...auth(s), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('读回内容'),
    })
    const r = await app.inject({ method: 'GET', url: `/api/documents/${docId}/file`, headers: auth(s) })
    expect(r.statusCode).toBe(200)
    expect(r.body).toBe('读回内容')
    expect(r.headers['content-disposition']).toContain('attachment')
  })

  it('DC-14 上传空文件 → 400', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s)
    const r = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/file`,
      headers: { ...auth(s), 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(0),
    })
    expect(r.statusCode).toBe(400)
  })

  it('DC-14 没上传过时读原始文件 → 404', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s)
    const r = await app.inject({ method: 'GET', url: `/api/documents/${docId}/file`, headers: auth(s) })
    expect(r.statusCode).toBe(404)
  })

  it('删除文档 → 204，之后读不到', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s)
    const del = await app.inject({ method: 'DELETE', url: `/api/documents/${docId}`, headers: auth(s) })
    expect(del.statusCode).toBe(204)
    const r = await app.inject({ method: 'GET', url: `/api/documents/${docId}`, headers: auth(s) })
    expect(r.statusCode).toBe(404)
  })

  it('删除他人文档 → 403', async () => {
    const owner = await registerAndLogin(app)
    const docId = await importDoc(owner)
    const other = await registerAndLogin(app)
    const r = await app.inject({ method: 'DELETE', url: `/api/documents/${docId}`, headers: auth(other) })
    expect(r.statusCode).toBe(403)
  })

  it('文档详情返回 paragraphCount / imageCount', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s, {
      paragraphs: [{ text: '甲。' }, { text: '乙。' }],
      imageRefs: [{ imageId: `img_detail_${Date.now()}`, paraIndex: 0, src: 'a.png', alt: '图' }],
    })
    const r = await app.inject({ method: 'GET', url: `/api/documents/${docId}`, headers: auth(s) })
    expect(r.json().paragraphCount).toBe(2)
    expect(r.json().imageCount).toBe(1)
  })

  it('书架只列出自己的文档', async () => {
    const a = await registerAndLogin(app)
    const b = await registerAndLogin(app)
    await importDoc(a, { title: 'A 的书' })
    const r = await app.inject({ method: 'GET', url: '/api/documents', headers: auth(b) })
    expect(r.json().items.map((i: { title: string }) => i.title)).not.toContain('A 的书')
  })
})

describe('IM-01 ~ IM-11 图片资源（契约 §4.3 / §5）', () => {
  /**
   * 每个用例造一篇独立文档。
   *
   * 这里让 imageId 逐次不同只是为了用例之间好排查。跨文档同名图片的主键
   * 冲突（原 D-T01）已修：`T_ImageResource` 主键改为 `(doc_id, image_id)`，
   * 回归用例见 `cross-document-imageid.test.ts`。
   */
  let imgSeq = 0
  async function docWithImage() {
    const s = await registerAndLogin(app)
    const imageId = `img_probe${imgSeq++}`
    const docId = await importDoc(s, {
      paragraphs: [{ text: '有图的段落。' }],
      imageRefs: [{ imageId, paraIndex: 0, src: `OEBPS/images/fig${imgSeq}.png`, alt: '插图' }],
    })
    return { s, docId, imageId }
  }

  it('★ IM-01 刚导入时 imageUrl 为空（还没有设备上传过）', async () => {
    const { s, docId } = await docWithImage()
    const r = await app.inject({ method: 'GET', url: `/api/documents/${docId}/content`, headers: auth(s) })
    expect(r.json().imageRefs[0].imageUrl).toBeNull()
  })

  it('★ IM-02 未上传的图 GET → 404（前端据此显示占位）', async () => {
    const { s, docId, imageId } = await docWithImage()
    const r = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/images/${imageId}`, headers: auth(s),
    })
    expect(r.statusCode).toBe(404)
  })

  it('IM-03 上传单张图片 → 200，返回 imageUrl 与字节数', async () => {
    const { s, docId, imageId } = await docWithImage()
    const r = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/images/${imageId}`,
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().imageUrl).toBe(`/api/documents/${docId}/images/${imageId}`)
    expect(r.json().bytes).toBe(PNG_1X1.length)
  })

  it('★ IM-04 上传后能取回，字节一致，Content-Type 正确', async () => {
    const { s, docId, imageId } = await docWithImage()
    await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/images/${imageId}`,
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    const r = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/images/${imageId}`, headers: auth(s),
    })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toContain('image/png')
    expect(Buffer.from(r.rawPayload).equals(PNG_1X1)).toBe(true)
  })

  it('★ IM-05 /content 里的 imageUrl 已回写', async () => {
    const { s, docId, imageId } = await docWithImage()
    await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/images/${imageId}`,
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    const r = await app.inject({ method: 'GET', url: `/api/documents/${docId}/content`, headers: auth(s) })
    expect(r.json().imageRefs[0].imageUrl).toBe(`/api/documents/${docId}/images/${imageId}`)
  })

  it('★ IM-08 换设备后仍能显示（服务端那份一直在）', async () => {
    const { s, docId, imageId } = await docWithImage()
    await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/images/${imageId}`,
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    // 图是文档级资源不是设备级：同一读者换设备仍取得到
    const r = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/images/${imageId}`, headers: auth(s),
    })
    expect(r.statusCode).toBe(200)
    expect(Buffer.from(r.rawPayload).equals(PNG_1X1)).toBe(true)
  })

  it('IM-04 alt 字段贯通（D-07：以前被丢弃，读者看到的是包内路径）', async () => {
    const { s, docId } = await docWithImage()
    const r = await app.inject({ method: 'GET', url: `/api/documents/${docId}/content`, headers: auth(s) })
    expect(r.json().imageRefs[0].alt).toBe('插图')
    expect(r.json().imageRefs[0].src).toContain('OEBPS/images/fig')
  })

  it('不支持的类型 → 415', async () => {
    const { s, docId, imageId } = await docWithImage()
    const r = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/images/${imageId}`,
      headers: { ...auth(s), 'content-type': 'application/x-evil' }, payload: PNG_1X1,
    })
    expect(r.statusCode).toBe(415)
  })

  it('空体上传 → 400', async () => {
    const { s, docId, imageId } = await docWithImage()
    const r = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/images/${imageId}`,
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: Buffer.alloc(0),
    })
    expect(r.statusCode).toBe(400)
  })

  it('上传不存在的 imageId → 404', async () => {
    const { s, docId } = await docWithImage()
    const r = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/images/img_nope`,
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    expect(r.statusCode).toBe(404)
  })

  it('★ 他人文档的图不能读也不能传 → 403', async () => {
    const { docId, imageId } = await docWithImage()
    const other = await registerAndLogin(app)
    const read = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/images/${imageId}`, headers: auth(other),
    })
    expect(read.statusCode).toBe(403)
    const write = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/images/${imageId}`,
      headers: { ...auth(other), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    expect(write.statusCode).toBe(403)
  })

  it('★ 图片响应带 ETag，命中返回 304', async () => {
    const { s, docId, imageId } = await docWithImage()
    await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/images/${imageId}`,
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    const first = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/images/${imageId}`, headers: auth(s),
    })
    const etag = first.headers.etag as string
    expect(etag).toBeTruthy()
    const second = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/images/${imageId}`,
      headers: { ...auth(s), 'if-none-match': etag },
    })
    expect(second.statusCode).toBe(304)
  })

  it('重新上传换扩展名时旧文件被清掉（不会两份并存）', async () => {
    const { s, docId, imageId } = await docWithImage()
    await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/images/${imageId}`,
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])
    const r = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/images/${imageId}`,
      headers: { ...auth(s), 'content-type': 'image/jpeg' }, payload: jpeg,
    })
    expect(r.statusCode).toBe(200)
    const back = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/images/${imageId}`, headers: auth(s),
    })
    expect(back.headers['content-type']).toContain('image/jpeg')
  })
})

describe('R7-4 收藏（两个方向都幂等）', () => {
  it('收藏 → 200 isFavorite=true；取消 → isFavorite=false', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s)
    const on = await app.inject({ method: 'PUT', url: `/api/documents/${docId}/favorite`, headers: auth(s) })
    expect(on.statusCode).toBe(200)
    expect(on.json().isFavorite).toBe(true)

    const off = await app.inject({ method: 'DELETE', url: `/api/documents/${docId}/favorite`, headers: auth(s) })
    expect(off.statusCode).toBe(200)
    expect(off.json().isFavorite).toBe(false)
  })

  it('★ 重复收藏 / 重复取消都幂等（不报 409）', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s)
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: 'PUT', url: `/api/documents/${docId}/favorite`, headers: auth(s) })
      expect(r.statusCode).toBe(200)
      expect(r.json().isFavorite).toBe(true)
    }
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: 'DELETE', url: `/api/documents/${docId}/favorite`, headers: auth(s) })
      expect(r.statusCode).toBe(200)
      expect(r.json().isFavorite).toBe(false)
    }
  })

  it('书架列表的 isFavorite 跟着变', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s, { title: '会收藏的' })
    await app.inject({ method: 'PUT', url: `/api/documents/${docId}/favorite`, headers: auth(s) })

    const r = await app.inject({ method: 'GET', url: '/api/documents', headers: auth(s) })
    const item = r.json().items.find((i: { docId: string }) => i.docId === docId)
    expect(item.isFavorite).toBe(true)
  })

  it('★ category=favorite 只返回收藏的文档', async () => {
    const s = await registerAndLogin(app)
    const fav = await importDoc(s, { title: '收藏的' })
    await importDoc(s, { title: '没收藏的' })
    await app.inject({ method: 'PUT', url: `/api/documents/${fav}/favorite`, headers: auth(s) })

    const r = await app.inject({ method: 'GET', url: '/api/documents?category=favorite', headers: auth(s) })
    const ids = r.json().items.map((i: { docId: string }) => i.docId)
    expect(ids).toContain(fav)
    expect(ids).toHaveLength(1)
  })

  it('收藏他人文档 → 403；不存在的文档 → 404', async () => {
    const owner = await registerAndLogin(app)
    const docId = await importDoc(owner)
    const other = await registerAndLogin(app)
    expect((await app.inject({ method: 'PUT', url: `/api/documents/${docId}/favorite`, headers: auth(other) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: '/api/documents/doc_nope/favorite', headers: auth(other) })).statusCode).toBe(404)
  })
})

describe('R7-5 阅读时长（纯追加型遥测，client_id 幂等）', () => {
  it('上报一段时长 → 200，返回累计 totalMs', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s)
    const r = await app.inject({
      method: 'POST', url: `/api/documents/${docId}/reading-time`, headers: auth(s),
      payload: { deviceId: 'dev_a', clientId: `c_${Date.now()}`, durationMs: 60_000 },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().totalMs).toBe(60_000)
  })

  it('★ 同一 clientId 重发 → 幂等，累计时长不翻倍', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s)
    const clientId = `idem_${Date.now()}`
    const payload = { deviceId: 'dev_a', clientId, durationMs: 30_000 }
    const first = await app.inject({ method: 'POST', url: `/api/documents/${docId}/reading-time`, headers: auth(s), payload })
    const second = await app.inject({ method: 'POST', url: `/api/documents/${docId}/reading-time`, headers: auth(s), payload })
    expect(second.statusCode).toBe(200)
    expect(second.json().totalMs).toBe(first.json().totalMs)
  })

  it('不同 clientId 的时长累加', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s)
    await app.inject({
      method: 'POST', url: `/api/documents/${docId}/reading-time`, headers: auth(s),
      payload: { deviceId: 'dev_a', clientId: `a_${Date.now()}`, durationMs: 60_000 },
    })
    await app.inject({
      method: 'POST', url: `/api/documents/${docId}/reading-time`, headers: auth(s),
      payload: { deviceId: 'dev_a', clientId: `b_${Date.now()}`, durationMs: 120_000 },
    })
    const r = await app.inject({ method: 'GET', url: `/api/documents/${docId}/reading-time`, headers: auth(s) })
    expect(r.json().totalMs).toBe(180_000)
    expect(r.json().totalMinutes).toBe(3)
  })

  it('参数校验：缺 deviceId / clientId / durationMs 非法 → 400 并列出字段', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s)
    for (const payload of [
      { clientId: 'c', durationMs: 1000 },
      { deviceId: 'd', durationMs: 1000 },
      { deviceId: 'd', clientId: 'c', durationMs: 0 },
      { deviceId: 'd', clientId: 'c', durationMs: -5 },
      { deviceId: 'd', clientId: 'c', durationMs: 'x' },
    ]) {
      const r = await app.inject({ method: 'POST', url: `/api/documents/${docId}/reading-time`, headers: auth(s), payload })
      expect(r.statusCode, JSON.stringify(payload)).toBe(400)
      expect(r.json().details.fields.length).toBeGreaterThan(0)
    }
  })

  it('单段超过 6 小时 → 400（防客户端算错）', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s)
    const r = await app.inject({
      method: 'POST', url: `/api/documents/${docId}/reading-time`, headers: auth(s),
      payload: { deviceId: 'd', clientId: 'c', durationMs: 7 * 60 * 60 * 1000 },
    })
    expect(r.statusCode).toBe(400)
  })

  it('总览返回 total / today / week 与按书分组', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s, { title: '时长书' })
    await app.inject({
      method: 'POST', url: `/api/documents/${docId}/reading-time`, headers: auth(s),
      payload: { deviceId: 'd', clientId: `sum_${Date.now()}`, durationMs: 300_000 },
    })
    const r = await app.inject({ method: 'GET', url: '/api/reading-time/summary', headers: auth(s) })
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.totalMs).toBeGreaterThanOrEqual(300_000)
    expect(b.todayMs).toBeGreaterThanOrEqual(300_000)
    expect(b.books.some((x: { docId: string }) => x.docId === docId)).toBe(true)
  })

  it('★ 不满 1 分钟也至少显示 1 分钟（免得满屏"已读 0 分钟"）', async () => {
    const s = await registerAndLogin(app)
    const docId = await importDoc(s)
    await app.inject({
      method: 'POST', url: `/api/documents/${docId}/reading-time`, headers: auth(s),
      payload: { deviceId: 'd', clientId: `tiny_${Date.now()}`, durationMs: 1000 },
    })
    const r = await app.inject({ method: 'GET', url: `/api/documents/${docId}/reading-time`, headers: auth(s) })
    expect(r.json().totalMinutes).toBe(1)
  })

  it('他人文档上报时长 → 403', async () => {
    const owner = await registerAndLogin(app)
    const docId = await importDoc(owner)
    const other = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST', url: `/api/documents/${docId}/reading-time`, headers: auth(other),
      payload: { deviceId: 'd', clientId: 'c', durationMs: 1000 },
    })
    expect(r.statusCode).toBe(403)
  })
})

describe('R7-5 头像（不能直接 <img src>，必须经接口取二进制）', () => {
  it('上传头像 → 200，/api/users/me 的 avatarUrl 回写', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'PUT', url: '/api/users/me/avatar',
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().avatarUrl).toBe('/api/users/me/avatar')

    const me = await app.inject({ method: 'GET', url: '/api/users/me', headers: auth(s) })
    expect(me.json().avatarUrl).toBe('/api/users/me/avatar')
  })

  it('★ 取头像二进制需要 Bearer（这正是不能直接 <img src> 的原因）', async () => {
    const s = await registerAndLogin(app)
    await app.inject({
      method: 'PUT', url: '/api/users/me/avatar',
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    const noToken = await app.inject({ method: 'GET', url: '/api/users/me/avatar' })
    expect(noToken.statusCode).toBe(401)

    const withToken = await app.inject({ method: 'GET', url: '/api/users/me/avatar', headers: auth(s) })
    expect(withToken.statusCode).toBe(200)
    expect(withToken.headers['content-type']).toContain('image/png')
    expect(Buffer.from(withToken.rawPayload).equals(PNG_1X1)).toBe(true)
  })

  it('未设头像时 GET → 404，avatarUrl 为 null', async () => {
    const s = await registerAndLogin(app)
    const me = await app.inject({ method: 'GET', url: '/api/users/me', headers: auth(s) })
    expect(me.json().avatarUrl).toBeNull()
    const avatar = await app.inject({ method: 'GET', url: '/api/users/me/avatar', headers: auth(s) })
    expect(avatar.statusCode).toBe(404)
  })

  it('移除头像 → 200，之后读不到', async () => {
    const s = await registerAndLogin(app)
    await app.inject({
      method: 'PUT', url: '/api/users/me/avatar',
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    const del = await app.inject({ method: 'DELETE', url: '/api/users/me/avatar', headers: auth(s) })
    expect(del.statusCode).toBe(200)
    expect(del.json().avatarUrl).toBeNull()
    const back = await app.inject({ method: 'GET', url: '/api/users/me/avatar', headers: auth(s) })
    expect(back.statusCode).toBe(404)
  })

  it('头像用 text/plain 传 → 400（Fastify 有默认 text/plain parser，body 是字符串不是 Buffer）', async () => {
    const s = await registerAndLogin(app)
    // MIME_EXT 里没有 text/plain，但**走不到那个 415 分支**：
    // Fastify 自带 text/plain 解析器，req.body 是 string，
    // 于是先撞上 `!Buffer.isBuffer(body)` 的 400。
    // 真实的不支持类型要用一个 Fastify 没有默认解析器的 MIME，见下一条。
    const bad = await app.inject({
      method: 'PUT', url: '/api/users/me/avatar',
      headers: { ...auth(s), 'content-type': 'text/plain' }, payload: Buffer.from('x'),
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().details.fields).toContain('body')
  })

  it('头像用 application/x-evil 传 → 415', async () => {
    const s = await registerAndLogin(app)
    const bad = await app.inject({
      method: 'PUT', url: '/api/users/me/avatar',
      headers: { ...auth(s), 'content-type': 'application/x-evil' }, payload: Buffer.from('x'),
    })
    // ★ 这里返回的 code 是 Fastify 自己的 FST_ERR_CTP_INVALID_MEDIA_TYPE，
    // 不是 server/src/errors.ts 里的 UNSUPPORTED_MEDIA_TYPE —— 因为请求体压根
    // 没进到路由：Fastify 在内容类型解析阶段就拒了。状态码同样是 415，
    // 但错误码不同（见测试报告缺陷表 D-T05）。
    expect(bad.statusCode).toBe(415)
    expect(bad.json().code).toBe('FST_ERR_CTP_INVALID_MEDIA_TYPE')
  })

  it('头像空体 → 400', async () => {
    const s = await registerAndLogin(app)
    const empty = await app.inject({
      method: 'PUT', url: '/api/users/me/avatar',
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: Buffer.alloc(0),
    })
    expect(empty.statusCode).toBe(400)
  })

  it('头像带 ETag，命中 304', async () => {
    const s = await registerAndLogin(app)
    await app.inject({
      method: 'PUT', url: '/api/users/me/avatar',
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    const first = await app.inject({ method: 'GET', url: '/api/users/me/avatar', headers: auth(s) })
    const etag = first.headers.etag as string
    const second = await app.inject({
      method: 'GET', url: '/api/users/me/avatar', headers: { ...auth(s), 'if-none-match': etag },
    })
    expect(second.statusCode).toBe(304)
  })

  it('★ 头像按用户隔离：A 设了头像，B 的 avatarUrl 仍是 null', async () => {
    const a = await registerAndLogin(app)
    const b = await registerAndLogin(app)
    await app.inject({
      method: 'PUT', url: '/api/users/me/avatar',
      headers: { ...auth(a), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    const meB = await app.inject({ method: 'GET', url: '/api/users/me', headers: auth(b) })
    expect(meB.json().avatarUrl).toBeNull()
  })
})

/**
 * 上传体量上限（契约 §4.1 / §4.2 / §4.8）。
 *
 * 这里**故意不构造 500MB 的 body** —— 给 inject 塞一份 500MB 的 Buffer，
 * 测试进程会瞬时多占同等内存、整个 suite 从秒级拖到十几秒，换来的只是一个
 * "数字改对了"的断言，小内存机器还可能直接 OOM。真正会漏的是**三处上限没一起改**，
 * 所以改成：① 断言两个服务端常量同值；② 走 MAX_PARAGRAPHS 这条**便宜的真实路径**
 * 把 413 的分支跑通（20001 个短段落不到 1MB）。
 */
describe('上传体量上限（§4.1 / §4.2）', () => {
  it('★ 请求体上限与原始文件上限必须同值', () => {
    // bodyLimit 在进 handler 之前生效：若它比业务上限小，
    // §4.2 的 413 永远轮不到业务代码发，读者拿到的是 Fastify 那条不带 details 的
    expect(BODY_LIMIT).toBe(MAX_FILE_BYTES)
  })

  it('★ 段落数超过 MAX_PARAGRAPHS → 413 PAYLOAD_TOO_LARGE', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: auth(s),
      payload: importBody({
        paragraphs: Array.from({ length: 20001 }, () => ({ text: '正文。' })),
      }),
    })
    expect(r.statusCode).toBe(413)
    expect(r.json().code).toBe('PAYLOAD_TOO_LARGE')
  })
})
