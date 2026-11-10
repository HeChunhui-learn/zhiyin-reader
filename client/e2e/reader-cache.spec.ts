import { test, expect } from '@playwright/test'

test('5000段正文首次和重复打开耗时记录', async ({ page, request }, testInfo) => {
  const account = `cache_perf_${Date.now()}@example.com`
  const password = 'test12345'
  await request.post('/api/auth/register', { data: { account, password } })
  const login = await request.post('/api/auth/login', { data: { account, password } })
  const headers = { Authorization: `Bearer ${(await login.json()).accessToken}` }
  const created = await request.post('/api/documents', { headers, data: {
    fileName: '缓存性能测试.txt', fileFormat: 'TXT', title: '缓存性能测试',
    paragraphs: Array.from({ length: 5000 }, (_, i) => ({ paraIndex: i, type: 'p', text: '这是一段用于测量首次与重复打开耗时的中文阅读正文。'.repeat(10), sentences: [] })),
  } })
  expect(created.status()).toBe(201)
  const docId = (await created.json()).docId
  let contentRequests = 0
  page.on('request', r => { if (r.url().includes(`/documents/${docId}/content`)) contentRequests++ })
  await page.goto('/login')
  await page.locator('input[placeholder="手机号／邮箱"]').fill(account)
  await page.locator('input[type="password"]').fill(password)
  await page.locator('form .btn-primary').click()
  await expect(page.locator('.book-card')).toBeVisible()
  // 先加载阅读器代码分包，避免把 Vite 首次编译时间当成正文读取时间。
  await page.goto('/read/cache_benchmark_missing')
  await expect(page.locator('.reader-page .error-text')).toBeVisible()
  await page.getByRole('button', { name: '回到书架' }).click()
  await expect(page.locator('.book-card')).toBeVisible()
  const results: { mode: string; visibleMs: number; contentRequests: number }[] = []
  for (const mode of ['首次', '内存缓存', '持久缓存']) {
    const start = performance.now()
    if (mode === '持久缓存') await page.reload()
    else await page.locator('.book-card').evaluate(element => (element as HTMLElement).click())
    await expect(page.locator('.reader-content .sent').first()).toBeVisible()
    results.push({ mode, visibleMs: Math.round(performance.now() - start), contentRequests })
    if (mode === '首次') await page.getByRole('button', { name: '返回', exact: true }).click()
  }
  expect(contentRequests).toBe(1)
  console.log('正文缓存性能：', JSON.stringify(results))
  await testInfo.attach('reader-cache-performance.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
})

test('正文重复打开和刷新复用缓存，账号切换和删除仍验证权限', async ({ page, request }) => {
  const account = `cache_${Date.now()}@example.com`
  const password = 'test12345'
  await request.post('/api/auth/register', { data: { account, password } })
  const login = await request.post('/api/auth/login', { data: { account, password } })
  const headers = { Authorization: `Bearer ${(await login.json()).accessToken}` }
  const created = await request.post('/api/documents', { headers, data: {
    fileName: '正文缓存.txt', fileFormat: 'TXT', title: '正文缓存回归',
    paragraphs: Array.from({ length: 300 }, (_, i) => ({ paraIndex: i, type: 'p', text: `第${i}段缓存正文。`, sentences: [] })),
  } })
  expect(created.status()).toBe(201)
  const docId = (await created.json()).docId
  let contentRequests = 0
  page.on('request', r => { if (r.url().includes(`/documents/${docId}/content`)) contentRequests++ })
  const signIn = async (name: string) => {
    await page.goto('/login')
    await page.locator('input[placeholder="手机号／邮箱"]').fill(name)
    await page.locator('input[type="password"]').fill(password)
    await page.locator('form .btn-primary').click()
    await expect(page.locator('.shelf-page')).toBeVisible()
  }
  await signIn(account)
  await page.locator('.book-card').click()
  await expect(page.locator('.reader-content .sent').first()).toBeVisible()
  expect(contentRequests).toBe(1)
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await page.locator('.book-card').click()
  await expect(page.locator('.reader-content .sent').first()).toBeVisible()
  expect(contentRequests).toBe(1)
  await expect.poll(() => page.evaluate(() => new Promise<number>(resolve => {
    const opening = indexedDB.open('zhiyin-cache')
    opening.onsuccess = () => {
      const db = opening.result
      const count = db.transaction('documents').objectStore('documents').count()
      count.onsuccess = () => { resolve(count.result); db.close() }
    }
  }))).toBe(1)
  await page.reload()
  await expect(page.locator('.reader-content .sent').first()).toBeVisible()
  expect(contentRequests).toBe(1)

  await page.getByRole('button', { name: '返回', exact: true }).click()
  await page.getByRole('button', { name: '退出', exact: true }).click()
  const other = `other_${Date.now()}@example.com`
  await request.post('/api/auth/register', { data: { account: other, password } })
  await signIn(other)
  await page.goto(`/read/${docId}`)
  await expect(page.locator('.reader-page .error-text')).toBeVisible()
  await expect(page.locator('.reader-content')).toHaveCount(0)
  expect(contentRequests).toBe(1)

  await page.getByRole('button', { name: '回到书架' }).click()
  await page.getByRole('button', { name: '退出', exact: true }).click()
  await signIn(account)
  expect((await request.delete(`/api/documents/${docId}`, { headers })).status()).toBe(204)
  await page.goto(`/read/${docId}`)
  await expect(page.locator('.reader-page .error-text')).toContainText('资源不存在')
  await expect(page.locator('.reader-content')).toHaveCount(0)
})
