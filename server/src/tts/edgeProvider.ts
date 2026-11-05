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

/**
 * 内置中文音色目录。
 *
 * Edge 的 `getVoices()` 与 `generate()` 是两个不同的上游接口：合成偶发空音频时，
 * 音色列表接口也可能被限流。但音色名是稳定的，不能因为一次列表探测失败就把整个
 * 引擎标成不可用 —— 那会让路由在真正合成前直接 502。这里用固定目录兜底，
 * 合成仍然照常尝试；真失败再由 `synthesize` 返回 502。
 */
const FALLBACK_VOICES: VoiceInfo[] = ZH_ORDER.map((voice) => ({
  voice,
  label: ZH_LABELS[voice] ?? voice,
  lang: voice.startsWith('zh-HK') ? 'zh-HK' : voice.startsWith('zh-TW') ? 'zh-TW' : 'zh-CN',
  gender: (ZH_LABELS[voice] ?? '').includes('女') ? ('female' as const) : ('male' as const),
  chinese: true,
}))

/**
 * Edge 免密钥接口会按 IP 限流：短时间连续合成几句就返回 429。
 *
 * 客户端跟读时会“当前句 + 预取 2 句”并发发出，正好撞上限流窗口。
 * 这里做两件事：
 *   1. 所有 Edge 请求串行，并保证两次请求的**开始时间**至少间隔 MIN_GAP_MS；
 *   2. 429 / 5xx / 网络抖动自动退避重试，最多 3 次。
 *
 * 串行会让首次朗读慢一点，但服务端有音频缓存、客户端也会预取；
 * 比起每几句断一次，慢一点是可接受的。
 */
const MIN_GAP_MS = Number(process.env.TTS_MIN_GAP_MS ?? 800)
const MAX_ATTEMPTS = 3

let chain: Promise<unknown> = Promise.resolve()
let lastStart = 0

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 串行闸门：前一个任务结束（无论成功失败）后，等够最小间隔再开始下一个。
 * 返回任务本身的结果/异常，不把异常吞进链里。
 */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastStart))
    if (wait > 0) await sleep(wait)
    lastStart = Date.now()
    return task()
  })
  // 链本身必须永远 resolve，否则一次失败会让后续所有请求都拒绝
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function isRetryable(message: string): boolean {
  // Edge 的某些失败（尤其是限流后的连接错误）message 是空串，也必须重试
  if (!message.trim()) return true
  return /429|too many|rate.?limit|timeout|aborted|ECONNRESET|ETIMEDOUT|socket|no audio|empty audio|5\d\d/i.test(
    message,
  )
}

export class EdgeTtsProvider implements TtsProvider {
  readonly id = 'edge-tts'
  readonly label = '云端语音（Edge）'

  async listVoices(): Promise<VoiceInfo[]> {
    try {
      // 与合成共用同一条串行链：getVoices 与 generate 并发时，
      // 共享实例偶尔会返回空音频。音色列表晚 450ms 不影响体验。
      const voices = await serialize(() => new EdgeTTS().getVoices())
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
    } catch (e) {
      console.warn(
        '[tts] Edge 音色列表获取失败，使用内置中文音色目录：',
        e instanceof Error ? e.message : e,
      )
      return FALLBACK_VOICES
    }
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

    let lastError: unknown

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        // 每次尝试用独立实例：EdgeTTS 在一次失败后内部连接可能已经坏了，
        // 继续复用单例会让后续每一句都失败。
        const result = await serialize(() =>
          new EdgeTTS().generate(text, voice, {
            rate: rateStr,
            outputFormat: Constants.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
            timeout: TIMEOUT_MS,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          }),
        )
        const audio = result.audio
        // 上游偶尔返回“成功但没有音频”，当成可重试错误，避免把空文件写进缓存
        if (!audio || audio.byteLength === 0) {
          throw new Error('Edge TTS returned no audio')
        }
        return { buffer: Buffer.from(audio), contentType: 'audio/mpeg' }
      } catch (e) {
        lastError = e
        const message = e instanceof Error ? e.message : String(e)
        if (!isRetryable(message) || attempt === MAX_ATTEMPTS - 1) throw e

        // 429 的限流窗口通常几秒内结束；1200ms → 2400ms，再带一点抖动
        const backoff = 1200 * 2 ** attempt + Math.floor(Math.random() * 400)
        console.warn(
          `[tts] Edge 合成失败（${message}），${backoff}ms 后重试 ${attempt + 1}/${MAX_ATTEMPTS - 1}`,
        )
        await sleep(backoff)
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
}

export const edgeProvider = new EdgeTtsProvider()
