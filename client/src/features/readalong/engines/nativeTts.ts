import { TextToSpeech } from '@capacitor-community/text-to-speech'
import { isNativeApp } from '../../../api/platform'
import { abortError, type SpeakOptions, type TtsEngine, type VoiceOption } from './types'

/**
 * 设备原生 TTS（Android 壳的降级路径）。
 *
 * Android WebView **不实现 Web Speech API**：`window.speechSynthesis` 在
 * Capacitor 壳里是 undefined，原来的浏览器降级因此必然报
 * 「当前浏览器不支持语音合成」。这里改走 Android 系统自带的 TextToSpeech，
 * 通过 @capacitor-community/text-to-speech 调用。
 *
 * 与浏览器原生一样，它只保证句子级高亮（realAudio=false）；Android 的
 * onRangeStart 虽然能拿到词边界，但不参与游标推进 —— 游标仍以整句念完
 * （plugin 的 speak Promise 在 onDone 时 resolve）为准。
 */

export const NATIVE_ENGINE_ID = 'native-tts'

let cachedVoices: VoiceOption[] = []
/** voiceURI → getSupportedVoices() 里的下标；plugin 的 voice 参数要的是下标 */
const voiceIndex = new Map<string, number>()
let loadTask: Promise<VoiceOption[]> | null = null

/**
 * 读取系统里可用的中文音色。
 *
 * 没有中文音色就返回空 —— 正文是中文，拿英文音色念只会更难听。
 * 失败一律静默，调用方退回其他引擎。
 */
export function loadNativeVoices(): Promise<VoiceOption[]> {
  if (!isNativeApp()) return Promise.resolve([])
  if (loadTask) return loadTask

  loadTask = (async () => {
    try {
      const { voices } = await TextToSpeech.getSupportedVoices()
      const zh = voices
        .map((v, index) => ({ v, index }))
        .filter(({ v }) => v.lang?.toLowerCase().startsWith('zh'))
      if (zh.length === 0) {
        // 系统 TTS 可能还没初始化完，下次进阅读页再试一次
        loadTask = null
        return []
      }

      cachedVoices = zh.map(({ v }) => ({
        voice: v.voiceURI,
        label: v.name,
        lang: v.lang,
        chinese: true,
        available: true,
      }))
      for (const { v, index } of zh) voiceIndex.set(v.voiceURI, index)
      return cachedVoices
    } catch {
      // 插件未就绪 / 系统没有 TTS 引擎：清掉缓存，下次重试
      loadTask = null
      return []
    }
  })()

  return loadTask
}

export class NativeTtsEngine implements TtsEngine {
  readonly id = NATIVE_ENGINE_ID
  readonly label = '设备原生（降级）'
  readonly realAudio = false
  readonly voices: VoiceOption[]

  constructor(voices: VoiceOption[] = cachedVoices) {
    this.voices = voices
  }

  isSupported(): boolean {
    return isNativeApp() && this.voices.length > 0
  }

  speak(text: string, opts: SpeakOptions, signal: AbortSignal): Promise<void> {
    if (!isNativeApp() || this.voices.length === 0) {
      return Promise.reject(new Error('当前设备不支持系统语音合成，请改用云端语音。'))
    }

    const voice = this.voices.find((v) => v.voice === opts.voice) ?? this.voices[0]
    const index = voiceIndex.get(voice.voice)

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        fn()
      }

      function onAbort() {
        void TextToSpeech.stop().catch(() => {})
        finish(() => reject(abortError()))
      }

      signal.addEventListener('abort', onAbort, { once: true })

      TextToSpeech.speak({
        text,
        lang: voice.lang || 'zh-CN',
        rate: clampRate(opts.rate),
        pitch: 1,
        volume: 1,
        ...(index === undefined ? {} : { voice: index }),
      })
        .then(() => finish(resolve))
        .catch((e: unknown) => {
          if (signal.aborted) return finish(() => reject(abortError()))
          const message = e instanceof Error ? e.message : '设备原生 TTS 不可用'
          finish(() => reject(new Error(`语音合成失败：${message}`)))
        })
    })
  }

  preload(): void {
    // 系统 TTS 即时合成，没有可预取的音频
  }

  stop(): void {
    if (isNativeApp()) void TextToSpeech.stop().catch(() => {})
  }
}

function clampRate(rate: number): number {
  // Android TextToSpeech 的 setSpeechRate 以 1.0 为常速，过高会被系统截断
  if (!Number.isFinite(rate)) return 1
  return Math.min(3, Math.max(0.1, rate))
}
