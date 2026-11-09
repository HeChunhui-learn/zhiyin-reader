// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listTtsEngines = vi.fn()
const listTtsVoices = vi.fn()

vi.mock('../src/api/client', () => ({
  api: {
    listTtsEngines: (...args: unknown[]) => listTtsEngines(...args),
    listTtsVoices: (...args: unknown[]) => listTtsVoices(...args),
  },
}))

import { loadEngines } from '../src/features/readalong/engines'

/**
 * 引擎列表的降级顺序。
 *
 * 平板上的核心故障：Android WebView 没有 speechSynthesis，旧代码却把
 * 「浏览器原生（降级）」标成 available，默认选中后一说话就报
 * 「当前浏览器不支持语音合成」。这里守住两条：
 *   1. 没有 Web Speech 时，不把浏览器原生放进可选引擎；
 *   2. 服务端不可达且没有浏览器原生时，仍返回一条带 id 的不可用项，
 *      让界面能给出明确提示而不是崩在 options[0]。
 */

function browserVoices() {
  return {
    getVoices: () => [{ voiceURI: 'zh-test', name: 'Test Chinese', lang: 'zh-CN' }],
    addEventListener: () => {},
    cancel: () => {},
    resume: () => {},
    speak: () => {},
    speaking: false,
    pending: false,
    paused: false,
  }
}

function installSpeechSynthesis() {
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: browserVoices(),
  })
}

function removeSpeechSynthesis() {
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: undefined,
  })
}

const enginesResponse = {
  default: 'edge-tts',
  engines: [
    {
      engine: 'edge-tts',
      label: '云端语音（Edge）',
      available: true,
      voices: [{ voice: 'zh-CN-XiaoxiaoNeural', label: '晓晓', lang: 'zh-CN' }],
    },
    { engine: 'browser-native', label: '浏览器原生（降级）', available: true, voices: [] },
  ],
}

const voicesResponse = {
  engine: 'edge-tts',
  engineLabel: '云端语音（Edge）',
  engineAvailable: true,
  voices: [],
}

beforeEach(() => {
  listTtsEngines.mockReset()
  listTtsVoices.mockReset()
  listTtsEngines.mockResolvedValue(enginesResponse)
  listTtsVoices.mockResolvedValue(voicesResponse)
})

describe('朗读引擎的降级顺序', () => {
  it('浏览器支持 Web Speech 时，浏览器原生可选，默认仍是服务端引擎', async () => {
    installSpeechSynthesis()
    const res = await loadEngines()
    expect(res.defaultId).toBe('edge-tts')
    expect(res.options.map((o) => o.id)).toContain('browser-native')
  })

  it('浏览器没有 Web Speech 时，不把浏览器原生放进可选列表', async () => {
    removeSpeechSynthesis()
    const res = await loadEngines()
    expect(res.options.map((o) => o.id)).not.toContain('browser-native')
    expect(res.defaultId).toBe('edge-tts')
  })

  it('服务端不可达且没有 Web Speech 时，返回不可用项而不是空列表', async () => {
    removeSpeechSynthesis()
    listTtsEngines.mockRejectedValue(new Error('offline'))
    const res = await loadEngines()
    expect(res.options).toHaveLength(1)
    expect(res.options[0].id).toBe('browser-native')
    expect(res.options[0].available).toBe(false)
  })
})

/**
 * 契约 §9.4：本机没装的音色要如实列出来并说明原因。
 *
 * 8848f0e 改成"browser-native 那条 continue 掉、由客户端重建"之后，本地引擎
 * 整个没起来时没有一个服务端引擎条目能认领 missingZh —— 音色下拉框空着、
 * 控制条上"* 个音色需安装离线音色包"也不出现。本机没装 Kokoro 是最常见的
 * 部署形态，这条不能只靠一条 e2e 兜着。
 */
describe('降级时的音色目录（契约 §9.4）', () => {
  const catalogWithMissing = {
    engine: 'kokoro-local',
    engineLabel: '本地引擎',
    engineAvailable: false,
    voices: [
      { voice: 'zf_xiaobei', label: '晓北（女·普通话）', lang: 'zh', chinese: true, available: false, note: '需安装离线音色包' },
      { voice: 'af_heart', label: 'Heart（女·美音）', lang: 'en', chinese: false, available: false },
    ],
  }

  /** 没装 Kokoro 的机器上，服务端只剩一条 browser-native */
  const onlyBrowserEngines = {
    default: 'kokoro-local',
    engines: [
      { engine: 'kokoro-local', label: '本地引擎', available: false, voices: [] },
      { engine: 'browser-native', label: '浏览器原生（降级）', available: true, voices: [] },
    ],
  }

  it('本地引擎没起来时，没装的中文音色挂到浏览器原生那条上', async () => {
    installSpeechSynthesis()
    listTtsEngines.mockResolvedValue(onlyBrowserEngines)
    listTtsVoices.mockResolvedValue(catalogWithMissing)

    const res = await loadEngines()
    const browser = res.options.find((o) => o.id === 'browser-native')!
    expect(browser).toBeTruthy()

    const missing = browser.voiceCatalog.filter((v) => v.available === false)
    expect(missing.map((v) => v.voice)).toContain('zf_xiaobei')
    expect(missing[0].note).toBe('需安装离线音色包')
    // 只挑中文的置灰项：英文音色读中文会走音，列进来只会撑长下拉
    expect(missing.map((v) => v.voice)).not.toContain('af_heart')
    // 置灰项只用于展示，不能混进可选音色
    expect(browser.voices.map((v) => v.voice)).not.toContain('zf_xiaobei')
  })

  it('引擎通着但缺语言包时，音色挂在引擎自己名下，不重复列到浏览器原生那条', async () => {
    installSpeechSynthesis()
    listTtsEngines.mockResolvedValue({
      default: 'edge-tts',
      engines: [
        { engine: 'edge-tts', label: '云端语音（Edge）', available: true, voices: [] },
        { engine: 'browser-native', label: '浏览器原生（降级）', available: true, voices: [] },
      ],
    })
    // 引擎通着（engineAvailable: true），只是缺中文语言包 —— 这是"缺包"的形态
    listTtsVoices.mockResolvedValue({ ...catalogWithMissing, engine: 'edge-tts', engineAvailable: true })

    const res = await loadEngines()
    const browser = res.options.find((o) => o.id === 'browser-native')!
    const edge = res.options.find((o) => o.id === 'edge-tts')!

    // 由服务端那条认领
    expect(edge.voiceCatalog.some((v) => v.voice === 'zf_xiaobei')).toBe(true)
    // 浏览器原生那条只剩自己的系统嗓音，不重复
    expect(browser.voiceCatalog.some((v) => v.voice === 'zf_xiaobei')).toBe(false)
  })
})
