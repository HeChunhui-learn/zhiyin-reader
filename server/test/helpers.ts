import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app'
import { closeDb } from '../src/db'

/**
 * 测试用的公共设施：起应用、注册登录拿令牌、发请求。
 *
 * 全部走 `app.inject()`，不监听端口 —— 测试跑起来的时候
 * 开发用的 3000 端口可能正被 `npm run server` 占着。
 */

/** 契约 §1：演示账号 */
export const DEMO_ACCOUNT = 'demo@example.com'
export const DEMO_PASSWORD = 'demo12345'

export async function makeApp(): Promise<FastifyInstance> {
  process.env.ZHIYIN_LOG_REQUESTS = '0'
  const app = await buildApp({ logRequests: false })
  await app.ready()
  return app
}

export async function closeApp(app: FastifyInstance): Promise<void> {
  await app.close()
  closeDb()
}

export interface Session {
  userId: string
  account: string
  accessToken: string
  refreshToken: string
}

/** 注册一个新账号并登录，返回令牌对。账号随机化，用例之间不会撞车 */
export async function registerAndLogin(
  app: FastifyInstance,
  overrides: { account?: string; password?: string; nickname?: string; deviceId?: string } = {},
): Promise<Session> {
  const account = overrides.account ?? `t_${Math.random().toString(36).slice(2, 10)}@example.com`
  const password = overrides.password ?? 'test12345'

  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { account, password, nickname: overrides.nickname ?? '测试读者' },
  })
  if (reg.statusCode !== 201) {
    throw new Error(`注册失败 ${reg.statusCode}：${reg.body}`)
  }
  const userId = reg.json().userId as string

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { account, password, deviceId: overrides.deviceId ?? 'dev_test' },
  })
  if (login.statusCode !== 200) {
    throw new Error(`登录失败 ${login.statusCode}：${login.body}`)
  }
  const body = login.json()
  return {
    userId,
    account,
    accessToken: body.accessToken as string,
    refreshToken: body.refreshToken as string,
  }
}

/** 带 Bearer 令牌发请求的简写 */
export function auth(session: Session): Record<string, string> {
  return { authorization: `Bearer ${session.accessToken}` }
}

/** 造一篇最小的可导入文档（走契约 §4.1 的请求体形状） */
export function importBody(opts: {
  fileName?: string
  fileFormat?: string
  contentHash?: string
  title?: string
  paragraphs: { paraIndex?: number; type?: string; text: string }[]
  imageRefs?: { imageId: string; paraIndex: number; src: string; alt?: string }[]
}) {
  return {
    fileName: opts.fileName ?? '测试书.txt',
    fileFormat: opts.fileFormat ?? 'TXT',
    fileSize: 1024,
    contentHash: opts.contentHash ?? `sha256:${Math.random().toString(36).slice(2)}`,
    title: opts.title ?? '测试书',
    author: '测试作者',
    paragraphs: opts.paragraphs.map((p, i) => ({
      paraIndex: p.paraIndex ?? i,
      type: p.type ?? 'p',
      text: p.text,
      sentences: [],
    })),
    imageRefs: opts.imageRefs ?? [],
  }
}
