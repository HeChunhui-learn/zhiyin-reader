import type { FastifyInstance } from 'fastify'
import { requireUserId } from '../auth/require'
import { ApiError, E } from '../errors'
import { listEngines, synthesize } from '../tts'

/**
 * 契约 §9：TTS 代理。
 * 前端不直接调用第三方服务，一律经这里转发（CLAUDE.md 的硬约束 C7）。
 */

/** 单句文本上限。04 §4.1.4 的 R8 会在 200 字处兜底切分，500 已经足够宽松 */
const MAX_TEXT = 500
const MIN_RATE = 0.5
const MAX_RATE = 2.0

const FORMATS = new Set(['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'])

interface SynthBody {
  text?: string
  voice?: string
  rate?: number
  format?: string
  engine?: string
}

export default async function ttsRoutes(app: FastifyInstance) {
  app.get('/api/tts/engines', async (req) => {
    requireUserId(req)
    return listEngines()
  })

  app.post<{ Body: SynthBody }>('/api/tts/synthesize', async (req, reply) => {
    requireUserId(req)

    const { text, voice, rate = 1, format = 'mp3', engine } = req.body ?? {}

    const fields: string[] = []
    let message = '参数不合法。'

    if (typeof text !== 'string' || !text.trim()) {
      fields.push('text')
      message = '缺少要合成的文本。'
    } else if (text.length > MAX_TEXT) {
      fields.push('text')
      message = `单句文本不得超过 ${MAX_TEXT} 个字符。`
    }

    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
      fields.push('rate')
      message = `语速需在 ${MIN_RATE}–${MAX_RATE} 之间。`
    }

    if (typeof format !== 'string' || !FORMATS.has(format)) {
      fields.push('format')
      message = '不支持的音频格式。'
    }

    if (fields.length) throw new ApiError(400, 'VALIDATION_FAILED', message, { fields })

    // 引擎不传就用服务端认定的默认引擎
    const engines = await listEngines()
    const engineId = engine ?? engines.default
    const info = engines.engines.find((e) => e.engine === engineId)

    if (!info) {
      throw new ApiError(400, 'VALIDATION_FAILED', `不认识的语音引擎：${engineId}`, {
        fields: ['engine'],
      })
    }
    if (!info.available) {
      // 契约 §9.2：上游不可用返回 502，前端据此降级到浏览器原生
      throw E.upstreamTtsFailed(engineId)
    }

    // 音色：上游报了清单就校验，没报（探测失败过）就不拦
    if (info.voices.length > 0) {
      if (typeof voice !== 'string' || !info.voices.some((v) => v.voice === voice)) {
        throw new ApiError(400, 'VALIDATION_FAILED', `该引擎没有这个音色：${voice ?? ''}`, {
          fields: ['voice'],
        })
      }
    } else if (typeof voice !== 'string' || !voice.trim()) {
      throw new ApiError(400, 'VALIDATION_FAILED', '缺少音色参数。', { fields: ['voice'] })
    }

    const out = await synthesize({
      text: text as string,
      voice: voice as string,
      rate,
      format,
      engine: engineId,
    })

    reply
      .header('Content-Type', out.contentType)
      .header('X-Cache', out.cache)
      .header('Cache-Control', 'private, max-age=604800')
    return reply.send(out.buffer)
  })
}
