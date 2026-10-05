import { api, type TtsVoice } from '../../../api/client'
import { AudioPlayer } from '../audioPlayer'
import { audioCacheGet, audioCachePut } from '../audioCache'
import { ttsCacheKey } from '../ttsCacheKey'
import { abortError, type SpeakOptions, type TtsEngine, type VoiceOption } from './types'

/**
 * 服务端合成引擎（默认路径）。
 *
 * 契约 §9.2：前端不直接调用第三方服务，一律经服务端代理；音频按
 * sha256(engine + voice + rate + text) 缓存，**客户端命中时连请求都不发**。
 *
 * 04 §4.1.4：控制器始终预先合成后续句子（缓冲不少于 2 句），减少句间停顿。
 * 预取放在这里，对上层透明。
 */

/** 预加载的句子数（04 §4.1.4 要求"不少于 2 句"） */
const PRELOAD_AHEAD = 2

export class ServerTtsEngine implements TtsEngine {
  readonly realAudio = true
  readonly id: string
  readonly label: string
  readonly voices: VoiceOption[]

  private player = new AudioPlayer()
  /** 正在预取中的 cacheKey，避免同一个键重复发请求 */
  private inflight = new Map<string, Promise<Blob | null>>()

  constructor(
    id: string,
    label: string,
    voices: TtsVoice[],
    private docId: string,
  ) {
    this.id = id
    this.label = label
    this.voices = voices.map((v) => ({ voice: v.voice, label: v.label, lang: v.lang }))
  }

  async speak(text: string, opts: SpeakOptions, signal: AbortSignal): Promise<void> {
    const blob = await this.ensureBlob(text, opts)
    if (signal.aborted) throw abortError()
    return this.player.play(blob, signal)
  }

  /** 取音频：本地缓存 → 服务端 → 写缓存 */
  private ensureBlob(text: string, opts: SpeakOptions): Promise<Blob> {
    const key = ttsCacheKey(this.id, opts.voice, opts.rate, text)

    const existing = this.inflight.get(key)
    if (existing) {
      return existing.then((b) => {
        if (b) return b
        throw new Error('音频获取失败')
      })
    }

    const task = (async (): Promise<Blob | null> => {
      const cached = await audioCacheGet(key)
      if (cached) return cached

      const blob = await api.synthesizeSpeech({
        text,
        voice: opts.voice,
        rate: opts.rate,
        engine: this.id,
      })
      await audioCachePut(this.docId, key, blob)
      return blob
    })()

    this.inflight.set(key, task)
    void task.finally(() => this.inflight.delete(key))
    return task.then((b) => {
      if (b) return b
      throw new Error('音频获取失败')
    })
  }

  /**
   * 预取后续句子。失败静默——预取只是优化，真正播到时还会再要一次，
   * 那一次的失败才会作为错误冒到界面上。
   */
  preload(texts: string[], opts: SpeakOptions): void {
    for (const t of texts.slice(0, PRELOAD_AHEAD)) {
      if (!t.trim()) continue
      const key = ttsCacheKey(this.id, opts.voice, opts.rate, t)
      if (this.inflight.has(key)) continue
      const task = (async (): Promise<Blob | null> => {
        const cached = await audioCacheGet(key)
        if (cached) return cached
        const blob = await api.synthesizeSpeech({
          text: t,
          voice: opts.voice,
          rate: opts.rate,
          engine: this.id,
        })
        await audioCachePut(this.docId, key, blob)
        return blob
      })()
      this.inflight.set(key, task)
      void task.catch(() => null).finally(() => this.inflight.delete(key))
    }
  }

  stop(): void {
    this.player.stop()
  }

  dispose(): void {
    this.player.dispose()
    this.inflight.clear()
  }
}
