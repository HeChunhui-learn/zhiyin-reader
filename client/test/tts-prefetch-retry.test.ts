import { expect, it, vi } from 'vitest'
import { ApiError, api } from '../src/api/client'
import { ServerTtsEngine } from '../src/features/readalong/engines/serverTts'

vi.mock('../src/api/client', async importOriginal => ({
  ...await importOriginal<typeof import('../src/api/client')>(),
  api: { synthesizeSpeech: vi.fn() },
}))
vi.mock('../src/features/readalong/audioCache', () => ({ audioCacheGet: async () => null, audioCachePut: async () => {} }))
vi.mock('../src/features/readalong/audioPlayer', () => ({ AudioPlayer: class { play = async () => {}; stop() {}; dispose() {} } }))

it('当前句加入预取后遇到可重试错误，会转入前台重试路径', async () => {
  let reject!: (error: Error) => void
  vi.mocked(api.synthesizeSpeech).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    .mockResolvedValue(new Blob(['audio']))
  const engine = new ServerTtsEngine('test', '测试', [], 'doc')
  const options = { voice: 'v', rate: 1 }
  engine.preload(['下一句'], options)
  await vi.waitFor(() => expect(api.synthesizeSpeech).toHaveBeenCalledTimes(1))
  const spoken = engine.speak('下一句', options, new AbortController().signal)
  reject(new ApiError('UPSTREAM_TTS_FAILED', '暂不可用', 502))
  await expect(spoken).resolves.toBeUndefined()
  expect(api.synthesizeSpeech).toHaveBeenCalledTimes(2)
})
