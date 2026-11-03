/**
 * 语音合成上游。
 *
 * 默认是本地自托管的 Kokoro-FastAPI —— 它对外提供 **OpenAI 兼容**接口，
 * 所以这个 provider 实际上是"任何 OpenAI 兼容的 /v1/audio/speech"的通用实现：
 * 换成国内云服务商或 OpenAI 官方，只要改环境变量即可（见 docs/system-design.md §6.7 的引擎选择）。
 *
 * 环境变量：
 *   TTS_BASE_URL  默认 http://127.0.0.1:8880/v1
 *   TTS_API_KEY   可空；本地服务一般不需要
 *   TTS_MODEL     默认 kokoro
 *   TTS_TIMEOUT_MS 默认 20000
 */

export interface VoiceInfo {
  voice: string
  label: string
  lang: string
  /** Edge 这类在线引擎能直接报性别；Kokoro 的性别来自静态目录 */
  gender?: 'female' | 'male'
  chinese?: boolean
}

export interface SynthResult {
  buffer: Buffer
  contentType: string
}

export interface TtsProvider {
  readonly id: string
  readonly label: string
  listVoices(): Promise<VoiceInfo[]>
  synthesize(text: string, voice: string, rate: number, format: string): Promise<SynthResult>
}

const BASE = (process.env.TTS_BASE_URL ?? 'http://127.0.0.1:8880/v1').replace(/\/+$/, '')
const API_KEY = process.env.TTS_API_KEY ?? ''
const MODEL = process.env.TTS_MODEL ?? 'kokoro'
const TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? 20000)

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    ...extra,
  }
}

/** 由音色 id 猜语言：Kokoro 的命名里首字母是语言（z=中文, a=美英, b=英英, j=日文） */
function langOf(voiceId: string): string {
  const c = voiceId[0]?.toLowerCase()
  if (c === 'z') return 'zh'
  if (c === 'j') return 'ja'
  if (c === 'a' || c === 'b') return 'en'
  return ''
}

/**
 * 把上游返回的音色列表整理成统一形状。
 * 上游可能返回字符串数组，也可能返回对象数组，两种都认。
 */
function normalizeVoices(raw: unknown): VoiceInfo[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { voices?: unknown })?.voices)
      ? (raw as { voices: unknown[] }).voices
      : []

  return list
    .map((item) => {
      if (typeof item === 'string') {
        return { voice: item, label: item, lang: langOf(item) }
      }
      const o = item as { id?: string; name?: string; voice?: string; language?: string; lang?: string }
      const id = o.id ?? o.voice ?? o.name ?? ''
      if (!id) return null
      return {
        voice: id,
        label: o.name ?? o.id ?? id,
        lang: o.language ?? o.lang ?? langOf(id),
      }
    })
    .filter((v): v is VoiceInfo => v !== null)
}

class OpenAiCompatProvider implements TtsProvider {
  readonly id: string
  readonly label: string

  constructor(id: string, label: string) {
    this.id = id
    this.label = label
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const res = await fetch(`${BASE}/audio/voices`, {
      headers: headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`上游返回 ${res.status}`)
    return normalizeVoices(await res.json())
  }

  async synthesize(
    text: string,
    voice: string,
    rate: number,
    format: string,
  ): Promise<SynthResult> {
    const res = await fetch(`${BASE}/audio/speech`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: MODEL,
        input: text,
        voice,
        response_format: format,
        speed: rate,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`上游返回 ${res.status}${detail ? `：${detail.slice(0, 120)}` : ''}`)
    }

    const buffer = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get('content-type') ?? 'audio/mpeg'
    return { buffer, contentType }
  }
}

/** 本项目目前只有这一个上游；浏览器原生那条路不走服务端 */
export const localProvider: TtsProvider = new OpenAiCompatProvider(
  'kokoro-local',
  '本地引擎',
)

export const providerBase = BASE
