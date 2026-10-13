import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 纯函数用例不需要 DOM。需要浏览器 API 的（IndexedDB、IntersectionObserver）
    // 交给 Playwright 端到端那一层，不在这里用替身硬凑 —— 替身跑通了
    // 也不代表真机跑得通，反而会给出虚假的绿。
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/features/**/*.ts', 'src/features/**/*.tsx'],
    },
  },
})
