import { abortError, type SpeakOptions, type TtsEngine, type VoiceOption } from './types'

/**
 * 浏览器原生语音合成（降级路径）。
 *
 * 契约 §9.2：服务端合成失败时前端降级到这里，**不经过服务端**，直接调 Web Speech API。
 * 03 §1.3.1 明确它只能做句子级高亮（原生接口不返回字级时间戳），
 * 所以 realAudio = false，界面上要说明这一点。
 *
 * 各平台的中文音色差别很大，这里只做"能挑一个中文声音"的兜底，
 * 不做音色质量的保证 —— 音色质量由服务端引擎负责。
 */

function synth(): SpeechSynthesis | null {
  return typeof speechSynthesis !== 'undefined' ? speechSynthesis : null
}

function listZhVoices(): VoiceOption[] {
  const s = synth()
  if (!s) return []
  return s
    .getVoices()
    .filter((v) => v.lang?.toLowerCase().startsWith('zh'))
    .map((v) => ({ voice: v.voiceURI, label: v.name, lang: v.lang }))
}

export class BrowserTtsEngine implements TtsEngine {
  readonly id = 'browser-native'
  readonly label = '浏览器原生（降级）'
  readonly realAudio = false

  private cachedVoices: VoiceOption[] = []
  private voicesBound = false

  get voices(): VoiceOption[] {
    const loaded = listZhVoices()
    if (loaded.length > 0) this.cachedVoices = loaded
    else if (!this.voicesBound) {
      // getVoices 首次调用经常返回空，等 voiceschanged 再取一次
      this.voicesBound = true
      const s = synth()
      if (s) {
        s.addEventListener('voiceschanged', () => {
          this.cachedVoices = listZhVoices()
        })
      }
    }
    return this.cachedVoices
  }

  isSupported(): boolean {
    return synth() !== null
  }

  speak(text: string, opts: SpeakOptions, signal: AbortSignal): Promise<void> {
    const s = synth()
    if (!s) return Promise.reject(new Error('当前浏览器不支持语音合成'))

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (fn: () => void) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        fn()
      }

      const u = new SpeechSynthesisUtterance(text)
      u.rate = clampRate(opts.rate)
      u.lang = 'zh-CN'

      const picked =
        this.voices.find((v) => v.voice === opts.voice) ??
        this.voices[0] ??
        null
      if (picked) {
        const real = s.getVoices().find((v) => v.voiceURI === picked.voice)
        if (real) u.voice = real
      }

      u.onend = () => done(resolve)
      // 用户点了停止会触发 interrupted/canceled，这两种不算失败
      u.onerror = (e) => {
        const r = String((e as SpeechSynthesisErrorEvent).error ?? '')
        if (r === 'interrupted' || r === 'canceled') done(() => reject(abortError()))
        else done(() => reject(new Error(`语音合成失败：${r || '未知原因'}`)))
      }

      function onAbort() {
        s!.cancel()
        done(() => reject(abortError()))
      }
      signal.addEventListener('abort', onAbort)

      // 有些浏览器在 cancel 之后立刻 speak 会静默失败，先清一次队列
      s.cancel()
      s.speak(u)
    })
  }

  preload(): void {
    // 浏览器原生引擎没有可预取的音频，它本身就是即时的
  }

  stop(): void {
    synth()?.cancel()
  }
}

function clampRate(rate: number): number {
  // SpeechSynthesis 的 rate 合法区间是 0.1–10，超出会被忽略
  if (!Number.isFinite(rate)) return 1
  return Math.min(10, Math.max(0.1, rate))
}
