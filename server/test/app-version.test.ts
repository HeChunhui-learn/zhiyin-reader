import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { closeApp, makeApp } from './helpers'
import {
  getAppVersionEnv,
  parseRelease,
  peekAppVersion,
  resetReleaseCache,
  resolveAppVersion,
} from '../src/routes/appVersion'

/**
 * 版本与更新（契约 §10 / docs/system-design.md §256、§383）。
 *
 * 两条线分别验证，互不依赖真实网络：
 *   · parseRelease —— 从 GitHub Release 的原始 JSON 里解析出版本三要素；
 *   · resolveAppVersion —— 注入假 fetch，验证"GitHub 优先、失败回落环境变量"。
 *
 * 不真的打 api.github.com：CI 上访问外网不稳定，用例一旦因此变红就没人信了。
 */

/** 造一个形状正确的 Release（字段名照抄 GitHub API） */
function releaseJson(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: 'v1.9.0',
    name: '知音漫卷 1.9.0',
    body: '更新内容...\n\n<!-- zhiyin:versionCode=10 -->\n',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'zhiyin.apk',
        browser_download_url:
          'https://github.com/HeChunhui-learn/zhiyin-reader/releases/download/v1.9.0/zhiyin.apk',
      },
    ],
    ...overrides,
  }
}

/** 假 fetch：返回给定 JSON，并记录被调用了几次 */
function fakeFetch(payload: unknown, status = 200) {
  const calls: string[] = []
  const fn = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url))
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

const ENV_KEYS = [
  'APP_VERSION_CODE',
  'APP_VERSION_NAME',
  'APP_APK_URL',
  'MIN_APP_VERSION_CODE',
  'APP_FORCE_UPDATE',
  'APP_UPDATE_NOTES',
  'APP_UPDATE_SOURCE',
  'APP_RELEASE_REPO',
  'GITHUB_TOKEN',
  'GH_TOKEN',
] as const

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  resetReleaseCache()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  resetReleaseCache()
})

describe('AA-01 ~ AA-04 解析 GitHub Release（契约 §10）', () => {
  it('AA-01 正常 Release 解析出版本三要素', () => {
    const r = parseRelease(releaseJson())
    expect(r).toEqual({
      versionCode: 10,
      versionName: '1.9.0',
      apkUrl:
        'https://github.com/HeChunhui-learn/zhiyin-reader/releases/download/v1.9.0/zhiyin.apk',
    })
  })

  it('AA-02 tag 前的 v 去掉，正文里没有 versionCode 就返回 null（不猜）', () => {
    expect(parseRelease(releaseJson({ tag_name: 'v1.9.0' }))?.versionName).toBe('1.9.0')
    expect(parseRelease(releaseJson({ body: '普通说明，没有机读标记' }))).toBeNull()
  })

  it('AA-03 没有 zhiyin.apk 时退而取第一个 .apk 附件', () => {
    const r = parseRelease(
      releaseJson({
        assets: [
          { name: 'notes.txt', browser_download_url: 'https://example.com/notes.txt' },
          { name: 'zhiyin-1.9.0.apk', browser_download_url: 'https://example.com/a.apk' },
        ],
      }),
    )
    expect(r?.apkUrl).toBe('https://example.com/a.apk')
  })

  it('AA-04 一个 APK 附件都没有时返回 null，不给出下不动的地址', () => {
    expect(parseRelease(releaseJson({ assets: [] }))).toBeNull()
    expect(parseRelease(releaseJson({ tag_name: '' }))).toBeNull()
  })
})

describe('AA-05 ~ AA-09 版本来源与兜底（契约 §10）', () => {
  it('AA-05 GitHub 可达时以 Release 为准', async () => {
    const { fn } = fakeFetch(releaseJson())
    const v = await resolveAppVersion({ fetchImpl: fn, repo: 'a/b' })
    expect(v.source).toBe('github')
    expect(v.versionCode).toBe(10)
    expect(v.versionName).toBe('1.9.0')
    expect(v.apkUrl).toContain('/releases/download/v1.9.0/zhiyin.apk')
  })

  it('★ AA-06 GitHub 查不到（404/限流）时回落环境变量，不抛异常', async () => {
    process.env.APP_VERSION_CODE = '9'
    process.env.APP_VERSION_NAME = '1.8.0'
    process.env.APP_APK_URL = '/download/zhiyin-1.8.0.apk'
    const { fn } = fakeFetch({ message: 'Not Found' }, 404)
    const v = await resolveAppVersion({ fetchImpl: fn, repo: 'a/b' })
    expect(v.source).toBe('env')
    expect(v.versionCode).toBe(9)
    expect(v.apkUrl).toBe('/download/zhiyin-1.8.0.apk')
  })

  it('★ AA-07 网络异常（超时/被墙）同样回落到环境变量', async () => {
    const fn = vi.fn(async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    const v = await resolveAppVersion({ fetchImpl: fn, repo: 'a/b' })
    expect(v.source).toBe('env')
  })

  it('AA-08 APP_UPDATE_SOURCE=env 时完全不联网（排障与离线演示用）', async () => {
    process.env.APP_UPDATE_SOURCE = 'env'
    const { fn, calls } = fakeFetch(releaseJson())
    const v = await resolveAppVersion({ fetchImpl: fn, repo: 'a/b' })
    expect(calls).toHaveLength(0)
    expect(v.source).toBe('env')
  })

  it('★ AA-09 没设 MIN_APP_VERSION_CODE 时默认不拦人（min=0）', () => {
    // 这是"能装就能用"的底线：没配置门槛就不该有门槛
    expect(getAppVersionEnv().minVersionCode).toBe(0)
    expect(peekAppVersion().minVersionCode).toBe(0)

    // 显式设了最新版号却没设最低版号时，沿用旧语义（min = 最新）
    process.env.APP_VERSION_CODE = '9'
    expect(getAppVersionEnv().minVersionCode).toBe(9)
  })

  it('AA-10 显式设了 MIN_APP_VERSION_CODE 时优先用它', async () => {
    process.env.MIN_APP_VERSION_CODE = '5'
    const { fn } = fakeFetch(releaseJson())
    const v = await resolveAppVersion({ fetchImpl: fn, repo: 'a/b' })
    expect(v.minVersionCode).toBe(5)
  })

  it('★ AA-15 MIN_APP_VERSION_CODE=0 能真的关掉门槛（包括 GitHub 有新版时）', async () => {
    // 文档一直写着"设成 0 可关闭此门槛"，维护时靠它放行所有人。
    // 若这条被改成"0 当作没配"，运维关门槛的动作就会静默失效。
    process.env.MIN_APP_VERSION_CODE = '0'
    process.env.APP_VERSION_CODE = '9'
    const { fn } = fakeFetch(releaseJson())
    const v = await resolveAppVersion({ fetchImpl: fn, repo: 'a/b' })
    expect(v.source).toBe('github')
    expect(v.minVersionCode).toBe(0)
    expect(getAppVersionEnv().minVersionCode).toBe(0)
  })
})

describe('AA-11 ~ AA-13 /api/app/version 接口（契约 §10）', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    process.env.APP_UPDATE_SOURCE = 'env' // 用例不打网络
    process.env.APP_VERSION_CODE = '9'
    process.env.APP_VERSION_NAME = '1.8.0'
    process.env.APP_APK_URL = '/download/zhiyin-1.8.0.apk'
    app = await makeApp()
  })

  afterEach(async () => {
    await closeApp(app)
  })

  it('AA-11 不带令牌也能查（旧版客户端要能拿到更新地址）', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/app/version' })
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.versionCode).toBe(9)
    expect(b.versionName).toBe('1.8.0')
    expect(b.apkUrl).toBe('/download/zhiyin-1.8.0.apk')
    expect(b.source).toBe('env')
  })

  it('AA-12 响应带 force 与 notes，客户端据此决定是否弹不可关闭的窗口', async () => {
    process.env.APP_FORCE_UPDATE = 'false'
    const r = await app.inject({ method: 'GET', url: '/api/app/version' })
    expect(r.json().force).toBe(false)
    expect(typeof r.json().notes).toBe('string')
  })

  it('★ AA-13 原生壳 Origin + 低于门槛的版本头 → 426 APP_UPDATE_REQUIRED', async () => {
    process.env.MIN_APP_VERSION_CODE = '9'
    const r = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: { origin: 'http://localhost', 'x-app-version-code': '8' },
    })
    expect(r.statusCode).toBe(426)
    expect(r.json().code).toBe('APP_UPDATE_REQUIRED')
    expect(r.json().details.minVersionCode).toBe(9)
  })

  it('★ AA-14 版本够新就放行；浏览器 Origin 不受这道门槛影响', async () => {
    process.env.MIN_APP_VERSION_CODE = '9'
    const ok = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost', 'x-app-version-code': '9' },
    })
    expect(ok.statusCode).toBe(200)

    const web = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: { origin: 'http://123.56.172.230' },
    })
    expect(web.statusCode).not.toBe(426)
  })
})
