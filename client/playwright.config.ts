import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright 端到端配置。
 *
 * 这里补的是 docs/02 第 6.1 节明列的**最大缺口**：浏览器真机测试。
 * 前面的 Vitest 用例全部在 Node 里跑（jsdom 都不用），
 * 覆盖不到真实排版、CSS 渲染、滚动流畅度 —— 那几项只有真浏览器能验。
 *
 * 两个服务都由 Playwright 自己拉起来，跑完自动关：
 *   · 服务端 3000 —— 用**独立的测试库**（ZHIYIN_DB 指到 e2e 专用文件），
 *     不会污染演示库 server/data/zhiyin.db
 *   · 前端 5173 —— Vite dev server，通过 /api 代理到 3000
 */
const SERVER_PORT = 3000
const WEB_PORT = 5173

export default defineConfig({
  testDir: './e2e',
  // 用例之间有共享的服务端状态（导入的书、书签），串行跑最稳
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'e2e-report', open: 'never' }],
    ['json', { outputFile: 'e2e-report/results.json' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    // 只做桌面浏览器：CLAUDE.md 明确"第一版只做桌面浏览器，窗口宽度 ≥ 1280px"
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        /**
         * 用**本机已装的 Chrome**（channel: 'chrome'），不下 Playwright 自带的 chromium。
         *
         * 原因：本机 npm 走 127.0.0.1:7897 代理，`npx playwright install chromium`
         * 反复在 90% 处报 `ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC` / `Download failure`。
         * 本机 Chrome 是真实浏览器，对"浏览器真机测试"这个目的完全够用 ——
         * 反正是要验真实排版与滚动，不是验 Playwright 的打包产物。
         * 换一台机器若没装 Chrome，改成 `channel: 'msedge'`，或先跑通 install。
         */
        channel: 'chrome',
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: [
    {
      command: 'npm run e2e:server',
      cwd: '../server',
      url: `http://127.0.0.1:${SERVER_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      /**
       * 显式 `--host 127.0.0.1`。
       *
       * `npm run dev` 用的是 vite 默认绑定（localhost），而 Playwright 的
       * webServer 探活打的是 127.0.0.1 —— 实测会一直等到超时。
       * 不改 vite.config.ts 的 server.host：那个文件是给人和局域网平板用的，
       * 这里只是测试启动方式不同，不该反过来改产品配置。
       */
      command: `npx vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
