import { expect, test } from '@playwright/test'
import { makeEpub } from './epub-fixture'
import { collectConsoleErrors, registerFresh } from './fixtures'

/**
 * EPUB 解析的真机用例（docs/02 的 PA-09 ~ PA-14）。
 *
 * 为什么放在端到端而不是 Vitest：见 `e2e/epub-fixture.ts` 顶部的说明 ——
 * epub.js 的 `section.load()` 需要真实 DOM，在 Node 里会静默挂住；
 * 而 D-04 / D-05 / D-06 三个缺陷恰恰都是真机才暴露的那一类。
 *
 * 这些用例走**完整导入链路**：真实 ZIP → 浏览器里的 epub.js → 结构化段落 →
 * 上传 → 卡片出现 → 打开阅读。断言既看界面，也直接问服务端要解析结果。
 */

/** 导入一本 EPUB 并等卡片出现，返回书名 */
async function importEpub(
  page: import('@playwright/test').Page,
  buf: Buffer,
  name: string,
): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: 'application/epub+zip',
    buffer: buf,
  })
}

test.describe('EPUB 解析（PA-09 ~ PA-14）', () => {
  test('★ PA-09 读出 dc:title / dc:creator，并导入成功', async ({ page }) => {
    const errors = collectConsoleErrors(page)
    await registerFresh(page)

    const buf = await makeEpub({ title: '独一无二的EPUB书名', author: '王国维' })
    await importEpub(page, buf, 'fixture.epub')

    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 30_000 })
    // 书名取 dc:title（不是文件名）
    await expect(page.locator('.book-title')).toContainText('独一无二的EPUB书名')
    // 卡片格式标签是 EPUB
    await expect(page.locator('.tag')).toContainText('EPUB')

    expect(errors).toEqual([])
  })

  test('★ PA-09 作者写进文档详情（dc:creator）', async ({ page }) => {
    await registerFresh(page)
    const buf = await makeEpub({ title: '作者测试书', author: '王国维' })
    await importEpub(page, buf, 'author.epub')
    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 30_000 })

    // 卡片上显示作者
    await expect(page.locator('.book-author')).toContainText('王国维')
  })

  test('★ 打开 EPUB：标题与段落按 spine 顺序渲染成真实 DOM', async ({ page }) => {
    const errors = collectConsoleErrors(page)
    await registerFresh(page)

    const buf = await makeEpub({
      title: '阅读测试书',
      heading: '第一章 起',
      paragraphs: ['甲段第一句。甲段第二句。', '乙段只有一句。'],
    })
    await importEpub(page, buf, 'read.epub')
    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 30_000 })
    await page.locator('.book-card').first().click()

    await expect(page).toHaveURL(/\/read\//)
    await expect(page.locator('.reader-content')).toBeVisible({ timeout: 15_000 })

    // h1 渲染成 .doc-h1
    await expect(page.locator('.reader-content .doc-h1')).toContainText('第一章 起')
    // 正文段落渲染成 .doc-p，句子铺成 .sent
    const sents = page.locator('.sent')
    await expect(sents.first()).toBeVisible()
    expect(await sents.count()).toBeGreaterThanOrEqual(3)
    await expect(page.locator('.reader-content')).toContainText('甲段第一句。')

    expect(errors).toEqual([])
  })

  test('★ PA-11 / D-05 相对路径 ../images/ 能解析到包内绝对路径，图不丢', async ({ page }) => {
    await registerFresh(page)

    // 章节在 OEBPS/ch1.xhtml，图片写 ../images/<唯一名>.png，
    // 实际也放在 OEBPS/images/<唯一名>.png（fixture 默认自洽）。
    // 不写死文件名：缺陷 D-T01 让同名图片的第二本导入必然 500。
    const buf = await makeEpub({ title: '相对路径书' })
    await importEpub(page, buf, 'relpath.epub')
    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 30_000 })
    await page.locator('.book-card').first().click()
    await expect(page.locator('.reader-content')).toBeVisible({ timeout: 15_000 })

    // 图片段落真的渲染成 <figure>（LazyImage 的外壳），不是"图片引用缺失"
    await expect(page.locator('.reader-content figure, .reader-content .doc-figure').first())
      .toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.reader-content')).not.toContainText('这一段的图片引用缺失')
  })

  test('★ PA-12 / D-06 `<figure><img/></figure>` 的图不漏（querySelectorAll 查不到元素自己）', async ({ page }) => {
    await registerFresh(page)

    const buf = await makeEpub({
      title: 'figure结构书',
      imageWrap: 'figure',
    })
    await importEpub(page, buf, 'figure.epub')
    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 30_000 })
    await page.locator('.book-card').first().click()
    await expect(page.locator('.reader-content')).toBeVisible({ timeout: 15_000 })

    // 整张图没被漏掉：段落里存在 figure 结构，且不说"图片引用缺失"
    await expect(page.locator('.reader-content figure, .reader-content .doc-figure').first())
      .toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.reader-content')).not.toContainText('这一段的图片引用缺失')
    // 图注文字作为紧随其后的一段被保留（epub.ts 的 walk 逻辑）
    await expect(page.locator('.reader-content')).toContainText('图注文字')
  })

  test('★ PA-07 图片路径带前导斜杠（D-05：epub.js 的 getBlob 写死了 url.substr(1)）', async ({ page }) => {
    await registerFresh(page)

    const buf = await makeEpub({ title: '前导斜杠书' })
    await importEpub(page, buf, 'slash.epub')
    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 30_000 })

    // 直接问服务端要解析结果：imageRefs 的 src 应当是**带前导斜杠的包内绝对路径**
    const refs = await page.evaluate(async () => {
      const rt = localStorage.getItem('zhiyin.refreshToken')
      const lr = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      })
      const { accessToken } = await lr.json()
      const list = await fetch('/api/documents', { headers: { Authorization: `Bearer ${accessToken}` } })
      const docId = (await list.json()).items[0].docId
      const c = await fetch(`/api/documents/${docId}/content`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      return (await c.json()).imageRefs as { imageId: string; src: string; alt: string }[]
    })

    expect(refs).toHaveLength(1)
    // joinPath 保留前导斜杠是**故意的**（epub.ts:57-74 的注释）
    expect(refs[0].src).toMatch(/^\/OEBPS\/images\/fig_.*\.png$/)
    expect(refs[0].alt).toBe('插图说明')
    // imageId 形如 img_ + 12 位十六进制
    expect(refs[0].imageId).toMatch(/^img_[0-9a-f]{12}$/)
  })

  test('★ PA-14 / D-04 解析阶段不产生游离的 object URL', async ({ page }) => {
    await registerFresh(page)

    // 在页面里挂钩 createObjectURL / revokeObjectURL，统计导入过程中的调用
    await page.evaluate(() => {
      const w = window as unknown as { __created: number; __revoked: number }
      w.__created = 0
      w.__revoked = 0
      const origCreate = URL.createObjectURL.bind(URL)
      const origRevoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = (obj: Blob | MediaSource) => {
        w.__created++
        return origCreate(obj)
      }
      URL.revokeObjectURL = (url: string) => {
        w.__revoked++
        return origRevoke(url)
      }
    })

    const buf = await makeEpub({ title: 'objectURL测试书' })
    await importEpub(page, buf, 'objurl.epub')
    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 30_000 })

    const counts = await page.evaluate(() => {
      const w = window as unknown as { __created: number; __revoked: number }
      return { created: w.__created, revoked: w.__revoked }
    })

    // 导入阶段不该有**净增**的 object URL。
    // epub.js 在 archived 模式下默认 replacements:'blobUrl' 会为每条资源建一个
    // 由它自己持有、调用方拿不到的 object URL（D-04）；代码里显式关掉了
    // （epub.ts:172 的 { replacements: 'none' }）。这里断言的是"没有泄漏"——
    // 建了就一定要撤，或者干脆一个都不建。
    expect(counts.created, `建了 ${counts.created} 个、撤了 ${counts.revoked} 个`).toBe(0)
  })

  test('★ PA-16 EPUB 的句子随段落一并上传（sentences 数组非空）', async ({ page }) => {
    await registerFresh(page)

    const buf = await makeEpub({
      title: '句子上传书',
      paragraphs: ['一句。二句。三句。', '第四句。'],
    })
    await importEpub(page, buf, 'sent.epub')
    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 30_000 })

    // 打开阅读界面，句子应当被切分并铺出来（句子在前端切分后随段落上传）
    await page.locator('.book-card').first().click()
    await expect(page.locator('.sent').first()).toBeVisible({ timeout: 15_000 })
    const n = await page.locator('.sent').count()
    expect(n).toBeGreaterThanOrEqual(4)
  })

  test('★ 只有图片的章节记为 img 段落，文字留空', async ({ page }) => {
    await registerFresh(page)

    const buf = await makeEpub({
      title: '纯图段书',
      imageWrap: 'bare',
      paragraphs: [],
      heading: '',
    })
    await importEpub(page, buf, 'imgonly.epub')
    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 30_000 })

    const paras = await page.evaluate(async () => {
      const rt = localStorage.getItem('zhiyin.refreshToken')
      const lr = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      })
      const { accessToken } = await lr.json()
      const list = await fetch('/api/documents', { headers: { Authorization: `Bearer ${accessToken}` } })
      const docId = (await list.json()).items[0].docId
      const c = await fetch(`/api/documents/${docId}/content`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      return (await c.json()).paragraphs as { type: string; text: string }[]
    })

    const imgPara = paras.find((p) => p.type === 'img')
    expect(imgPara).toBeTruthy()
    expect(imgPara!.text).toBe('')
  })

  test('★★ D-T01（真机复现）两本同名图片的 EPUB，第二本导入直接 500', async ({ page }) => {
    await registerFresh(page)

    // 两本书用**完全相同**的包内图片路径 —— EPUB 里 images/cover.jpg 这种命名极常见
    const name = 'cover.jpg'
    const href = 'images/cover.jpg'
    const path = 'OEBPS/images/cover.jpg'

    // ★ 正文必须不同：`hashContent`（client/src/features/parse/index.ts:156-161）
    // 把 imageRefs 的 src 也算进去，若正文与图片路径都相同，
    // 两次导入的 contentHash 一致，会**先**撞上导入去重（409 CONFLICT_DOCUMENT_DUPLICATE），
    // 根本走不到 image_id 主键那一步。这里要验的正是后面那个。
    const first = await makeEpub({
      title: '第一本',
      imageName: name,
      imageHref: href,
      imagePath: path,
      paragraphs: ['第一本的正文。与第二本不同。'],
    })
    await importEpub(page, first, 'first.epub')
    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 30_000 })

    // 在真实浏览器里再导一本：正文不同（哈希不同，过了去重），
    // 但客户端算出的 imageId 会与上一本完全相同
    const second = await makeEpub({
      title: '第二本',
      imageName: name,
      imageHref: href,
      imagePath: path,
      paragraphs: ['第二本的正文。与第一本不同。'],
    })
    await importEpub(page, second, 'second.epub')

    // 现状：撞 `T_ImageResource.image_id` 全库主键 → 服务端 500，
    // 前端把它显示成服务端的通用错误话术。书名与正文都不同也躲不掉。
    await expect(page.locator('.parse-bar')).toContainText('服务端出错', { timeout: 30_000 })
    await expect(page.locator('.parse-bar')).not.toContainText('已经在书架里')
    // 书架里仍然只有一本 —— 第二本压根没进去
    await expect(page.locator('.book-card')).toHaveCount(1)

    // 这条用例**如实钉住当前行为**，不改产品代码：
    // 修法涉及 schema（image_id 需要复合主键或加 docId 前缀）与接口契约，
    // 属项目组决策。修好后把上面的断言改成"两本都进得去"即可。
  })
})
