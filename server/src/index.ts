import { buildApp } from './app'
import { DB_PATH } from './db'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'

/**
 * 服务端入口：只负责监听端口。
 *
 * 路由组装搬到 app.ts 的 buildApp() 了 —— 自动化测试要拿 app.inject()
 * 直接打路由，不能一 import 就 listen（会占住 3000 端口）。
 */
async function main() {
  const app = await buildApp({ logRequests: true })

  await app.listen({ port: PORT, host: HOST })
  console.log(`知音漫卷服务端已启动  http://localhost:${PORT}`)
  console.log(`数据库：${DB_PATH}`)
}

main().catch((e) => {
  console.error('启动失败：', e)
  process.exit(1)
})
