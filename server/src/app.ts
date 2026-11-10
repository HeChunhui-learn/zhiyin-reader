import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { initDb } from './db'
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
import appVersionRoutes, { getAppVersionEnv } from './routes/appVersion'

/**
 * 单次请求体的上限。默认 1MB 对导入文档来说完全不够。
 *
 * R7-4 从 20MB 提到 100MB，本次再提到 500MB —— 演示要能吃下带整本插图的
 * 大部头 EPUB。注意这个值同时是**内存**上限：Fastify 会在进 handler 之前
 * 对 JSON 请求把整个 body 收进内存，二进制 PUT 使用流式写入，不占用等量的常驻内存。
 *
 * 这里只是"别让解析器抢在业务校验前面把请求打回"，真正兜底的是两处业务上限：
 *  · 正文 JSON 看 documents.ts 的 MAX_PARAGRAPHS —— 段落数才是耗内存的那一头
 *  · 原始文件看 routes/resources.ts 的 MAX_FILE_BYTES
 * 两者都必须 ≤ 这个值，否则业务侧的 413 永远轮不到发，读者拿到的是
 * Fastify 那条不带 details 的 413。三处要一起改（客户端另有一份
 * 预检常量 client/src/features/parse/index.ts，跨包无法共享，靠注释互相指认）。
 */
export const BODY_LIMIT = 500 * 1024 * 1024

export interface BuildAppOptions {
  /** 关掉每个请求一行的访问日志（测试里默认关，免得把断言输出冲掉） */
  logRequests?: boolean
  /** 建库。测试用内存库时由调用方先把 ZHIYIN_DB 指过去，这里照常建 */
  initDatabase?: boolean
}

/**
 * 组装 Fastify 实例，**不监听端口**。
 *
 * 单独抽出来的原因：自动化测试要拿 app.inject() 直接打路由，
 * 而 index.ts 一 import 就会 listen，测试进程会占住 3000 端口。
 * 这里只做组装，listen 留在 index.ts。
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const { logRequests = process.env.ZHIYIN_LOG_REQUESTS === '1', initDatabase = true } = opts

  if (initDatabase) initDb()

  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT, ajv: { customOptions: { coerceTypes: false } } })

  await app.register(cors, { origin: true, exposedHeaders: ['X-Request-Id', 'ETag'] })

  // 契约 §1：响应头带 X-Request-Id，错误体里回显同值
  app.addHook('onRequest', async (req, reply) => {
    const id = `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    ;(req as unknown as { requestId: string }).requestId = id
    reply.header('X-Request-Id', id)
  })

  /**
   * App 强制更新门槛。
   *
   * 只拦 Capacitor 壳里的请求（Origin 是 http://localhost / https://localhost）。
   * 浏览器访问的 Origin 是站点域名或 localhost:5173，不受影响 —— 网页版没有
   * "装哪个 APK" 的概念，不能把它一起挡掉。
   *
   * 旧版客户端（1.0.0 / 1.1.0）不发送 X-App-Version-Code，会在这里拿到 426。
   * 新客户端在 rawRequest 里统一带上该头。OPTIONS 必须放行，否则 CORS 预检
   * 都过不去。版本接口自身也放行，否则旧版连"该更新"都查不到。
   *
   * MIN_APP_VERSION_CODE 设成 0 可关闭此门槛（维护时用）。
   */
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return

    const origin = req.headers.origin
    if (origin !== 'http://localhost' && origin !== 'https://localhost') return

    const path = (req.url ?? '').split('?')[0]
    if (path === '/api/app/version' || path === '/api/health') return

    const { versionCode, versionName, apkUrl, minVersionCode } = getAppVersionEnv()
    if (!Number.isFinite(minVersionCode) || minVersionCode <= 0) return

    const raw = req.headers['x-app-version-code']
    const clientCode = Number(Array.isArray(raw) ? raw[0] : raw)
    if (Number.isFinite(clientCode) && clientCode >= minVersionCode) return

    const requestId = (req as unknown as { requestId?: string }).requestId ?? ''
    return reply.code(426).send({
      code: 'APP_UPDATE_REQUIRED',
      message: process.env.APP_UPDATE_MESSAGE ?? '当前版本过低，请更新客户端后继续使用。',
      details: { versionCode, versionName, minVersionCode, apkUrl },
      requestId,
    })
  })

  if (logRequests) {
    app.addHook('onResponse', async (req, reply) => {
      console.log(`${req.method} ${req.url} → ${reply.statusCode} (${reply.elapsedTime.toFixed(1)}ms)`)
    })
  }

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

    if (err.validation) {
      return reply.code(400).send({ code: 'VALIDATION_FAILED', message: '请求参数不合法，请检查后重试。', details: {}, requestId })
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

  // 二进制上传：图片与原始文件。这些 parser 保留输入流，由资源路由限量写入磁盘，
  // 不会被当成 JSON 解析（契约 §4.2 / §4.3 / §5）
  const binaryTypes = [
    'application/octet-stream',
    'image/png', 'image/jpeg', 'image/gif',
    'image/webp', 'image/bmp', 'image/svg+xml',
  ]
  app.addContentTypeParser(binaryTypes, (_req, body, done) => {
    done(null, body)
  })

  await app.register(healthRoutes)
  await app.register(appVersionRoutes)
  await app.register(authRoutes)
  await app.register(documentRoutes)
  await app.register(resourceRoutes)
  await app.register(ttsRoutes)
  await app.register(progressRoutes)
  await app.register(bookmarkRoutes)
  await app.register(readingTimeRoutes)
  await app.register(syncRoutes)

  return app
}
