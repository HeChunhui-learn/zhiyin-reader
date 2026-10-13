import { describe, expect, it } from 'vitest'
import { ttsCacheKey as clientKey } from '../src/features/readalong/ttsCacheKey'
import { ttsCacheKey as serverKey } from '../../server/src/tts/cacheKey'
import { createHash } from 'node:crypto'

/**
 * TT-16 / D-10：TTS 缓存键客户端与服务端**必须逐字节一致**。
 *
 * 两边各有一份实现（client/src/features/readalong/ttsCacheKey.ts 与
 * server/src/tts/cacheKey.ts），AGENTS.md 明写"改一边必须改另一边"。
 * 不一致的后果是**静默**的：客户端永远命中不了服务端缓存，每句都重新合成，
 * 界面上只是"变慢了"，不会有任何报错。这份用例就是那条约定可执行的守卫。
 *
 * D-10 还记着契约本身的缺陷：直接拼接的话 ("a","b") 与 ("ab","") 同键，
 * 所以两边都加了 \u0001 分隔符。
 */
describe('TT-16 TTS 缓存键：客户端与服务端必须一致（D-10）', () => {
  const samples: [string, string, number, string][] = [
    ['kokoro-local', 'zf_xiaobei', 1, '第一句。'],
    ['kokoro-local', 'zf_xiaobei', 1, '第二句。'],
    ['kokoro-local', 'zm_yunjian', 1, '同一句话。'],
    ['kokoro-local', 'zf_xiaobei', 1.5, '同一句话。'],
    ['kokoro-local', 'zf_xiaobei', 0.5, '同一句话。'],
    ['kokoro-local', 'af_heart', 1, 'Hello world.'],
    ['kokoro-local', 'jf_alpha', 2, 'こんにちは。'],
    ['other-engine', 'zf_xiaobei', 1, '第一句。'],
    ['kokoro-local', '', 1, ''],
    ['kokoro-local', 'v', 1, ''],
    ['kokoro-local', '', 1, 'v'],
    ['kokoro-local', 'a', 1, 'b'],
    ['kokoro-local', 'ab', 1, ''],
  ]

  it.each(samples)('两边算出同一个键：%j', (engine, voice, rate, text) => {
    expect(clientKey(engine, voice, rate, text)).toBe(serverKey(engine, voice, rate, text))
  })

  it('两边的实现都等于 sha256(engine \\u0001 voice \\u0001 rate \\u0001 text)', () => {
    const engine = 'kokoro-local'
    const voice = 'zf_xiaobei'
    const rate = 1.25
    const text = '契约 §9.2 规定的形状。'
    const expected = createHash('sha256')
      .update([engine, voice, String(rate), text].join('\u0001'), 'utf8')
      .digest('hex')

    expect(clientKey(engine, voice, rate, text)).toBe(expected)
    expect(serverKey(engine, voice, rate, text)).toBe(expected)
  })

  it('★ D-10 的分隔符确实在起作用：("a","b") 与 ("ab","") 不同键', () => {
    expect(clientKey('e', 'a', 1, 'b')).not.toBe(clientKey('e', 'ab', 1, ''))
    expect(serverKey('e', 'a', 1, 'b')).not.toBe(serverKey('e', 'ab', 1, ''))
  })

  it('四个字段任一个变了，键就变', () => {
    const base = clientKey('e', 'v', 1, 't')
    expect(clientKey('e2', 'v', 1, 't')).not.toBe(base)
    expect(clientKey('e', 'v2', 1, 't')).not.toBe(base)
    expect(clientKey('e', 'v', 2, 't')).not.toBe(base)
    expect(clientKey('e', 'v', 1, 't2')).not.toBe(base)
  })

  it('语速 1 与 1.0 算同一个键（String(1) === String(1.0)）', () => {
    expect(clientKey('e', 'v', 1, 't')).toBe(clientKey('e', 'v', 1.0, 't'))
  })

  it('输出是 64 位小写十六进制', () => {
    expect(clientKey('e', 'v', 1, 't')).toMatch(/^[0-9a-f]{64}$/)
    expect(serverKey('e', 'v', 1, 't')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('中文与 emoji 走 UTF-8 编码，两边一致', () => {
    const t = '知音漫卷 😀 阅读'
    expect(clientKey('e', 'v', 1, t)).toBe(serverKey('e', 'v', 1, t))
  })
})
