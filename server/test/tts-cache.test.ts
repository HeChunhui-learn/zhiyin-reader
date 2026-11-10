import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { auth, closeApp, makeApp, registerAndLogin, type Session } from './helpers'
import { localProvider } from '../src/tts/providers'

// 这里只测编排与缓存，固定延迟的上游用于统计调用次数，不代表真实语音性能。
vi.mock('../src/tts/providers', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tts/providers')>()
  return { ...actual, localProvider: {
    id: 'kokoro-local', label: '缓存测试引擎',
    listVoices: vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
      return [{ voice: 'test-voice', label: '测试音色', lang: 'zh-CN' }]
    }),
    synthesize: vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      return { buffer: Buffer.from('cache-test-audio'), contentType: 'audio/mpeg' }
    }),
  } }
})

let app: FastifyInstance
let session: Session
beforeAll(async () => { app = await makeApp(); session = await registerAndLogin(app) })
afterAll(async () => { vi.restoreAllMocks(); await closeApp(app) })

it('并发读取引擎与音色只探测一次上游', async () => {
  const responses = await Promise.all(['/api/tts/engines', '/api/tts/voices'].map(url => app.inject({ url, headers: auth(session) })))
  expect(responses.map(r => r.statusCode)).toEqual([200, 200])
  expect(localProvider.listVoices).toHaveBeenCalledTimes(1)
})

const payload = { engine: 'kokoro-local', voice: 'test-voice', text: '相同句子并发合成只执行一次。', rate: 1, format: 'mp3' }
const speak = (body = payload) => app.inject({ method: 'POST', url: '/api/tts/synthesize', headers: auth(session), payload: body })

it('同一句并发合成只调用一次上游，后续直接命中', async () => {
  const responses = await Promise.all([speak(), speak(), speak()])
  expect(responses.map(r => r.statusCode)).toEqual([200, 200, 200])
  expect(localProvider.synthesize).toHaveBeenCalledTimes(1)
  expect((await speak()).headers['x-cache']).toBe('hit')
})

it('已有音频命中无需探测上游，离线仍能取回', async () => {
  const realNow = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(realNow + 20_000)
  vi.mocked(localProvider.listVoices).mockRejectedValue(new Error('上游离线'))
  const calls = vi.mocked(localProvider.listVoices).mock.calls.length
  const response = await speak()
  expect(response.statusCode).toBe(200)
  expect(response.headers['x-cache']).toBe('hit')
  expect(localProvider.listVoices).toHaveBeenCalledTimes(calls)
})

it('合成失败不占据单飞槽位，格式不同不能混用文件', async () => {
  const { synthesize } = await import('../src/tts')
  const options = { ...payload, text: '失败后重试与音频格式隔离。' }
  vi.mocked(localProvider.synthesize).mockRejectedValueOnce(new Error('失败'))
  await expect(synthesize(options)).rejects.toMatchObject({ status: 502 })
  expect((await synthesize(options)).cache).toBe('miss')
  expect((await synthesize({ ...options, format: 'wav' })).contentType).toBe('audio/wav')
  expect((await synthesize(options)).cache).toBe('hit')
})
