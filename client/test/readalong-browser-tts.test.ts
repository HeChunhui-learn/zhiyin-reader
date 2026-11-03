import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserTtsEngine } from '../src/features/readalong/engines/browserTts'

/**
 * 浏览器原生跟读的三条保命规则。
 *
 * 这三条对应读者真实反馈的两个毛病：
 *   · 「念一句就停，点继续跟读也只念一句」——接口把 end 事件吞了，promise 永远悬着
 *   · 「有时候突然变成浏览器默认的机器女声」——`getVoices()` 瞬时为空，
 *     选中的音色被静默丢掉，浏览器拿系统默认嗓音念中文
 *
 * 用例只替换 speechSynthesis 这层，引擎本身一行不改地跑。
 */

/** 假 utterance：测试里手动触发 start/end/error，模拟浏览器的各种脾气 */
class FakeUtterance {
  text: string
  lang = ''
  rate = 1
  voice: unknown = null
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((e: { error: string }) => void) | null = null

  constructor(text: string) {
    this.text = text
  }
}

interface FakeVoice {
  voiceURI: string
  name: string
  lang: string
}

function voice(uri: string, name: string, lang: string): FakeVoice {
  return { voiceURI: uri, name, lang }
}

const ZH = voice('Microsoft Huihui - Chinese (Simplified, PRC)', 'Microsoft Huihui', 'zh-CN')
const EN = voice('Microsoft David - English (United States)', 'Microsoft David', 'en-US')

interface FakeSynth {
  speaking: boolean
  pending: boolean
  paused: boolean
  voices: FakeVoice[]
  spoken: FakeUtterance[]
  cancel: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  speak: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
}

let fake: FakeSynth

function install(voices: FakeVoice[]): FakeSynth {
  const synth: FakeSynth = {
    speaking: false,
    pending: false,
    paused: false,
    voices,
    spoken: [],
    cancel: vi.fn(),
    resume: vi.fn(),
    speak: vi.fn((u: FakeUtterance) => {
      synth.spoken.push(u)
    }),
    addEventListener: vi.fn(),
  }

  Object.defineProperty(synth, 'getVoices', {
    value: vi.fn(() => synth.voices),
    writable: true,
  })

  globalThis.speechSynthesis = synth as unknown as SpeechSynthesis
  globalThis.SpeechSynthesisUtterance =
    FakeUtterance as unknown as typeof SpeechSynthesisUtterance
  return synth
}

/** 造一个已经"就绪"的引擎：读一次 voices 把嗓音灌进缓存 */
function readyEngine(voices: FakeVoice[]): BrowserTtsEngine {
  fake = install(voices)
  const engine = new BrowserTtsEngine()
  void engine.voices
  return engine
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { speechSynthesis?: unknown }).speechSynthesis
  delete (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
})

describe('浏览器原生引擎不会丢掉选中的音色', () => {
  it('getVoices 瞬时为空时，仍然把缓存的嗓音塞进 utterance', async () => {
    const engine = readyEngine([ZH, EN])
    // 模拟 cancel 之后列表瞬时空掉的那一刻
    fake.voices = []

    const p = engine.speak('你好。', { voice: ZH.voiceURI, rate: 1 }, new AbortController().signal)
    const u = fake.spoken[0]

    expect(fake.spoken).toHaveLength(1)
    expect(u.voice).toBe(ZH)
    u.onend?.()
    await expect(p).resolves.toBeUndefined()
  })

  it('选中的音色不在列表里时，退到一个中文嗓音而不是系统默认英文嗓音', async () => {
    const engine = readyEngine([ZH])

    const p = engine.speak('你好。', { voice: 'zf_xiaoxiao', rate: 1 }, new AbortController().signal)
    const u = fake.spoken[0]

    expect(u.voice).toBe(ZH)
    u.onend?.()
    await p
  })
})

describe('队列清理只在真的在说话时发生', () => {
  it('空闲时不调用 cancel', async () => {
    const engine = readyEngine([ZH])

    const p = engine.speak('你好。', { voice: ZH.voiceURI, rate: 1 }, new AbortController().signal)
    expect(fake.cancel).not.toHaveBeenCalled()

    fake.spoken[0].onend?.()
    await p
  })
})

describe('看门狗保证 promise 一定会 settle', () => {
  it('一直不开口时重排一次，再不行就跳过这句', async () => {
    vi.useFakeTimers()
    const engine = readyEngine([ZH])

    const p = engine.speak('你好。', { voice: ZH.voiceURI, rate: 1 }, new AbortController().signal)
    expect(fake.spoken).toHaveLength(1)

    // 第一次超时：重排
    vi.advanceTimersByTime(1700)
    expect(fake.spoken).toHaveLength(2)

    // 第二次超时：放弃这句，resolve 让上层推进
    vi.advanceTimersByTime(1700)
    await expect(p).resolves.toBeUndefined()
  })

  it('已经开口却收不到 end 时，主动收尾', async () => {
    vi.useFakeTimers()
    const engine = readyEngine([ZH])

    const p = engine.speak('你好。', { voice: ZH.voiceURI, rate: 1 }, new AbortController().signal)
    const u = fake.spoken[0]
    u.onstart?.()

    // 3 个字按保守语速估算不会超过 6 秒，这里给足余量
    vi.advanceTimersByTime(7000)
    await expect(p).resolves.toBeUndefined()
    expect(fake.cancel).toHaveBeenCalled()
  })
})

describe('外部打断不算失败', () => {
  it('interrupted 当这句念完了，交回上层继续下一句', async () => {
    const engine = readyEngine([ZH])

    const p = engine.speak('你好。', { voice: ZH.voiceURI, rate: 1 }, new AbortController().signal)
    fake.spoken[0].onerror?.({ error: 'interrupted' })
    await expect(p).resolves.toBeUndefined()
  })

  it('signal 打断仍然抛 AbortError', async () => {
    const engine = readyEngine([ZH])
    const ac = new AbortController()

    const p = engine.speak('你好。', { voice: ZH.voiceURI, rate: 1 }, ac.signal)
    ac.abort()

    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})
