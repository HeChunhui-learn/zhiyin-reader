import { ApiError, api, type TtsVoice } from '../../../api/client'
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
 * docs/system-design.md §6.3：控制器始终预先合成后续句子（缓冲不少于 2 句），减少句间停顿。
 * 预取放在这里，对上层透明。
 */

/** 预加载的句子数（docs/system-design.md §6.3 要求"不少于 2 句"） */
const PRELOAD_AHEAD = 2

/** 单句合成失败时的重试次数（不含首次） */
const SPEAK_RETRIES = 2

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 429 / 5xx / 网络断开都值得重试；401、404、422 之类重试也没用 */
function isRetryable(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    (e.status === 0 || e.status === 429 || e.status >= 500)
  )
}

export class ServerTtsEngine implements TtsEngine {
  readonly realAudio = true
  readonly id: string
  readonly label: string
  readonly voices: VoiceOption[]

  private player = new AudioPlayer()
  /** 正在预取中的 cacheKey，避免同一个键重复发请求 */
  private inflight = new Map<string, Promise<Blob | null>>()
  private prefetched = new WeakSet<Promise<Blob | null>>()

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
      return existing.catch(error => {
        if (!this.prefetched.has(existing) || !isRetryable(error)) throw error
        // 预取没有重试预算；现在真正播到这一句，应转入前台的有界重试。
        if (this.inflight.get(key) === existing) this.inflight.delete(key)
        return this.ensureBlob(text, opts)
      }).then((b) => {
        if (b) return b
        throw new Error('音频获取失败')
      })
    }

    const task = (async (): Promise<Blob | null> => {
      const cached = await audioCacheGet(key)
      if (cached) return cached

      const blob = await this.fetchSpeech(text, opts)
      await audioCachePut(this.docId, key, blob)
      return blob
    })()

    this.inflight.set(key, task)
    // finally 会另外产生一个拒绝 Promise，不能将它丢弃造成未处理异常。
    const clear = () => { if (this.inflight.get(key) === task) this.inflight.delete(key) }
    void task.then(clear, clear)
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
        const blob = await this.fetchSpeech(t, opts, 0)
        await audioCachePut(this.docId, key, blob)
        return blob
      })()
      this.prefetched.add(task)
      this.inflight.set(key, task)
      void task.catch(() => null).finally(() => { if (this.inflight.get(key) === task) this.inflight.delete(key) })
    }
  }

  /**
   * 单句合成，带退避重试。
   *
   * 服务端已经对 Edge 429 做了串行和重试，但客户端仍可能撞上服务端重启、
   * 短暂 502 或网络抖动；这里再兜一层，避免一句失败就停掉整段跟读。
   * 预取不重试（`retries=0`），失败就等真正播到这句时再按主路径重试。
   */
  private async fetchSpeech(
    text: string,
    opts: SpeakOptions,
    retries = SPEAK_RETRIES,
  ): Promise<Blob> {
    let last: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await api.synthesizeSpeech({
          text,
          voice: opts.voice,
          rate: opts.rate,
          engine: this.id,
        })
      } catch (e) {
        last = e
        if (!isRetryable(e) || attempt === retries) throw e
        await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 200))
      }
    }
    throw last instanceof Error ? last : new Error('音频获取失败')
  }

  stop(): void {
    this.player.stop()
  }

  dispose(): void {
    this.player.dispose()
    this.inflight.clear()
  }
}
