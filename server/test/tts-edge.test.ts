import { describe, expect, it } from 'vitest'
import { resolveEdgeFormat, withTimeout } from '../src/tts/edgeProvider'

/**
 * Edge 在线语音适配层的两个纯逻辑：
 *   · 格式映射：Edge 只产 MP3 / WebM-Opus，不能假装支持 wav；
 *   · 超时：音色列表接口没有 AbortSignal，必须自己兜一层，否则探测会永久挂起。
 */
describe('Edge TTS 适配（tts/edgeProvider）', () => {
  it('mp3 映射为 audio/mpeg', () => {
    expect(resolveEdgeFormat('mp3')).toMatchObject({ format: 'mp3', contentType: 'audio/mpeg' })
  })

  it('opus 映射为 audio/ogg', () => {
    expect(resolveEdgeFormat('opus')).toMatchObject({ format: 'opus', contentType: 'audio/ogg' })
  })

  it('不支持的格式返回 null，由上层回 400，而不是把 MP3 塞进 .wav', () => {
    expect(resolveEdgeFormat('wav')).toBeNull()
    expect(resolveEdgeFormat('aac')).toBeNull()
  })

  it('withTimeout 在超时后 reject', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, '语音服务超时')).rejects.toThrow('语音服务超时')
  })

  it('withTimeout 在正常完成时原样返回，且不留下定时器', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok')
  })
})
