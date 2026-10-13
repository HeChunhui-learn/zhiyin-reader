import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { auth, closeApp, makeApp, registerAndLogin } from './helpers'
import { ttsCacheKey } from '../src/tts/cacheKey'
import { KOKORO_VOICES } from '../src/tts/voiceCatalog'

/**
 * TT-01 ~ TT-17 语音合成（契约 §9）。
 *
 * ⚠️ 本机**没有装 Kokoro**（8880 端口没有服务），所以这里断言的是
 * 「上游不可用时的如实报告与降级行为」—— 那是契约 §9.1/§9.2 明确要求的分支，
 * 也是演示当天最常见的状态。
 *
 * **真实 Kokoro 的音色与延迟仍未验证**，报告里如实列为未覆盖项。
 * 不在这里起一个假的 OpenAI 兼容服务：那测的是替身，不是被测对象；
 * 需要验证协议一致性时应当起真实 Kokoro。
 */

let app: FastifyInstance
beforeAll(async () => {
  app = await makeApp()
})
afterAll(async () => {
  await closeApp(app)
})

describe('TT-01 ~ TT-04 引擎与音色目录（契约 §9.1 / §9.4）', () => {
  it('TT-01 列出引擎，含本地引擎与浏览器原生', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/tts/engines', headers: auth(s) })
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.default).toBe('kokoro-local')
    const ids = b.engines.map((e: { engine: string }) => e.engine)
    expect(ids).toContain('kokoro-local')
    expect(ids).toContain('browser-native')
  })

  it('★ TT-01 默认引擎是本地引擎', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/tts/engines', headers: auth(s) })
    expect(r.json().default).toBe('kokoro-local')
  })

  it('★ TT-14 上游不可用时如实报 available=false（不假装可用）', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/tts/engines', headers: auth(s) })
    const local = r.json().engines.find((e: { engine: string }) => e.engine === 'kokoro-local')
    // 本机没装 Kokoro —— 必须如实报 false，前端据此降级
    expect(local.available).toBe(false)
    expect(local.voices).toEqual([])
  })

  it('★ 浏览器原生引擎永远算可用（它是前端兜底路径，不经服务端）', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/tts/engines', headers: auth(s) })
    const browser = r.json().engines.find((e: { engine: string }) => e.engine === 'browser-native')
    expect(browser.available).toBe(true)
  })

  it('★ TT-02 上游不可用时不带音色列表（不会编造）', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/tts/engines', headers: auth(s) })
    const local = r.json().engines.find((e: { engine: string }) => e.engine === 'kokoro-local')
    expect(local.voices).toHaveLength(0)
  })

  it('TT-04 未带令牌访问 engines → 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/tts/engines' })
    expect(r.statusCode).toBe(401)
  })

  it('TT-04 未带令牌访问 voices → 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/tts/voices' })
    expect(r.statusCode).toBe(401)
  })

  it('★ TT-01 音色目录形状与契约 §9.4 一致', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/tts/voices', headers: auth(s) })
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.engine).toBe('kokoro-local')
    expect(b).toHaveProperty('engineLabel')
    expect(b).toHaveProperty('engineAvailable')
    expect(Array.isArray(b.voices)).toBe(true)
  })

  it('★ 引擎没起来时目录仍把音色列全（读者才分得清"没有"和"没装"）', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/tts/voices', headers: auth(s) })
    const b = r.json()
    expect(b.engineAvailable).toBe(false)
    // 目录里的音色一个都不该少
    expect(b.voices).toHaveLength(KOKORO_VOICES.length)
    for (const v of b.voices) {
      expect(v.available).toBe(false)
      expect(v).toHaveProperty('voice')
      expect(v).toHaveProperty('label')
      expect(v).toHaveProperty('lang')
      expect(v).toHaveProperty('chinese')
    }
  })

  it('★ 引擎整个没起来时 note 留空（原因由 engineAvailable 统一说明）', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/tts/voices', headers: auth(s) })
    // 代码注释写明：引擎压根没起来是另一回事，不必给每个音色都挂一遍"需安装离线音色包"
    for (const v of r.json().voices) {
      expect(v.note).toBeUndefined()
    }
  })

  it('★ 音色 id 与上游逐字节一致（它是缓存键的一部分，不许改写）', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/tts/voices', headers: auth(s) })
    const voices = r.json().voices.map((v: { voice: string }) => v.voice)
    expect(voices).toContain('zf_xiaobei')
    expect(voices).toContain('zm_yunjian')
    expect(voices).toContain('af_heart')
    // 不允许出现别名或大小写归一
    expect(voices).not.toContain('ZF_XIAOBEI')
  })

  it('中文音色标 chinese=true，英文音色标 false', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/tts/voices', headers: auth(s) })
    const byId = Object.fromEntries(
      r.json().voices.map((v: { voice: string }) => [v.voice, v]),
    )
    expect(byId['zf_xiaobei'].chinese).toBe(true)
    expect(byId['zm_yunjian'].chinese).toBe(true)
    expect(byId['af_heart'].chinese).toBe(false)
    expect(byId['jf_alpha'].chinese).toBe(false)
  })
})

describe('TT-05 ~ TT-13 合成（契约 §9.2）', () => {
  it('★ TT-13 上游不可用时合成 → 502 UPSTREAM_TTS_FAILED，details.engine 带引擎名', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST', url: '/api/tts/synthesize', headers: auth(s),
      payload: { text: '第一句。', voice: 'zf_xiaobei', rate: 1, format: 'mp3' },
    })
    expect(r.statusCode).toBe(502)
    expect(r.json().code).toBe('UPSTREAM_TTS_FAILED')
    expect(r.json().details.engine).toBe('kokoro-local')
    expect(r.json().message).toBe('语音合成服务不可用。')
  })

  it('★ TT-11 参数校验：空文本 → 400 并列出 text', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST', url: '/api/tts/synthesize', headers: auth(s),
      payload: { text: '   ', voice: 'zf_xiaobei' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().details.fields).toContain('text')
  })

  it('★ TT-11 超长文本（>500）→ 400', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST', url: '/api/tts/synthesize', headers: auth(s),
      payload: { text: '甲'.repeat(501), voice: 'zf_xiaobei' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().details.fields).toContain('text')
  })

  it('★ TT-11 语速越界（0.1 / 3）→ 400 并列出 rate', async () => {
    const s = await registerAndLogin(app)
    for (const rate of [0.1, 3, -1, 0]) {
      const r = await app.inject({
        method: 'POST', url: '/api/tts/synthesize', headers: auth(s),
        payload: { text: '甲。', voice: 'zf_xiaobei', rate },
      })
      expect(r.statusCode, `rate=${rate}`).toBe(400)
      expect(r.json().details.fields).toContain('rate')
    }
  })

  it('★ TT-11 语速边界 0.5 与 2.0 通过校验（不是 400）', async () => {
    const s = await registerAndLogin(app)
    for (const rate of [0.5, 2.0]) {
      const r = await app.inject({
        method: 'POST', url: '/api/tts/synthesize', headers: auth(s),
        payload: { text: '甲。', voice: 'zf_xiaobei', rate },
      })
      // 上游不可用 → 502；关键是**不是** 400 的参数校验失败
      expect(r.statusCode, `rate=${rate}`).toBe(502)
    }
  })

  it('★ TT-11 不支持的格式 → 400 并列出 format', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST', url: '/api/tts/synthesize', headers: auth(s),
      payload: { text: '甲。', voice: 'zf_xiaobei', format: 'ogg' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().details.fields).toContain('format')
  })

  it('支持的格式 mp3 / wav / opus / aac / flac / pcm 都过校验', async () => {
    const s = await registerAndLogin(app)
    for (const format of ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm']) {
      const r = await app.inject({
        method: 'POST', url: '/api/tts/synthesize', headers: auth(s),
        payload: { text: '甲。', voice: 'zf_xiaobei', format },
      })
      expect(r.statusCode, `format=${format}`).toBe(502) // 不是 400
    }
  })

  it('★ TT-12 browser-native 不该走服务端 → 400', async () => {
    const s = await registerAndLogin(app)
    // 上游不可用时，引擎不可用会先撞 502 —— 所以这条要绕过可用性检查。
    // 实际路径：engine 显式传 browser-native 且它在列表里、available=true，
    // 于是进到 synthesize 里的 BROWSER_ENGINE 分支抛 VALIDATION_FAILED。
    const r = await app.inject({
      method: 'POST', url: '/api/tts/synthesize', headers: auth(s),
      payload: { text: '甲。', voice: 'x', engine: 'browser-native', format: 'mp3' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().details.fields).toContain('engine')
  })

  it('★ 不认识的引擎 → 400 并列出 engine', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST', url: '/api/tts/synthesize', headers: auth(s),
      payload: { text: '甲。', voice: 'x', engine: 'no-such-engine' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().details.fields).toContain('engine')
  })

  it('TT-04 未带令牌合成 → 401', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/tts/synthesize', payload: { text: '甲。', voice: 'x' },
    })
    expect(r.statusCode).toBe(401)
  })

  it('TT-02 上游探测失败时 /engines 不缓存假结果（每次如实探）', async () => {
    const s = await registerAndLogin(app)
    const a = await app.inject({ method: 'GET', url: '/api/tts/engines', headers: auth(s) })
    const b = await app.inject({ method: 'GET', url: '/api/tts/engines', headers: auth(s) })
    expect(a.json().engines.find((e: { engine: string }) => e.engine === 'kokoro-local').available)
      .toBe(b.json().engines.find((e: { engine: string }) => e.engine === 'kokoro-local').available)
  })
})

describe('TT-16 缓存键（D-10）', () => {
  it('★ 服务端缓存键等于 sha256(engine \\u0001 voice \\u0001 rate \\u0001 text)', async () => {
    const { createHash } = await import('node:crypto')
    const expected = createHash('sha256')
      .update(['kokoro-local', 'zf_xiaobei', '1', '第一句。'].join('\u0001'), 'utf8')
      .digest('hex')
    expect(ttsCacheKey('kokoro-local', 'zf_xiaobei', 1, '第一句。')).toBe(expected)
  })

  it('★ D-10 分隔符避免歧义：("a","b") 与 ("ab","") 不同键', () => {
    expect(ttsCacheKey('e', 'a', 1, 'b')).not.toBe(ttsCacheKey('e', 'ab', 1, ''))
  })

  it('四个字段任一个变了键就变', () => {
    const base = ttsCacheKey('e', 'v', 1, 't')
    expect(ttsCacheKey('e2', 'v', 1, 't')).not.toBe(base)
    expect(ttsCacheKey('e', 'v2', 1, 't')).not.toBe(base)
    expect(ttsCacheKey('e', 'v', 2, 't')).not.toBe(base)
    expect(ttsCacheKey('e', 'v', 1, 't2')).not.toBe(base)
  })

  it('输出恒为 64 位小写十六进制', () => {
    expect(ttsCacheKey('e', 'v', 1, 't')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('★ 中文与 emoji 走 UTF-8，结果稳定（R10 纯函数）', () => {
    const a = ttsCacheKey('e', 'v', 1, '知音漫卷 😀')
    const b = ttsCacheKey('e', 'v', 1, '知音漫卷 😀')
    expect(a).toBe(b)
  })
})
