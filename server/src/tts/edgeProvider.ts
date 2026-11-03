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
    const voices = await tts.getVoices()
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

  async synthesize(
    text: string,
    voice: string,
    rate: number,
    _format: string,
  ): Promise<SynthResult> {
    // 接口的 rate 是倍率（0.5–2.0），Edge 的 rate 是相对百分比（-50% ~ +100%）
    const pct = Math.round((rate - 1) * 100)
    const rateStr = `${pct >= 0 ? '+' : ''}${pct}%`

    const result = await tts.generate(text, voice, {
      rate: rateStr,
      outputFormat: Constants.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
      timeout: TIMEOUT_MS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    return { buffer: Buffer.from(result.audio), contentType: 'audio/mpeg' }
  }
}

export const edgeProvider = new EdgeTtsProvider()
