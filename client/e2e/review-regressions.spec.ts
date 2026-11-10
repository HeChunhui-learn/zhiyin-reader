import { test, expect } from '@playwright/test'
import { loginAsDemo } from './fixtures'

test('超过20本书可以翻页，搜索不会被过期响应覆盖，手机布局无横向溢出', async ({ page, request }) => {
  const account = `review_${Date.now()}@example.com`
  await request.post('/api/auth/register', { data: { account, password: 'test12345' } })
  const login = await request.post('/api/auth/login', { data: { account, password: 'test12345' } })
  const headers = { Authorization: `Bearer ${(await login.json()).accessToken}` }
  for (let i = 0; i < 21; i++) {
    const r = await request.post('/api/documents', { headers, data: {
      fileName: `${i}.txt`, fileFormat: 'TXT', title: `分页测试${String(i).padStart(2, '0')}`,
      paragraphs: [{ paraIndex: 0, text: '用于浏览器回归验证的正文。', sentences: [] }],
    } })
    expect(r.status()).toBe(201)
  }
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/login')
  await page.locator('input[placeholder="手机号／邮箱"]').fill(account)
  await page.locator('input[type="password"]').fill('test12345')
  await page.locator('form .btn-primary').click()
  await expect(page.locator('.book-card')).toHaveCount(20)
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.locator('.book-card')).toHaveCount(1)
  await expect(page.getByRole('navigation', { name: '书架分页' })).toContainText('共 21 本')
  await page.route('**/api/documents?**', async route => {
    if (new URL(route.request().url()).searchParams.get('keyword') === '分页') {
      await new Promise(resolve => setTimeout(resolve, 1200))
    }
    await route.continue()
  })
  const search = page.locator('.shelf-search')
  await search.fill('分页')
  await page.waitForRequest(r => r.url().includes('keyword=') && new URL(r.url()).searchParams.get('keyword') === '分页')
  await search.fill('测试00')
  await expect(page.locator('.book-card')).toHaveCount(1)
  await page.waitForTimeout(1500)
  await expect(page.locator('.book-title')).toHaveText('分页测试00')
  await page.screenshot({ path: 'e2e-report/review-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'e2e-report/review-mobile.png', fullPage: true })
  expect(errors).toEqual([])
})


test('时长上报失败只补报一次，keepalive HTTP错误也进入队列', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { account: 'demo@example.com', password: 'demo12345' } })
  const headers = { Authorization: `Bearer ${(await login.json()).accessToken}` }
  const total = async () => (await (await request.get('/api/documents/doc_renjian/reading-time', { headers })).json()).totalMs as number
  const baseline = await total()
  await page.clock.install()
  await loginAsDemo(page)
  const open = async () => {
    await page.locator('.book-card').filter({ hasText: '人间词话' }).click()
    await expect(page.locator('.reader-content .sent').first()).toBeVisible()
  }
  await open()
  const reports: { clientId: string; durationMs: number }[] = []
  let failures = 1
  await page.route('**/api/documents/*/reading-time', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    reports.push(route.request().postDataJSON())
    if (failures > 0) {
      failures--
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL_ERROR', message: '测试上报失败' }) })
    } else await route.continue()
  })
  await page.clock.fastForward(61_000)
  await expect.poll(() => reports.length).toBe(1)
  await page.clock.fastForward(61_000)
  await expect.poll(() => reports.length).toBe(2)
  // 第二批不应重新携带失败的第一分钟。
  expect(reports[1].durationMs).toBeLessThan(65_000)
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(page.locator('.book-card').first()).toBeVisible()
  await open()
  await expect.poll(() => reports.filter(r => r.clientId === reports[0].clientId).length).toBeGreaterThanOrEqual(2)
  // 页面离开时服务端返回500，下一次打开仍应携带同一个clientId补报。
  await page.clock.fastForward(5_000)
  failures = 1
  const before = reports.length
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(page.locator('.book-card').first()).toBeVisible()
  await expect.poll(() => reports.length).toBeGreaterThan(before)
  const last = reports[reports.length - 1]
  await open()
  await expect.poll(() => reports.filter(r => r.clientId === last.clientId).length).toBeGreaterThanOrEqual(2)
  const unique = new Map(reports.map(r => [r.clientId, r.durationMs]))
  await expect.poll(async () => await total() - baseline).toBe([...unique.values()].reduce((a, b) => a + b, 0))
})
