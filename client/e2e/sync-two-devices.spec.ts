import { expect, test } from '@playwright/test'
import { DEMO_ACCOUNT, DEMO_DOC_ID, DEMO_PASSWORD, loginSubmit, openDemoBook } from './fixtures'

/**
 * 跨设备同步与冲突（契约 §6 / §8）—— **两个真实浏览器上下文**。
 *
 * 这是 docs/02 第 6.1 节列的另一处缺口："多设备真机同步 —— 用两个浏览器上下文
 * 模拟，未在平板 + 笔记本的真实局域网上跑过"。这里把前半句做到位：
 * 两个独立的 browser context 各有自己的 localStorage / IndexedDB / 内存令牌，
 * 等价于两台设备，走的是同一个真实服务端。
 *
 * ⚠️ 仍然**不是**真实的局域网双机测试（那需要两台机器与 http 访问），
 * 报告里如实列为未覆盖项。
 */

/** 在给定上下文里登录演示账号 */
async function loginIn(context: import('@playwright/test').BrowserContext) {
  const page = await context.newPage()
  await page.goto('/login')
  await page.locator('.input[placeholder="手机号／邮箱"]').fill(DEMO_ACCOUNT)
  await page.locator('input[type="password"]').fill(DEMO_PASSWORD)
  await loginSubmit(page).click()
  await expect(page.locator('.shelf-page')).toBeVisible({ timeout: 15_000 })
  return page
}

/**
 * 在阅读界面里真实滚动正文，触发进度上报。
 *
 * ⚠️ 进度**只在 `.reader-scroll` 的 scroll 事件里上报**（`client/src/pages/ReaderView.tsx:259-281`），
 * 防抖 1500ms（`client/src/features/sync/useProgress.ts:19` 的 `DEBOUNCE_MS`）。
 * 点句子只改跟读游标，**不会**上报进度 —— 我第一版就是只点了句子，结果
 * 服务端一条进度都没有（`items: []`）。所以这里必须真的滚。
 */
async function scrollReader(page: import('@playwright/test').Page, times = 3) {
  const scroll = page.locator('.reader-scroll')
  await expect(scroll).toBeVisible()
  for (let i = 0; i < times; i++) {
    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollTop + Math.round(el.clientHeight * 0.6)
    })
    // 让 16ms 的滚动节流先跑一次
    await page.waitForTimeout(120)
  }
  // 等防抖窗口（1500ms）过去，让上报真正发出
  await page.waitForTimeout(2000)
}

test.describe('跨设备同步（两个独立浏览器上下文）', () => {
  test('★ 两个上下文各有一份独立存储（等价两台设备）', async ({ browser }) => {
    const a = await browser.newContext()
    const b = await browser.newContext()

    const pa = await loginIn(a)
    const pb = await loginIn(b)

    // 两个上下文都能独立登录到同一个账号，且各自渲染出书架
    await expect(pa.locator('.book-card').first()).toBeVisible()
    await expect(pb.locator('.book-card').first()).toBeVisible()

    // 两台"设备"的 deviceId 必须不同（localStorage 按 context 隔离）
    const devA = await pa.evaluate(() => localStorage.getItem('zhiyin.deviceId'))
    const devB = await pb.evaluate(() => localStorage.getItem('zhiyin.deviceId'))
    expect(devA).toMatch(/^dev_/)
    expect(devB).toMatch(/^dev_/)
    expect(devA).not.toBe(devB)

    await a.close()
    await b.close()
  })

  test('★ 设备 A 上报进度后，设备 B 拉取时能看到 A 的那条记录', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()

    try {
      const pageA = await loginIn(ctxA)
      const pageB = await loginIn(ctxB)

      const devA = await pageA.evaluate(() => localStorage.getItem('zhiyin.deviceId'))

      // A 打开演示书并真的滚动正文 —— 这才是会上报进度的动作
      await openDemoBook(pageA)
      await scrollReader(pageA, 3)

      // 直接问服务端：这篇文档的进度应当有 A 那条
      const items = await pageB.evaluate(async (docId) => {
        const rt = localStorage.getItem('zhiyin.refreshToken')
        const lr = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt }),
        })
        const { accessToken } = await lr.json()
        const r = await fetch(`/api/documents/${docId}/progress`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        return (await r.json()).items as { deviceId: string; anchor: { paragraphIndex: number } }[]
      }, DEMO_DOC_ID)

      // 契约 §6.1：必须返回所有设备的记录，否则新设备拉不到别端进度
      const devIds = items.map((i) => i.deviceId)
      expect(devIds).toContain(devA)

      // A 读到的位置应当被记下来了，而且是滚动之后的（不是第 0 段）
      const aRecord = items.find((i) => i.deviceId === devA)
      expect(aRecord).toBeTruthy()
      expect(aRecord!.anchor.paragraphIndex).toBeGreaterThan(0)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('★ 书架上的进度条随阅读前进（percent 真实变化）', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await loginIn(ctx)
      await openDemoBook(page)

      // 读下去：滚动触发上报，也顺带让 currentParaRef 往前
      await scrollReader(page, 4)

      // 回书架，这本书的进度条应当出现且不再是 0
      await page.locator('.reader-topbar').getByRole('button', { name: '返回' }).click()
      await expect(page).toHaveURL(/\/shelf$/)

      const card = page.locator('.book-card').filter({ hasText: '人间词话' }).first()
      await expect(card).toBeVisible()
      // 有进度记录时 .book-progress-fill 才渲染出来（LibraryView 的 progress 分支）
      const fill = card.locator('.book-progress-fill')
      await expect(fill).toBeVisible({ timeout: 15_000 })
      await expect
        .poll(async () => fill.evaluate((el) => (el as HTMLElement).style.width || '0%'), {
          timeout: 15_000,
        })
        .not.toBe('0%')
    } finally {
      await ctx.close()
    }
  })

  test('★ 设备 A 加书签后，设备 B 的「我的书签」总览里能看到（跨设备书签同步）', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()

    try {
      const pageA = await loginIn(ctxA)
      const pageB = await loginIn(ctxB)

      // A 在演示书里加一个带唯一名字的书签
      const markName = `跨端书签_${Date.now()}`
      await openDemoBook(pageA)
      await pageA.locator('.sent').nth(2).click()
      await pageA.locator('.reader-topbar').getByRole('button', { name: /书签/ }).click()

      const panelA = pageA.locator('.toc-panel').filter({ hasText: '加当前位置' })
      await panelA.getByRole('button', { name: '加当前位置' }).click()
      await panelA.locator('input.mark-rename').fill(markName)
      await panelA.getByRole('button', { name: '添加' }).click()
      await expect(panelA.locator('.mark-name').filter({ hasText: markName })).toBeVisible({ timeout: 10_000 })

      // B 打开书签面板，应当拉到 A 的那条（B 的设备身份不同，走的是服务端同步）
      await openDemoBook(pageB)
      await pageB.locator('.reader-topbar').getByRole('button', { name: /书签/ }).click()
      const panelB = pageB.locator('.toc-panel').filter({ hasText: '加当前位置' })
      await expect(panelB.locator('.mark-name').filter({ hasText: markName })).toBeVisible({ timeout: 15_000 })

      // B 还能跳到这个书签的位置
      await panelB.locator('.mark-name').filter({ hasText: markName }).click()
      await expect(pageB.locator('.sent.sent-active')).toHaveCount(1)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('★ 两个读者互相看不到对方的书（数据隔离）', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()

    try {
      // A 用演示账号
      const pageA = await loginIn(ctxA)
      // B 注册一个全新账号
      const pageB = await ctxB.newPage()
      const account = `e2e_iso_${Date.now()}@example.com`
      await pageB.goto('/login')
      await pageB.getByRole('button', { name: '注册', exact: true }).click()
      await pageB.locator('.input[placeholder="手机号／邮箱"]').fill(account)
      await pageB.locator('input[type="password"]').fill('e2e_password_123')
      await loginSubmit(pageB).click()
      await expect(pageB.locator('.shelf-page')).toBeVisible({ timeout: 15_000 })

      // A 有演示书，B 的书架是空的
      await expect(pageA.locator('.book-card').first()).toBeVisible()
      await expect(pageB.locator('.book-card')).toHaveCount(0)

      // B 直接访问 A 的文档 → 界面给中文错误而不是白屏
      await pageB.goto(`/read/${DEMO_DOC_ID}`)
      await expect(pageB.locator('.reader-page .shelf-empty .error-text')).toBeVisible({ timeout: 15_000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
