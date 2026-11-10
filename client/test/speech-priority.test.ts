import { expect, it } from 'vitest'
import { speakWithPreload } from '../src/features/readalong/speakWithPreload'
import type { TtsEngine } from '../src/features/readalong/engines/types'

it('当前句先启动，再预取后续句子，且等真实播放完成才返回', async () => {
  const calls: string[] = []
  let finish!: () => void
  const engine = {
    speak: () => { calls.push('当前句'); return new Promise<void>(resolve => { finish = resolve }) },
    preload: () => { calls.push('预取') },
  } as unknown as TtsEngine
  let done = false
  const task = speakWithPreload(engine, '正文', ['下一句'], { voice: 'v', rate: 1 }, new AbortController().signal).then(() => { done = true })
  expect(calls).toEqual(['当前句', '预取'])
  expect(done).toBe(false)
  finish()
  await task
  expect(done).toBe(true)
})
