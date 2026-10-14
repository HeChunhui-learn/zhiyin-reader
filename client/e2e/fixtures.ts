/**
 * 端到端测试的公共设施。
 *
 * 这些用例跑在**真实浏览器**里，补的是 docs/02 第 6.1 节列的最大缺口。
 * 与 `client/test/` 下的 Vitest 用例分工明确：
 *   · Vitest —— 纯函数、接口契约、边界值，快且密
 *   · 这里   —— 真实排版、CSS、滚动、点击、多标签页同步，慢但真
 */
import { expect, type Page } from '@playwright/test'

export const DEMO_ACCOUNT = 'demo@example.com'
export const DEMO_PASSWORD = 'demo12345'
/** seed 里灌的昵称（server/sql/seed.ts:141）—— 不是账号名，别拿账号去断言 */
export const DEMO_NICKNAME = '示例读者'

/** 演示书《人间词话》的 docId（sql/seed.ts 里写死的） */
export const DEMO_DOC_ID = 'doc_renjian'

/**
 * 收集页面控制台里的真实报错 —— 用它证明"没有白屏、没有静默报错"。
 *
 * 两类**预期内**的噪声要滤掉，否则每个用例都会挂在与业务无关的地方：
 *
 *  1. `favicon.ico` 的 404 —— index.html 没声明 favicon，浏览器自动去要一个。
 *  2. 401 的 "Failed to load resource" —— accessToken **只存在内存里**
 *     （CLAUDE.md「令牌存放」那一条），refreshToken 在 localStorage。
 *     所以每次硬导航（page.goto）进已登录页面时，第一批请求必然先吃 401，
 *     再由 SessionProvider 静默换新、重放原请求。这是**设计如此**，
 *     不是缺陷；内容随后正常渲染就是它工作了的证据。
 *
 * 真要断言"没有失败请求"，应当看 Playwright 的 network 事件而不是控制台文本 ——
 * 这里保留这个通道，但不把上面两类算进去。
 */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  const isNoise = (t: string) =>
    /favicon\.ico/.test(t) ||
    /Failed to load resource.*\b401\b/.test(t) ||
    /Failed to load resource.*\b404\b.*favicon/.test(t)
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isNoise(msg.text()) && !isNoise(msg.location().url)) {
      errors.push(msg.text())
    }
  })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  return errors
}

/**
 * 当前浏览器有没有**真正可用**的语音合成嗓音。
 *
 * 为什么需要它：无头 Linux 的 chromium 上没有 speech-dispatcher（CI 上就是这种），
 * `speechSynthesis` 这个对象**存在**、`BrowserTtsEngine.isSupported()` 也就报 true，
 * 所以"浏览器原生"会正常出现在引擎列表里；但 `getVoices()` 返回空数组，
 * 一旦 `speak()` 就以 `synthesis-failed` 失败 —— 跟读根本启动不了。
 * 这不是产品缺陷，是运行环境没有发声能力，只能据实跳过，不能拿替身凑一个假的绿。
 *
 * Chrome 的 `getVoices()` 首次调用常常是空的、要等 `voiceschanged`，
 * 所以这里轮询等一会儿（界面上 `whenBrowserVoicesReady` 也是同样的道理，最多等 800ms）。
 */
export async function hasBrowserVoices(page: Page, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const n = await page.evaluate(() => {
      const s = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis
      return s && typeof s.getVoices === 'function' ? s.getVoices().length : 0
    })
    if (n > 0) return true
    if (Date.now() >= deadline) return false
    await page.waitForTimeout(200)
  }
}

/** 登录表单的提交按钮（页面上有两个「登录」：切换标签 + 提交按钮，必须分清） */
export function loginSubmit(page: Page) {
  return page.locator('form.login-card .btn-primary.btn-block')
}

/** 用演示账号登录，停在书架上 */
export async function loginAsDemo(page: Page): Promise<void> {
  await page.goto('/login')
  await page.locator('.input[placeholder="手机号／邮箱"]').fill(DEMO_ACCOUNT)
  await page.locator('input[type="password"]').fill(DEMO_PASSWORD)
  await loginSubmit(page).click()
  await expect(page.locator('.shelf-page')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.shelf-user-name')).toContainText(DEMO_NICKNAME)
}

/** 从书架进入演示书的阅读界面 */
export async function openDemoBook(page: Page): Promise<void> {
  await page.goto(`/read/${DEMO_DOC_ID}`)
  await expect(page.locator('.reader-content')).toBeVisible({ timeout: 15_000 })
  // 正文必须先真的渲染出句子 —— 否则后面所有断言都没有意义
  await expect(page.locator('.sent').first()).toBeVisible()
}

/**
 * 注册一个全新账号并登录，返回账号。
 * 用于"两个读者互不干扰"这类用例，避免复用演示账号被上一轮的改动影响。
 */
export async function registerFresh(page: Page): Promise<string> {
  const account = `e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}@example.com`
  await page.goto('/login')
  await page.getByRole('button', { name: '注册', exact: true }).click()
  await page.locator('.input[placeholder="手机号／邮箱"]').fill(account)
  await page.locator('input[type="password"]').fill('e2e_password_123')
  await loginSubmit(page).click()
  await expect(page.locator('.shelf-page')).toBeVisible({ timeout: 15_000 })
  return account
}
