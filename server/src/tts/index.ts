import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SERVER_ROOT } from '../db'
import { E } from '../errors'
import { ttsCacheKey } from './cacheKey'
import { localProvider, type VoiceInfo } from './providers'

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

async function probeLocal(): Promise<{ ok: boolean; voices: VoiceInfo[] }> {
  const now = Date.now()
  if (probe && now - probe.at < PROBE_TTL_MS) {
    return { ok: probe.ok, voices: probe.voices }
  }
  try {
    const voices = await localProvider.listVoices()
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
  const { ok, voices } = await probeLocal()
  return {
    default: localProvider.id,
    engines: [
      {
        engine: localProvider.id,
        label: localProvider.label,
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

  const contentType = FORMAT_MIME[format] ?? 'audio/mpeg'
  const key = ttsCacheKey(engine, voice, rate, text)
  const file = cachePath(key, format)

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
      result = await localProvider.synthesize(text, voice, rate, format)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/timeout|aborted/i.test(msg)) throw E.upstreamTimeout(engine)
      // 上游挂了要把探测缓存清掉，下次 /engines 才能如实报告
      probe = null
      throw E.upstreamTtsFailed(engine)
    }

    ensureCacheDir()
    writeFileSync(file, result.buffer)
    return { buffer: result.buffer, contentType: result.contentType, cache: 'miss' }
  } finally {
    release()
  }
}
