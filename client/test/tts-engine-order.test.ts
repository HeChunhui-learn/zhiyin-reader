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
