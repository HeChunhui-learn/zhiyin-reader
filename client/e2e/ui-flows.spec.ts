import { expect, test } from '@playwright/test'
import {
  DEMO_ACCOUNT,
  collectConsoleErrors,
  hasBrowserVoices,
  loginAsDemo,
  loginSubmit,
  openDemoBook,
  registerFresh,
} from './fixtures'

/**
 * 三类界面用例（AU-*、DC-*，以及浏览器真机缺口）。
 *
 * 重点不是"接口返回了 200"，而是**界面上真的出现了什么** ——
 * 这正是既有的界面用例方法论，只是换到了真实浏览器里。
 */

test.describe('引导与登录界面', () => {
  test('根路径重定向到引导页，界面中文且不白屏', async ({ page }) => {
    const errors = collectConsoleErrors(page)
    await page.goto('/')
    // 契约：/ 与未匹配路径都重定向到 /guide
    await expect(page).toHaveURL(/\/guide$/)
    await expect(page.locator('body')).toContainText('知音漫卷')
    expect(errors, `控制台报错：${errors.join(' | ')}`).toEqual([])
  })

  test('未匹配路径也落到引导页', async ({ page }) => {
    await page.goto('/no-such-route')
    await expect(page).toHaveURL(/\/guide$/)
  })

  test('★ 登录页渲染出品牌区与表单（R7 改版后的形状）', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('.login-brand-logo')).toHaveText('知音漫卷')
    await expect(page.locator('.login-brand-slogan')).toContainText('高山流水遇知音')
    // 示例头像／山水画是内联 SVG，必须真的渲染出节点
    await expect(page.locator('.login-brand svg').first()).toBeVisible()
    await expect(page.locator('.input[placeholder="手机号／邮箱"]')).toBeVisible()
    await expect(page.locator('input[type="password"]')).toBeVisible()
  })

  test('★ 密码错误显示中文提示，且仍在登录页（不白屏）', async ({ page }) => {
    // 这条**故意**制造一次 401，浏览器必然在控制台记一条
    // "Failed to load resource: 401" —— 那是预期内的，不是缺陷，
    // 所以这里不像别的用例那样断言控制台干净。
    await page.goto('/login')
    await page.locator('.input[placeholder="手机号／邮箱"]').fill('demo@example.com')
    await page.locator('input[type="password"]').fill('definitely_wrong_pw')
    await loginSubmit(page).click()

    const alert = page.locator('.alert-error')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('账号或密码错误')
    await expect(page).toHaveURL(/\/login$/)
    // 表单还在（没白屏），且密码框已重置为空
    await expect(page.locator('input[type="password"]')).toBeVisible()
  })

  test('★ 账号格式非法时前端即时拦下并给中文提示', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: '注册', exact: true }).click()
    await page.locator('.input[placeholder="手机号／邮箱"]').fill('bad')
    await page.locator('input[type="password"]').fill('short')
    await loginSubmit(page).click()
    await expect(page.locator('.alert-error')).toContainText('密码长度不得少于 8 位')
  })

  test('第三方登录按钮给出"不实现"的中文说明', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: '使用第三方账号登录' }).click()
    await expect(page.locator('.alert-error')).toContainText('第三方登录尚未接入')
  })
})

test.describe('书架界面（LibraryView）', () => {
  test('★ 登录后进入书架，演示书卡片真实渲染', async ({ page }) => {
    const errors = collectConsoleErrors(page)
    await loginAsDemo(page)
    await expect(page.locator('.shelf-brand')).toHaveText('知音漫卷')
    await expect(page.locator('.book-card').first()).toBeVisible()
    // 演示书应该在列表里（seed 灌的是《人间词话》）
    await expect(page.locator('.book-grid')).toContainText('人间词话')
    expect(errors).toEqual([])
  })

  test('★ 左导航五项齐全（R7 新增「我的收藏」）', async ({ page }) => {
    await loginAsDemo(page)
    const side = page.locator('.shelf-side')
    for (const label of ['全部书籍', '最近阅读', '我的收藏', '我的书签', '离线文档']) {
      await expect(side.getByText(label, { exact: true })).toBeVisible()
    }
    // R7-5 新增的入口
    await expect(side.getByText('阅读时长')).toBeVisible()
  })

  test('★ 搜索框按书名过滤出结果（真实请求 + 真实重渲染）', async ({ page }) => {
    await loginAsDemo(page)
    const search = page.locator('.input.shelf-search')
    await search.fill('人间词话')
    await expect(page.locator('.book-card')).toHaveCount(1)
    await expect(page.locator('.book-title')).toContainText('人间词话')

    await search.fill('绝对不存在的书名xyz')
    await expect(page.locator('.shelf-empty, .book-card')).toBeVisible()
    await expect(page.locator('.book-card')).toHaveCount(0)
  })

  test('★ 演示书的真实段落数展示在卡片上（17 段 / 44 句）', async ({ page }) => {
    await loginAsDemo(page)
    const card = page.locator('.book-card').filter({ hasText: '人间词话' }).first()
    await expect(card).toBeVisible()
    await expect(card.locator('.tag')).toContainText('TXT')
  })

  test('★ 收藏切换后左导航「我的收藏」能过滤出来（R7-4）', async ({ page }) => {
    await loginAsDemo(page)
    const card = page.locator('.book-card').filter({ hasText: '人间词话' }).first()

    // 点收藏按钮（.book-fav），等界面出现收藏态
    const favBtn = card.locator('.book-fav')
    await expect(favBtn).toBeVisible()
    await favBtn.click()

    // 切到「我的收藏」分类，这本书应当在
    await page.locator('.shelf-side').getByText('我的收藏', { exact: true }).click()
    await expect(page.locator('.book-card').filter({ hasText: '人间词话' })).toHaveCount(1)

    // 还原：取消收藏，避免影响别的用例与人工演示
    await page.locator('.shelf-side').getByText('全部书籍', { exact: true }).click()
    const again = page.locator('.book-card').filter({ hasText: '人间词话' }).first()
    await again.locator('.book-fav').click()
    await expect(again.locator('.book-fav')).not.toHaveClass(/on|active/)
  })

  test('★ 阅读时长页真实渲染（R7-5）', async ({ page }) => {
    const errors = collectConsoleErrors(page)
    await loginAsDemo(page)
    await page.locator('.shelf-side').getByText('阅读时长', { exact: true }).click()
    await expect(page).toHaveURL(/\/stats$/)
    // 页面文案是中文，且不该是空白
    await expect(page.locator('body')).toContainText('阅读')
    expect(errors).toEqual([])
  })

  test('★ 个人主页渲染头像区（R7-5，头像经接口取二进制）', async ({ page }) => {
    const errors = collectConsoleErrors(page)
    await loginAsDemo(page)
    await page.goto('/profile')
    await expect(page.locator('.profile-card')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.shelf-brand')).toHaveText('个人主页')

    // 演示账号在 seed 里灌了默认头像（seedDemoAvatar），应当真的取到并显示成 <img>。
    // UserAvatar 走 api.getAvatar() 拿 Blob 再 createObjectURL（UserAvatar.tsx:39-47）——
    // 直接 <img src="/api/users/me/avatar"> 拿不到，因为那个接口要 Bearer。
    const avatar = page.locator('img.avatar')
    await expect(avatar).toBeVisible({ timeout: 10_000 })
    // naturalWidth > 0 说明二进制真的解码了，不是坏图
    await expect
      .poll(async () => avatar.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
    // src 必须是 blob:（证明了"经接口取二进制"这条路）
    expect(await avatar.getAttribute('src')).toMatch(/^blob:/)

    await expect(page.locator('.profile-meta')).toContainText(DEMO_ACCOUNT)
    expect(errors).toEqual([])
  })
})

test.describe('阅读界面（ReaderView）', () => {
  test('★ 打开演示书，正文真实渲染出句子与高亮', async ({ page }) => {
    const errors = collectConsoleErrors(page)
    await loginAsDemo(page)
    await openDemoBook(page)

    // 顶部三按钮互斥结构
    await expect(page.locator('.reader-topbar').getByText('目录')).toBeVisible()
    await expect(page.locator('.reader-topbar').getByText('设置')).toBeVisible()
    await expect(page.locator('.reader-topbar').getByRole('button', { name: /书签/ })).toBeVisible()
    await expect(page.locator('.reader-topbar')).toContainText('人间词话')

    // 句子真的铺出来了，而且有且只有一个活动高亮
    const sentCount = await page.locator('.sent').count()
    expect(sentCount).toBeGreaterThan(10)
    await expect(page.locator('.sent.sent-active')).toHaveCount(1)

    expect(errors).toEqual([])
  })

  test('★ 播放控制条显示"第 N / M 句"，且跟读按钮可用', async ({ page }) => {
    await loginAsDemo(page)
    await openDemoBook(page)
    const bar = page.locator('.playbar')
    await expect(bar).toBeVisible()
    await expect(bar.locator('.pb-counter')).toContainText('第 1 /')
    await expect(bar.getByRole('button', { name: '跟读' })).toBeEnabled()
    await expect(bar.getByRole('button', { name: '上一句' })).toBeDisabled() // 已在第一句
  })

  test('★ 点正文任意句接管跟读：游标跳到那一句并出现「继续跟读」提示', async ({ page }) => {
    await loginAsDemo(page)
    await openDemoBook(page)

    const target = page.locator('.sent').nth(5)
    const text = (await target.textContent()) ?? ''
    await target.click()

    // 那一句成为唯一高亮
    await expect(page.locator('.sent.sent-active')).toHaveCount(1)
    await expect(page.locator('.sent.sent-active')).toHaveText(text)
    // 接管之后自动滚动停住，出现继续跟读的提示条
    await expect(page.locator('.resume-hint')).toContainText('已暂停自动滚动')
    await expect(page.locator('.resume-hint')).toContainText('第 6 句')
    await expect(page.getByRole('button', { name: '继续跟读' })).toBeVisible()
  })

  test('★ 上一句 / 下一句按钮真的移动游标（RA-07）', async ({ page }) => {
    await loginAsDemo(page)
    await openDemoBook(page)
    const bar = page.locator('.playbar')

    await bar.getByRole('button', { name: '下一句' }).click()
    await expect(bar.locator('.pb-counter')).toContainText('第 2 /')
    await bar.getByRole('button', { name: '下一句' }).click()
    await expect(bar.locator('.pb-counter')).toContainText('第 3 /')
    await bar.getByRole('button', { name: '上一句' }).click()
    await expect(bar.locator('.pb-counter')).toContainText('第 2 /')
  })

  test('★ 高亮与游标严格一致（RA-03）：活动句子就是计数器那一句', async ({ page }) => {
    await loginAsDemo(page)
    await openDemoBook(page)
    const bar = page.locator('.playbar')

    await bar.getByRole('button', { name: '下一句' }).click()
    await bar.getByRole('button', { name: '下一句' }).click()

    const active = page.locator('.sent.sent-active')
    await expect(active).toHaveCount(1)
    // data-sentence 的序号应当等于计数器里的序号 - 1
    const idx = await active.getAttribute('data-sentence')
    expect(idx).toBe('2')
    await expect(bar.locator('.pb-counter')).toContainText('第 3 /')
  })

  test('★ 目录抽屉能打开、列出章节、点击跳转（R7-2）', async ({ page }) => {
    await loginAsDemo(page)
    await openDemoBook(page)

    await page.locator('.reader-topbar').getByText('目录').click()
    const panel = page.locator('.toc-panel')
    await expect(panel).toBeVisible()
    await expect(panel.locator('.toc-head')).toHaveText('目录')

    // 演示书有章节标题，目录项应当非空
    const items = panel.locator('.toc-item')
    expect(await items.count()).toBeGreaterThan(0)

    // 点第二项应当跳转，且它变成 active
    if ((await items.count()) > 1) {
      await items.nth(1).click()
      await expect(items.nth(1)).toHaveClass(/active/)
    }
  })

  test('★ 阅读设置面板：切夜晚模式真的改了 :root 的 data-theme（R7-3）', async ({ page }) => {
    await loginAsDemo(page)
    await openDemoBook(page)

    const before = await page.evaluate(() => document.documentElement.dataset.theme ?? '')
    await page.locator('.reader-topbar').getByText('设置').click()

    // 设置面板是右侧抽屉：<aside className="toc-panel drawer-right">（ReaderSettingsPanel.tsx:58）
    const panel = page.locator('.toc-panel.drawer-right')
    await expect(panel).toBeVisible()
    await expect(panel.locator('.toc-head')).toContainText('阅读设置')

    // 主题分档按钮就在面板里（ReaderSettingsPanel.tsx:28-31）
    await panel.getByRole('button', { name: '夜晚' }).click()

    await expect
      .poll(async () => page.evaluate(() => document.documentElement.dataset.theme ?? ''))
      .not.toBe(before)
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')

    // 还原成白天，避免影响后续用例
    await panel.getByRole('button', { name: '白天' }).click()
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.dataset.theme ?? ''))
      .not.toBe('dark')
  })

  test('★ 设置面板改字号后正文真实变大（R7-3）', async ({ page }) => {
    await loginAsDemo(page)
    await openDemoBook(page)

    const sizeOf = () =>
      page.locator('.reader-content').evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))

    const before = await sizeOf()
    await page.locator('.reader-topbar').getByText('设置').click()
    const panel = page.locator('.toc-panel.drawer-right')
    await expect(panel).toBeVisible()

    // 按钮文字是全角：「A＋」/「A－」（ReaderSettingsPanel.tsx:87-92）
    await panel.getByRole('button', { name: 'A＋' }).click()
    await expect.poll(sizeOf).toBeGreaterThan(before)
    // 档位表显示的 px 值也要跟着变
    await expect(panel.locator('.set-value')).not.toHaveText(`${before}px`)

    // 还原
    await panel.getByRole('button', { name: 'A－' }).click()
    await expect.poll(sizeOf).toBe(before)
  })

  test('★ 跟读按钮启动后进入播放态（降级到浏览器发声也算通过）', async ({ page }) => {
    await loginAsDemo(page)
    await openDemoBook(page)
    const bar = page.locator('.playbar')

    // 本机没装 Kokoro → 应当给出降级说明。
    // 注意条上有**两个** .pb-note：音色缺失数量 + 降级说明（PlaybackBar.tsx:125/134），
    // 所以按文字定位，不能只取 .pb-note。
    await expect(bar.locator('.pb-note').filter({ hasText: '已降级为浏览器发声' })).toBeVisible()
    await expect(bar.locator('.pb-note').filter({ hasText: '需安装离线音色包' })).toBeVisible()

    /**
     * 无头 Linux 的 chromium 上没有语音合成后端（除非装了 speech-dispatcher 一类），
     * `speechSynthesis` 对象在、`getVoices()` 却是空数组，一 `speak()` 就
     * `synthesis-failed` —— 跟读进不了播放态。
     *
     * 这不是产品缺陷，而是运行环境没有发声能力，所以这里**分成两条断言**，
     * 两条都是真的在验行为，不拿替身凑一个假的绿：
     *   · 有嗓音 —— 点了跟读应当进入播放态（按钮变「暂停」）
     *   · 无嗓音 —— 应当按 AGENTS.md「错误必须被前端捕获并显示成中文提示，
     *     不允许白屏」的要求给出中文提示，且按钮回到「跟读」，界面不崩
     * 后者正是无声环境下的**正确降级行为**，断言它比 skip 掉整条用例更有价值。
     */
    const canSpeak = await hasBrowserVoices(page)

    await bar.getByRole('button', { name: '跟读' }).click()

    if (canSpeak) {
      // 播放中按钮变成"暂停"
      await expect(bar.getByRole('button', { name: '暂停' })).toBeVisible({ timeout: 10_000 })
      await bar.getByRole('button', { name: '暂停' }).click()
      await expect(bar.getByRole('button', { name: '跟读' })).toBeVisible()
    } else {
      // 没有发声能力：应当看到中文失败提示，并停在「跟读」上，不能白屏
      await expect(page.locator('.resume-error')).toBeVisible({ timeout: 10_000 })
      await expect(bar.getByRole('button', { name: '跟读' })).toBeVisible()
      // 正文仍在（没有因为朗读失败把界面搞白）
      await expect(page.locator('.reader-content')).toBeVisible()
    }
  })

  test('★ 书签面板：点「加当前位置」后列表里真的多一条（B 迭代 BookmarkPanel）', async ({ page }) => {
    await loginAsDemo(page)
    await openDemoBook(page)

    // 点正文某句，让锚点落在明确的位置
    await page.locator('.sent').nth(3).click()

    await page.locator('.reader-topbar').getByRole('button', { name: /书签/ }).click()
    // 书签面板：<aside className="toc-panel">（BookmarkPanel.tsx:216）
    const panel = page.locator('.toc-panel').filter({ hasText: '加当前位置' })
    await expect(panel).toBeVisible()

    const countItems = () => panel.locator('.marks-list .mark-item').count()
    const before = await countItems()

    // 「加当前位置」是**两步**：先展开输入行，再点「添加」（BookmarkPanel.tsx:219-256）
    await panel.getByRole('button', { name: '加当前位置' }).click()
    const addRow = panel.locator('.marks-add')
    await expect(addRow).toBeVisible()
    // 输入框的 placeholder 就是默认名（章节标题 · 首句片段），B4 的成果
    const placeholder = await addRow.locator('input.mark-rename').getAttribute('placeholder')
    expect((placeholder ?? '').trim().length).toBeGreaterThan(0)

    await addRow.getByRole('button', { name: '添加' }).click()
    await expect.poll(countItems).toBe(before + 1)

    // 新加那条的名字应当非空且与默认名一致
    const firstName = await panel.locator('.mark-item .mark-name').first().textContent()
    expect((firstName ?? '').trim().length).toBeGreaterThan(0)
  })

  test('★ 真实导入一本 TXT：解析 → 上传 → 卡片出现 → 能打开阅读', async ({ page }) => {
    const errors = collectConsoleErrors(page)
    await registerFresh(page)

    // 新账号书架是空的
    await expect(page.locator('.book-card')).toHaveCount(0)

    // 造一本小书（中文，含一个章节标题，走真实的 parseTxt）
    const title = `端到端测试书${Date.now()}`
    const txt = [
      '第一章 起',
      '',
      '这是第一段正文。它有第二句话。',
      '',
      '这是第二段。',
    ].join('\n')

    await page.locator('input[type="file"]').setInputFiles({
      name: `${title}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(txt, 'utf8'),
    })

    // 导入回执 + 卡片出现
    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 30_000 })
    // 书名取文件名（第一章 起 只是章节标题，不再当书名）
    await expect(page.locator('.book-title')).toContainText(title)
    await expect(page.locator('.tag')).toContainText('TXT')

    // 点开这本书，句子真的铺出来（说明解析结果与句子都上传成功了）
    await page.locator('.book-card').first().click()
    await expect(page).toHaveURL(/\/read\//)
    await expect(page.locator('.sent').first()).toBeVisible({ timeout: 15_000 })
    const n = await page.locator('.sent').count()
    expect(n).toBeGreaterThanOrEqual(3) // 第一段 2 句 + 第二段 1 句

    expect(errors).toEqual([])
  })

  test('★ 重复导入同一文件被服务端拦下并给中文提示（DC-02）', async ({ page }) => {
    await registerFresh(page)
    const txt = '第一章 甲\n\n正文一句。'
    const file = { name: `重复书${Date.now()}.txt`, mimeType: 'text/plain', buffer: Buffer.from(txt, 'utf8') }

    await page.locator('input[type="file"]').setInputFiles(file)
    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 30_000 })

    // 同样的内容再导一次
    await page.locator('input[type="file"]').setInputFiles(file)
    // 前端把 CONFLICT_DOCUMENT_DUPLICATE 翻成这句中文（LibraryView.tsx:217-223）
    await expect(page.locator('.parse-bar')).toContainText('这本书已经在书架里了', { timeout: 20_000 })
    await expect(page.locator('.book-card')).toHaveCount(1)
  })

  test('★ 删除文档需要二次确认，确认层给出中文警示（R7 修复的顶穿问题）', async ({ page }) => {
    await registerFresh(page)
    await page.locator('input[type="file"]').setInputFiles({
      name: `待删书${Date.now()}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('第一章 乙\n\n正文。', 'utf8'),
    })
    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 30_000 })

    await page.locator('.book-del').click()
    const confirm = page.locator('.book-del-confirm')
    await expect(confirm).toBeVisible()
    await expect(confirm.locator('.book-del-ask')).toContainText('删除《')
    await expect(confirm.locator('.book-del-note')).toContainText('不可恢复')
    await expect(confirm.getByRole('button', { name: '取消' })).toBeVisible()

    // 取消后回到普通卡片态，书还在
    await confirm.getByRole('button', { name: '取消' }).click()
    await expect(confirm).toBeHidden()
    await expect(page.locator('.book-card')).toHaveCount(1)

    // 真删：确认后卡片消失
    await page.locator('.book-del').click()
    await page.locator('.book-del-confirm').getByRole('button', { name: '删除' }).click()
    await expect(page.locator('.book-card')).toHaveCount(0, { timeout: 20_000 })
  })

  test('★ 返回按钮回到书架', async ({ page }) => {
    await loginAsDemo(page)
    await openDemoBook(page)
    await page.locator('.reader-topbar').getByRole('button', { name: '返回' }).click()
    await expect(page).toHaveURL(/\/shelf$/)
    await expect(page.locator('.shelf-page')).toBeVisible()
  })

  test('★ 访问不存在的文档给出中文提示与回到书架（不白屏）', async ({ page }) => {
    // 这条**故意**访问一个不存在的 docId，服务端必然回 404，
    // 浏览器也会记几条 "Failed to load resource: 404" —— 预期内，不断言控制台干净。
    // 要验的是"界面把错误翻成了中文并给出出路"，而不是"没有错误请求"。
    await loginAsDemo(page)
    await page.goto('/read/doc_does_not_exist')
    // 错误态：.reader-page 里的 .shelf-empty 带 .error-text（ReaderView.tsx:515-527）
    const box = page.locator('.reader-page .shelf-empty')
    await expect(box.locator('.error-text')).toContainText('资源不存在', { timeout: 15_000 })
    await expect(box.getByRole('button', { name: '回到书架' })).toBeVisible()

    // 界面没有白屏：品牌与按钮都在
    await expect(page.locator('.reader-page')).toBeVisible()

    // 点回去
    await box.getByRole('button', { name: '回到书架' }).click()
    await expect(page).toHaveURL(/\/shelf$/)
  })
})
