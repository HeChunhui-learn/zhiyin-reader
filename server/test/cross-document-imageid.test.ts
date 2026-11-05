import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { sha256Hex } from '../../client/src/features/parse/sha256'
import { auth, closeApp, importBody, makeApp, registerAndLogin } from './helpers'

/**
 * 回归：跨文档的图片资源主键冲突（原缺陷 D-T01）。
 *
 * 客户端算 imageId 的算法在 `client/src/features/parse/markdown.ts` 与 `epub.ts`：
 *   imageId = `img_${sha256Hex(`${src}#${paraIndex}`).slice(0, 12)}`
 * 只由「包内路径 + 段落号」决定，**不含 docId**（同一份文件重复解析结果不变）。
 *
 * 旧实现把 `T_ImageResource.image_id` 当成全库主键，于是两本书只要都有
 * `images/cover.jpg`，第二本导入就撞主键 → 500。修复：
 *   · schema 主键改为 `(doc_id, image_id)`；
 *   · `db.ts` 对已存在的旧表做一次迁移；
 *   · DAO 的 `setImageRemoteUrl` 同时按 docId 隔离。
 *
 * 下面这些用例现在断言「两本书都能导入、图片资源互不影响」。
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

/** 复刻客户端生成 imageId 的算法（markdown.ts 与 epub.ts 同口径） */
function clientImageId(src: string, paraIndex: number): string {
  return `img_${sha256Hex(`${src}#${paraIndex}`).slice(0, 12)}`
}

describe('D-T01 跨文档的图片资源主键', () => {
  it('同一 src + 段落下，客户端算出的 imageId 与 docId 无关', () => {
    const a = clientImageId('/OEBPS/images/cover.jpg', 0)
    const b = clientImageId('/OEBPS/images/cover.jpg', 0)
    expect(a).toBe(b)
    expect(a).toMatch(/^img_[0-9a-f]{12}$/)
  })

  it('同一文档内不同段落不会重号（客户端已用 paraIndex 区分）', () => {
    expect(clientImageId('/OEBPS/images/x.png', 0))
      .not.toBe(clientImageId('/OEBPS/images/x.png', 1))
  })

  it('★ 书名不同、图片路径相同 → 两本都能导入成功', async () => {
    const s = await registerAndLogin(app)
    const imageId = clientImageId('/OEBPS/images/cover.jpg', 0)

    const mk = (title: string) =>
      importBody({
        title,
        paragraphs: [{ text: '有封面的一段。' }],
        imageRefs: [{ imageId, paraIndex: 0, src: '/OEBPS/images/cover.jpg', alt: '封面' }],
      })

    const first = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: mk('第一本书') })
    expect(first.statusCode).toBe(201)
    expect(first.json().imageCount).toBe(1)

    const second = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: mk('第二本书') })
    expect(second.statusCode).toBe(201)
    expect(second.json().imageCount).toBe(1)

    const c1 = await app.inject({
      method: 'GET', url: `/api/documents/${first.json().docId}/content`, headers: auth(s),
    })
    const c2 = await app.inject({
      method: 'GET', url: `/api/documents/${second.json().docId}/content`, headers: auth(s),
    })
    expect(c1.json().imageRefs[0].imageId).toBe(imageId)
    expect(c2.json().imageRefs[0].imageId).toBe(imageId)
  })

  it('★ 不同读者的同名图片也各自导入成功（按文档隔离，不再全库唯一）', async () => {
    const a = await registerAndLogin(app)
    const b = await registerAndLogin(app)
    const imageId = clientImageId('/OEBPS/images/shared.png', 0)
    const payload = importBody({
      paragraphs: [{ text: 'x。' }],
      imageRefs: [{ imageId, paraIndex: 0, src: '/OEBPS/images/shared.png', alt: '同名图' }],
    })

    const first = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(a), payload })
    expect(first.statusCode).toBe(201)

    const second = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(b), payload })
    expect(second.statusCode).toBe(201)
  })

  it('图片路径不同则互不影响（正常情况）', async () => {
    const s = await registerAndLogin(app)
    const one = await app.inject({
      method: 'POST', url: '/api/documents', headers: auth(s),
      payload: importBody({
        title: '书一',
        paragraphs: [{ text: 'x。' }],
        imageRefs: [{ imageId: clientImageId('a/cover.jpg', 0), paraIndex: 0, src: 'a/cover.jpg', alt: 'a' }],
      }),
    })
    const two = await app.inject({
      method: 'POST', url: '/api/documents', headers: auth(s),
      payload: importBody({
        title: '书二',
        paragraphs: [{ text: 'y。' }],
        imageRefs: [{ imageId: clientImageId('b/cover.jpg', 0), paraIndex: 0, src: 'b/cover.jpg', alt: 'b' }],
      }),
    })
    expect(one.statusCode).toBe(201)
    expect(two.statusCode).toBe(201)
  })

  it('不传 imageId 时服务端生成唯一 id 的兜底路径仍然可用', async () => {
    const s = await registerAndLogin(app)
    const mk = () =>
      importBody({
        paragraphs: [{ text: 'x。' }],
        imageRefs: [{ paraIndex: 0, src: '/OEBPS/images/cover.jpg', alt: '封面' } as never],
      })
    const first = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: mk() })
    const second = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: mk() })
    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
  })

  it('★ 两本书同名图片可各自上传，remote_url 不会互相回写', async () => {
    const s = await registerAndLogin(app)
    const imageId = clientImageId('/OEBPS/images/cover.jpg', 0)
    const mk = (title: string) =>
      importBody({
        title,
        paragraphs: [{ text: '有封面的一段。' }],
        imageRefs: [{ imageId, paraIndex: 0, src: '/OEBPS/images/cover.jpg', alt: '封面' }],
      })

    const one = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: mk('书一') })
    const two = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: mk('书二') })
    expect(one.statusCode).toBe(201)
    expect(two.statusCode).toBe(201)
    const d1 = one.json().docId as string
    const d2 = two.json().docId as string

    // 只给第一本上传图片
    const up1 = await app.inject({
      method: 'PUT', url: `/api/documents/${d1}/images/${imageId}`,
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    expect(up1.statusCode).toBe(200)

    const c1 = await app.inject({ method: 'GET', url: `/api/documents/${d1}/content`, headers: auth(s) })
    const c2 = await app.inject({ method: 'GET', url: `/api/documents/${d2}/content`, headers: auth(s) })
    expect(c1.json().imageRefs[0].imageUrl).toBe(`/api/documents/${d1}/images/${imageId}`)
    expect(c2.json().imageRefs[0].imageUrl).toBeNull()

    const g2 = await app.inject({
      method: 'GET', url: `/api/documents/${d2}/images/${imageId}`, headers: auth(s),
    })
    expect(g2.statusCode).toBe(404)

    // 第二本再上传自己的同名图片，两本都能正常读回
    const up2 = await app.inject({
      method: 'PUT', url: `/api/documents/${d2}/images/${imageId}`,
      headers: { ...auth(s), 'content-type': 'image/png' }, payload: PNG_1X1,
    })
    expect(up2.statusCode).toBe(200)

    const g1 = await app.inject({
      method: 'GET', url: `/api/documents/${d1}/images/${imageId}`, headers: auth(s),
    })
    const g2b = await app.inject({
      method: 'GET', url: `/api/documents/${d2}/images/${imageId}`, headers: auth(s),
    })
    expect(g1.statusCode).toBe(200)
    expect(g2b.statusCode).toBe(200)
    expect(Buffer.from(g1.rawPayload).equals(PNG_1X1)).toBe(true)
    expect(Buffer.from(g2b.rawPayload).equals(PNG_1X1)).toBe(true)
  })
})
