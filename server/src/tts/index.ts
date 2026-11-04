import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SERVER_ROOT } from '../db'
import { E } from '../errors'
import { ttsCacheKey } from './cacheKey'
import { edgeProvider } from './edgeProvider'
import { localProvider, type TtsProvider, type VoiceInfo } from './providers'
import { KOKORO_VOICES, MISSING_VOICE_NOTE } from './voiceCatalog'

/**
 * 语音合成的编排：可用性探测、缓存、并发保护。
 *
 * 契约 §9：
 *   · GET /api/tts/engines 列出引擎与音色，available=false 的不给前端用
 *   · POST /api/tts/synthesize 返回音频二进制，带 X-Cache: hit|miss
 *   · 上游挂了返回 502 UPSTREAM_TTS_FAILED，超时 504，排队超限 429
 */

const CACHE_DIR = join(SERVER_ROOT, 'data', 'tts')

/** 同时进行的合成请求上限；超出的排队，队列也满了就 429 */
const MAX_CONCURRENT = 2
const MAX_QUEUE = 8

/** 可用性探测的缓存时长：不必每个请求都去敲上游 */
const PROBE_TTL_MS = 10_000

const BROWSER_ENGINE = 'browser-native'

/**
 * 当前使用的上游。
 *
 * 默认仍是本地 Kokoro（本机开发、既有测试与离线部署都靠它）；
 * 在 ECS 这种没有 GPU / 没装 Kokoro 的环境里，设 TTS_PROVIDER=edge
 * 切到微软 Edge 在线语音，客户端不用换包。
 */
const provider: TtsProvider = process.env.TTS_PROVIDER === 'edge' ? edgeProvider : localProvider

const FORMAT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pcm: 'audio/L16',
}

/* ------------------------------------------------------------ 可用性探测 */

let probe: { at: number; ok: boolean; voices: VoiceInfo[] } | null = null

async function probeProvider(): Promise<{ ok: boolean; voices: VoiceInfo[] }> {
  const now = Date.now()
  if (probe && now - probe.at < PROBE_TTL_MS) {
    return { ok: probe.ok, voices: probe.voices }
  }
  try {
    const voices = await provider.listVoices()
    probe = { at: now, ok: true, voices }
    return { ok: true, voices }
  } catch {
    // 本地推理服务没起来 —— 这是最常见的情况，不必打日志刷屏
    probe = { at: now, ok: false, voices: [] }
    return { ok: false, voices: [] }
  }
}

export interface EngineInfo {
  engine: string
  label: string
  available: boolean
  voices: VoiceInfo[]
}

export async function listEngines(): Promise<{
  default: string
  engines: EngineInfo[]
}> {
  const { ok, voices } = await probeProvider()
  return {
    default: provider.id,
    engines: [
      {
        engine: provider.id,
        label: provider.label,
        available: ok,
        voices: ok ? voices : [],
      },
      {
        // 浏览器原生不经过服务端，永远算"可用"——它是前端的兜底路径
        engine: BROWSER_ENGINE,
        label: '浏览器原生（降级）',
        available: true,
        voices: [],
      },
    ],
  }
}

/* ------------------------------------------------------------ 音色目录 */

export interface VoiceCatalogItem {
  voice: string
  label: string
  lang: string
  gender?: 'female' | 'male'
  /** 是否中文音色。非中文的读中文会走音，界面上要提示 */
  chinese: boolean
  /** 本机装了没有 */
  available: boolean
  /** 没装时给读者看的原因 */
  note?: string
}

/**
 * 音色目录：把本机**已装**的音色与目录里**存在但没装**的音色一起报给前端，
 * 前者可选，后者置灰并说明原因（见 voiceCatalog.ts 顶部的注释）。
 *
 * 契约 §9.1 规定 available=false 的**引擎**不得进前端列表 —— 那是引擎层面的规矩。
 * 音色层面不一样：引擎通着、只是缺某个语言包时，把缺的列出来才是如实报告。
 * 引擎整个没起来时 engineAvailable=false，由前端决定怎么呈现（当前是提示去装离线包）。
 */
export async function listVoices(): Promise<{
  engine: string
  engineLabel: string
  engineAvailable: boolean
  voices: VoiceCatalogItem[]
}> {
  const { ok, voices } = await probeProvider()

  // Edge 的音色是在线目录，不存在"离线包没装"这回事：
  // 引擎通着就把在线音色全列出来；引擎不通就返回空目录，由 engineAvailable 说明。
  if (provider.id === edgeProvider.id) {
    return {
      engine: provider.id,
      engineLabel: provider.label,
      engineAvailable: ok,
      voices: ok
        ? voices.map((v) => ({
            voice: v.voice,
            label: v.label,
            lang: v.lang,
            gender: v.gender,
            chinese: v.chinese ?? v.lang.toLowerCase().startsWith('zh'),
            available: true,
          }))
        : [],
    }
  }

  const live = new Set(voices.map((v) => v.voice))

  const items: VoiceCatalogItem[] = KOKORO_VOICES.map((v) => {
    const installed = ok && live.has(v.voice)
    return {
      voice: v.voice,
      label: v.label,
      lang: v.lang,
      gender: v.gender,
      chinese: v.chinese,
      available: installed,
      // 引擎通着却没有这个音色 = 包没装；引擎压根没起来是另一回事，
      // 那种情况由 engineAvailable 统一说明，不必给每个音色都挂一遍
      note: installed || !ok ? undefined : MISSING_VOICE_NOTE,
    }
  })

  // 上游报了、目录里没有的（换了模型包之类）：原样补进来，别把它们藏掉
  const known = new Set(KOKORO_VOICES.map((v) => v.voice))
  for (const v of voices) {
    if (known.has(v.voice)) continue
    items.push({
      voice: v.voice,
      label: v.label,
      lang: v.lang,
      chinese: v.lang.toLowerCase().startsWith('zh'),
      available: true,
    })
  }

  return {
    engine: provider.id,
    engineLabel: provider.label,
    engineAvailable: ok,
    voices: items,
  }
}

/* -------------------------------------------------------------- 并发控制 */

let running = 0
const waiting: (() => void)[] = []

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++
    return
  }
  if (waiting.length >= MAX_QUEUE) throw E.rateLimited()
  await new Promise<void>((resolve) => waiting.push(resolve))
}

function release(): void {
  const next = waiting.shift()
  if (next) next() // 名额直接转交给队首，running 不变
  else running--
}

/* ------------------------------------------------------------------ 缓存 */

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
}

function cachePath(key: string, format: string): string {
  return join(CACHE_DIR, `${key}.${format}`)
}

/* ---------------------------------------------------------------- 合成 */

export interface SynthOutput {
  buffer: Buffer
  contentType: string
  cache: 'hit' | 'miss'
}

export async function synthesize(opts: {
  text: string
  voice: string
  rate: number
  format: string
  engine: string
}): Promise<SynthOutput> {
  const { text, voice, rate, format, engine } = opts

  if (engine === BROWSER_ENGINE) {
    // 浏览器原生那条路由前端直接调 Web Speech API，不该走到服务端
    throw E.validation(['engine'])
  }

  /*
   * 引擎可能只支持有限格式（Edge 只有 mp3 / opus）。
   * 在碰缓存之前先问引擎要"实际格式"，缓存扩展名与 Content-Type 都以它为准；
   * 不支持的格式直接 400，不能把 MP3 字节写进 .wav 再按 audio/wav 返回。
   */
  const resolved = provider.resolveFormat
    ? provider.resolveFormat(format)
    : { format, contentType: FORMAT_MIME[format] ?? 'audio/mpeg' }
  if (!resolved) throw E.validation(['format'])

  const effectiveFormat = resolved.format
  const contentType = resolved.contentType
  const key = ttsCacheKey(engine, voice, rate, text)
  const file = cachePath(key, effectiveFormat)

  if (existsSync(file)) {
    return { buffer: readFileSync(file), contentType, cache: 'hit' }
  }

  await acquire()
  try {
    // 排队期间可能已经被别的请求合成好了，再查一次
    if (existsSync(file)) {
      return { buffer: readFileSync(file), contentType, cache: 'hit' }
    }

    let result
    try {
      result = await provider.synthesize(text, voice, rate, effectiveFormat)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/timeout|aborted/i.test(msg)) throw E.upstreamTimeout(engine)
      // 上游挂了要把探测缓存清掉，下次 /engines 才能如实报告
      probe = null
      throw E.upstreamTtsFailed(engine)
    }

    ensureCacheDir()
    writeFileSync(file, result.buffer)
    // 用 resolved 的 contentType，而不是 provider 返回的：缓存命中与未命中必须一致
    return { buffer: result.buffer, contentType, cache: 'miss' }
  } finally {
    release()
  }
}
