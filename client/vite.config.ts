import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // 服务端在 3000，前端开发时直接 /api 转发过去（R1 起生效）
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
})
