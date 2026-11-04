import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 每次构建生成一个新的构建号，写进 index.html：
 *
 *   <meta name="zhiyin-build" content="..." />
 *
 * 网页端在运行中请求一次最新的 index.html，比较这个 meta 就能知道
 * 服务器上是不是已经部署了新版本。构建号不能写死，否则重新部署后
 * 客户端永远认为自己是新的。
 */
const BUILD_ID = process.env.VITE_BUILD_ID || Date.now().toString(36)

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'zhiyin-build-id',
      transformIndexHtml(html) {
        return html.replace(
          '</head>',
          `    <meta name="zhiyin-build" content="${BUILD_ID}" />\n  </head>`,
        )
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // 服务端在 3000，前端开发时直接 /api 转发过去（R1 起生效）
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
})
