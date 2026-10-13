import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { sha256Hex } from '../../client/src/features/parse/sha256'
import { auth, closeApp, importBody, makeApp, registerAndLogin } from './helpers'

/**
 * ★ 发现的缺陷 D-T01：两本书里有同名图片时，第二本**导入直接 500**。
 *
 * 机制（两端各自的实现都没有错，拼起来才出问题）：
 *   · 客户端算 imageId 的算法在 `client/src/features/parse/markdown.ts:64`：
 *       imageId = `img_${sha256Hex(`${src}#${paraIndex}`).slice(0, 12)}`
 *     —— 只由「包内路径 + 段落号」决定，**不含 docId**。
 *     那里的注释写着这是刻意的（"同一份文件重复解析结果不变"）。
 *   · 服务端 `server/sql/schema.sql:72` 把 `image_id` 定成**全库主键**：
 *       image_id TEXT PRIMARY KEY
 *   · `server/src/routes/documents.ts:217` 直接用客户端给的 imageId 入库。
 *
 * 于是两本不同的书，只要都有一张 `/OEBPS/images/cover.jpg` 在第 0 段，
 * 第二次导入就撞 `UNIQUE constraint failed: T_ImageResource.image_id`，
 * 被统一错误信封兜成 500「服务端出错了，请稍后重试。」
 *
 * 为什么危险：EPUB 里 `images/cover.jpg`、`images/fig1.png` 是极常见的命名，
 * 一个读者导入两本同源排版的电子书就会踩到，而报错信息完全指不出原因。
 *
 * 这份文件**如实钉住当前行为**（断言写的是"现在会 500"），不改产品代码 ——
 * 修法涉及 schema（复合主键）与接口契约，属于项目组的决策。
 * 若要改成"能导入"，把下面的 expect 反过来即可，届时这条用例自然转绿。
 */
let app: FastifyInstance
beforeAll(async () => {
  app = await makeApp()
})
afterAll(async () => {
  await closeApp(app)
})

/** 复刻客户端生成 imageId 的算法（markdown.ts:64 与 epub.ts 同口径） */
function clientImageId(src: string, paraIndex: number): string {
  return `img_${sha256Hex(`${src}#${paraIndex}`).slice(0, 12)}`
}

describe('D-T01 跨文档的图片资源主键冲突', () => {
  it('★ 同一 src + 段落下，客户端算出的 imageId 与 docId 无关（所以必然重号）', () => {
    const a = clientImageId('/OEBPS/images/cover.jpg', 0)
    const b = clientImageId('/OEBPS/images/cover.jpg', 0)
    expect(a).toBe(b)
    expect(a).toMatch(/^img_[0-9a-f]{12}$/)
  })

  it('同一文档内不同段落不会重号（客户端已用 paraIndex 区分）', () => {
    expect(clientImageId('/OEBPS/images/x.png', 0))
      .not.toBe(clientImageId('/OEBPS/images/x.png', 1))
  })

  it('★ 书名不同、图片路径相同 → 第二次导入返回 500（当前实际行为）', async () => {
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
    // 现状：撞 T_ImageResource.image_id 主键 → 统一错误信封兜成 500
    expect(second.statusCode).toBe(500)
    expect(second.json().code).toBe('INTERNAL_ERROR')
    // 报错信息指不出真正原因，这是这个缺陷最麻烦的地方
    expect(second.json().message).toBe('服务端出错了，请稍后重试。')
  })

  it('★ 不同读者的同名图片同样会撞（主键是全库的，不隔离读者）', async () => {
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
    expect(second.statusCode).toBe(500) // 另一个读者也导不进去
  })

  it('图片路径不同则相安无事（缺陷只在同名图片上发作）', async () => {
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

  it('★ 不传 imageId 时服务端会自己生成唯一 id，不会撞（兜底路径是好的）', async () => {
    const s = await registerAndLogin(app)
    const mk = () =>
      importBody({
        paragraphs: [{ text: 'x。' }],
        // imageRefs 里不给 imageId，走 documents.ts:217 的 `img_${randomUUID}` 兜底
        imageRefs: [{ paraIndex: 0, src: '/OEBPS/images/cover.jpg', alt: '封面' } as never],
      })
    const first = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: mk() })
    const second = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: mk() })
    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
  })
})
