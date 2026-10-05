import { api } from '../../../api/client'
import { BrowserTtsEngine } from './browserTts'
import { ServerTtsEngine } from './serverTts'
import type { TtsEngine, VoiceOption } from './types'

export * from './types'

export interface EngineOption {
  id: string
  label: string
  available: boolean
  realAudio: boolean
  voices: VoiceOption[]
}

export interface EnginesLoadResult {
  /** 建议的默认引擎 id */
  defaultId: string
  /** 可选的引擎（契约 §9.1：available=false 的不出现在列表里） */
  options: EngineOption[]
  /** 服务端有没有报"本地引擎不可用"，用于界面上解释为什么降级了 */
  serverEngineDown: boolean
}

const BROWSER_OPTION = (): EngineOption => {
  const e = new BrowserTtsEngine()
  return {
    id: e.id,
    label: e.label,
    available: true,
    realAudio: false,
    voices: e.voices,
  }
}

/**
 * 拉取可用引擎。
 * 服务端连不上、或它有引擎但都不可用时，都退回"只有浏览器原生"这一条，
 * 保证跟读功能在任何情况下都有东西可用（契约 §9.2 的降级要求）。
 */
export async function loadEngines(): Promise<EnginesLoadResult> {
  const browser = BROWSER_OPTION()

  try {
    const res = await api.listTtsEngines()
    const usable: EngineOption[] = res.engines
      .filter((e) => e.available)
      .map((e) => ({
        id: e.engine,
        label: e.label,
        available: true,
        realAudio: e.engine !== 'browser-native',
        voices: e.voices,
      }))

    // 浏览器原生永远垫底，作为兜底
    if (!usable.some((o) => o.id === browser.id)) usable.push(browser)

    const defaultId = usable.some((o) => o.id === res.default)
      ? res.default
      : usable[0].id

    return {
      defaultId,
      options: usable,
      serverEngineDown: res.engines.some((e) => !e.available),
    }
  } catch {
    // 服务端不可达：直接用浏览器原生，不打扰用户
    return { defaultId: browser.id, options: [browser], serverEngineDown: true }
  }
}

/** 按 id 造引擎；id 不认识就退回浏览器原生 */
export function createEngine(
  id: string,
  docId: string,
  options: EngineOption[],
): TtsEngine {
  const opt = options.find((o) => o.id === id)
  if (!opt || opt.id === 'browser-native') return new BrowserTtsEngine()
  return new ServerTtsEngine(opt.id, opt.label, opt.voices, docId)
}
