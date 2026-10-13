import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 服务端用例全部走 app.inject()，不需要浏览器环境
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 每个用例文件用独立的临时库（见 test/setup.ts），
    // 但要串行跑：better-sqlite3 的文件句柄与 WAL 在并发下会互相绊
    fileParallelism: false,
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
})
