import { Constants, EdgeTTS, type Voice } from '@andresaya/edge-tts'
import type { SynthResult, TtsProvider, VoiceInfo } from './providers'

/**
 * 微软 Edge 在线语音（免 API Key）。
 *
 * 部署在无 GPU 的 ECS 上时，本地 Kokoro 跑不起来；Edge 在线语音是免安装、
 * 中文音色质量稳定的替代。它仍然走服务端代理，客户端只认 /api/tts/*，
 * 与本地 Kokoro 那套完全同构。
 *
 * 启用：/etc/zhiyin/env 里设 TTS_PROVIDER=edge。不设则继续用本地 Kokoro，
 * 本机开发与既有测试不受影响。
 */
const TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? 20000)

/**
 * 给不接收 AbortSignal 的 Promise 套一层超时。
 *
 * Edge 的 `getVoices()` 没有 timeout / signal 参数：微软那边不响应时
 * 探测会一直挂着，连带把 /api/tts/engines 和所有合成请求都堵死。
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = '语音服务响应超时',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * Edge 实际能产出的格式。
 *
 * 适配层目前只映射 MP3 与 WebM-Opus；wav / aac / flac 等一律返回 null，
 * 由上层回 400。**绝不能**把 MP3 字节写进 `.wav` 缓存再按 audio/wav 返回 ——
 * 同一请求第一次与第二次的 Content-Type 会不一致。
 */
export interface EdgeFormat {
  format: 'mp3' | 'opus'
  contentType: string
  outputFormat: string
}

export function resolveEdgeFormat(format: string): EdgeFormat | null {
  if (format === 'mp3') {
    return {
      format: 'mp3',
      contentType: 'audio/mpeg',
      outputFormat: Constants.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
    }
  }
  if (format === 'opus') {
    return {
      format: 'opus',
      contentType: 'audio/ogg',
      outputFormat: Constants.OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS,
    }
  }
  return null
}

/** Edge 的 LocalName 是英文拼写，界面上换成中文名 */
const ZH_LABELS: Record<string, string> = {
  'zh-CN-XiaoxiaoNeural': '晓晓（女·温柔）',
  'zh-CN-XiaoyiNeural': '晓伊（女·活泼）',
  'zh-CN-YunjianNeural': '云健（男·浑厚）',
  'zh-CN-YunxiNeural': '云希（男·活泼）',
  'zh-CN-YunxiaNeural': '云夏（男·少年）',
  'zh-CN-YunyangNeural': '云扬（男·专业）',
  'zh-CN-liaoning-XiaobeiNeural': '晓北（女·东北）',
  'zh-CN-shaanxi-XiaoniNeural': '晓妮（女·陕西）',
  'zh-HK-HiuGaaiNeural': '曉佳（女·粤语）',
  'zh-HK-HiuMaanNeural': '曉曼（女·粤语）',
  'zh-HK-WanLungNeural': '雲龍（男·粤语）',
  'zh-TW-HsiaoChenNeural': '曉臻（女·台湾）',
  'zh-TW-HsiaoYuNeural': '曉雨（女·台湾）',
  'zh-TW-YunJheNeural': '雲哲（男·台湾）',
}

function labelOf(v: Voice): string {
  return ZH_LABELS[v.ShortName] ?? v.LocalName ?? v.DisplayName ?? v.FriendlyName ?? v.ShortName
}

/**
 * 排序，普通话优先。
 *
 * Edge 原始顺序是 zh-HK → zh-CN → zh-TW；若不排序，客户端在旧音色失效时
 * 会退回"列表第一个"，也就是粤语音色 —— 用粤语读普通话正文会明显走音。
 * 把晓晓（普通话、温柔）放第一，替换引擎后的默认音色才正确。
 */
const ZH_ORDER = [
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-XiaoyiNeural',
  'zh-CN-YunjianNeural',
  'zh-CN-YunxiNeural',
  'zh-CN-YunxiaNeural',
  'zh-CN-YunyangNeural',
  'zh-CN-liaoning-XiaobeiNeural',
  'zh-CN-shaanxi-XiaoniNeural',
  'zh-TW-HsiaoChenNeural',
  'zh-TW-HsiaoYuNeural',
  'zh-TW-YunJheNeural',
  'zh-HK-HiuGaaiNeural',
  'zh-HK-HiuMaanNeural',
  'zh-HK-WanLungNeural',
]

function rank(v: Voice): number {
  const i = ZH_ORDER.indexOf(v.ShortName)
  return i >= 0 ? i : ZH_ORDER.length
}

const tts = new EdgeTTS()

export class EdgeTtsProvider implements TtsProvider {
  readonly id = 'edge-tts'
  readonly label = '云端语音（Edge）'

  async listVoices(): Promise<VoiceInfo[]> {
    // getVoices 没有 signal/timeout 参数，必须自己兜一层
    const voices = await withTimeout(tts.getVoices(), TIMEOUT_MS, 'Edge 音色列表超时')
    return voices
      .filter((v) => (v.Locale ?? '').toLowerCase().startsWith('zh'))
      .sort((a, b) => rank(a) - rank(b))
      .map((v) => ({
        voice: v.ShortName,
        label: labelOf(v),
        lang: v.Locale,
        gender: v.Gender === 'Male' ? ('male' as const) : ('female' as const),
        chinese: true,
      }))
  }

  /** 只声明实际支持的格式；上层据此决定缓存扩展名与 Content-Type */
  resolveFormat(format: string): { format: string; contentType: string } | null {
    const f = resolveEdgeFormat(format)
    return f ? { format: f.format, contentType: f.contentType } : null
  }

  async synthesize(
    text: string,
    voice: string,
    rate: number,
    format: string,
  ): Promise<SynthResult> {
    const f = resolveEdgeFormat(format)
    if (!f) throw new Error(`Edge 不支持音频格式 ${format}`)

    // 接口的 rate 是倍率（0.5–2.0），Edge 的 rate 是相对百分比（-50% ~ +100%）
    const pct = Math.round((rate - 1) * 100)
    const rateStr = `${pct >= 0 ? '+' : ''}${pct}%`

    // generate 自身有 signal 与 timeout，这里再套一层 Promise 超时：
    // 万一底层实现忽略了 signal，也不会把请求挂死。
    const result = await withTimeout(
      tts.generate(text, voice, {
        rate: rateStr,
        outputFormat: f.outputFormat,
        timeout: TIMEOUT_MS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      TIMEOUT_MS,
      'Edge 语音合成超时',
    )

    return { buffer: Buffer.from(result.audio), contentType: f.contentType }
  }
}

export const edgeProvider = new EdgeTtsProvider()
