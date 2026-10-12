import cors from '@fastify/cors'
import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { DB_PATH, initDb } from './db'
import { ApiError } from './errors'
import authRoutes from './routes/auth'
import documentRoutes from './routes/documents'
import resourceRoutes from './routes/resources'
import ttsRoutes from './routes/tts'
import progressRoutes from './routes/progress'
import bookmarkRoutes from './routes/bookmarks'
import readingTimeRoutes from './routes/readingTime'
import syncRoutes from './routes/sync'
import healthRoutes from './routes/health'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'

/**
 * 单次请求体的上限。默认 1MB 对导入文档来说完全不够。
 *
 * R7-4 从 20MB 提到 100MB：20MB 只够中等长度的 TXT，
 * 带插图的 EPUB 很容易就超（图片本体不随导入上传，但正文 JSON 与
 * 原始文件是两个大块）。真正的正文规模仍由 documents.ts 的
 * MAX_PARAGRAPHS 兜底 —— 段落数才是耗内存的那一头。
 */
const BODY_LIMIT = 100 * 1024 * 1024

async function main() {
  initDb()

  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT })

  await app.register(cors, { origin: true, exposedHeaders: ['X-Request-Id', 'ETag'] })

  // 契约 §1：响应头带 X-Request-Id，错误体里回显同值
  app.addHook('onRequest', async (req, reply) => {
    const id = `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    ;(req as unknown as { requestId: string }).requestId = id
    reply.header('X-Request-Id', id)
  })

  app.addHook('onResponse', async (req, reply) => {
    console.log(`${req.method} ${req.url} → ${reply.statusCode} (${reply.elapsedTime.toFixed(1)}ms)`)
  })

  // 统一错误信封：{ code, message, details, requestId }
  app.setErrorHandler((err, req, reply) => {
    const requestId = (req as unknown as { requestId?: string }).requestId ?? ''

    if (err instanceof ApiError) {
      return reply.code(err.status).send({
        code: err.code,
        message: err.message,
        details: err.details,
        requestId,
      })
    }

    // Fastify 自己的校验/解析错误
    const fastifyCode = (err as { code?: string }).code
    if (fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({
        code: 'PAYLOAD_TOO_LARGE',
        message: '上传内容超过大小限制。',
        details: {},
        requestId,
      })
    }

    console.error('[server error]', err)
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.code(status).send({
      code: status === 500 ? 'INTERNAL_ERROR' : (fastifyCode ?? 'ERROR'),
      message: status === 500 ? '服务端出错了，请稍后重试。' : err.message,
      details: {},
      requestId,
    })
  })

  app.setNotFoundHandler((req, reply) => {
    const requestId = (req as unknown as { requestId?: string }).requestId ?? ''
    reply.code(404).send({
      code: 'NOT_FOUND',
      message: `接口不存在：${req.method} ${req.url}`,
      details: {},
      requestId,
    })
  })

  // 二进制上传：图片与原始文件。这两个 parser 让 req.body 直接是 Buffer，
  // 不会被当成 JSON 解析（契约 §4.2 / §4.3 / §5）
  const binaryTypes = [
    'application/octet-stream',
    'image/png', 'image/jpeg', 'image/gif',
    'image/webp', 'image/bmp', 'image/svg+xml',
  ]
  app.addContentTypeParser(binaryTypes, { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  await app.register(healthRoutes)
  await app.register(authRoutes)
  await app.register(documentRoutes)
  await app.register(resourceRoutes)
  await app.register(ttsRoutes)
  await app.register(progressRoutes)
  await app.register(bookmarkRoutes)
  await app.register(readingTimeRoutes)
  await app.register(syncRoutes)

  await app.listen({ port: PORT, host: HOST })
  console.log(`知音漫卷服务端已启动  http://localhost:${PORT}`)
  console.log(`数据库：${DB_PATH}`)
}

main().catch((e) => {
  console.error('启动失败：', e)
  process.exit(1)
})
