import { api, type TtsVoice, type TtsVoiceDetail, type TtsVoicesResponse } from '../../../api/client'
import { BrowserTtsEngine, whenBrowserVoicesReady } from './browserTts'
import { ServerTtsEngine } from './serverTts'
import type { TtsEngine, VoiceOption } from './types'

export * from './types'

export interface EngineOption {
  id: string
  label: string
  available: boolean
  realAudio: boolean
  /**
   * **可用**音色。喂给引擎，也用于"原来选的音色不在新引擎里就退到第一个"。
   * 本机没装的离线音色包**不在**这里 —— 它们只在 voiceCatalog 里露脸。
   */
  voices: VoiceOption[]
  /**
   * 界面用的完整音色目录，含本机没装的（available=false，置灰）。
   * 浏览器原生那条没有"离线包"这个概念，它就等于 voices。
   */
  voiceCatalog: VoiceOption[]
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
    // 浏览器原生没有"离线音色包"这回事，系统装了哪些中文嗓音就是哪些
    voiceCatalog: e.voices,
  }
}

/** 上游此刻能合成的音色：用目录里的中文名/性别把它标得更清楚些 */
function toVoiceOption(v: TtsVoice, catalog: TtsVoicesResponse | null): VoiceOption {
  const hit = catalog?.voices.find((c) => c.voice === v.voice)
  return {
    voice: v.voice,
    label: hit?.label ?? v.label,
    lang: hit?.lang ?? v.lang,
    gender: hit?.gender,
    chinese: hit?.chinese ?? v.lang.toLowerCase().startsWith('zh'),
    available: true,
  }
}

/** 目录里有、本机没装的：置灰列出来，让读者知道是"没装"而不是"没有" */
function toMissingOption(v: TtsVoiceDetail): VoiceOption {
  return {
    voice: v.voice,
    label: v.label,
    lang: v.lang,
    gender: v.gender,
    chinese: v.chinese,
    available: false,
    note: v.note ?? '需安装离线音色包',
  }
}

/**
 * 拉取可用引擎。
 * 服务端连不上、或它有引擎但都不可用时，都退回"只有浏览器原生"这一条，
 * 保证跟读功能在任何情况下都有东西可用（契约 §9.2 的降级要求）。
 */
export async function loadEngines(): Promise<EnginesLoadResult> {
  try {
    // 音色目录拉不到不算致命：退回"只有上游报的音色"，界面上少几个置灰项而已。
    //
    // whenBrowserVoicesReady 放在这一批里一起等：Chrome 的 getVoices() 首次调用
    // 几乎总是返回空、要等 voiceschanged，不等一下的话下面 BROWSER_OPTION() 就会
    // 把空列表快照进去，降级后音色下拉框永远是空的。它带超时兜底，最坏也就多等 800ms
    const [res, catalog] = await Promise.all([
      api.listTtsEngines(),
      api.listTtsVoices().catch(() => null),
      whenBrowserVoicesReady(),
    ])

    // 本机没装的中文音色。只挑中文的 —— 本项目正文都是中文，
    // 再把英日音的置灰项列进来只会把下拉撑长，没有用处。
    const missingZh = (catalog?.voices ?? [])
      .filter((v) => !v.available && v.chinese)
      .map(toMissingOption)

    const localUp = catalog?.engineAvailable ?? false
    // 等过了 whenBrowserVoicesReady 再建，这一步才拿得到浏览器填好的嗓音
    const browser = BROWSER_OPTION()

    const usable: EngineOption[] = res.engines
      .filter((e) => e.available)
      .map((e) => {
        /**
         * 浏览器原生那条的**音色列表只有一个来源：客户端自己枚举**。
         * 服务端在 §9.1 里也会列出一条 browser-native，但它的 voices 恒为 `[]`
         * —— 服务端当然枚举不出浏览器里装了哪些嗓音。这里必须换成
         * BROWSER_OPTION() 的那份，否则下面 `usable` 里服务端那条会被 push 进来、
         * 盖掉客户端的（`if (!usable.some(...))` 只在那条缺失时才补），
         * 结果就是降级后音色下拉框永远空着且 disabled。
         */
        const isBrowser = e.engine === 'browser-native'
        const voices = isBrowser ? browser.voices : e.voices.map((v) => toVoiceOption(v, catalog))
        // 本地引擎活着 → 挂它名下；本地引擎没起来（它按契约 §9.1 不进列表）→
        // 挂到浏览器原生那条上。否则读者在降级状态下只会看到寥寥几个系统嗓音，
        // 既不知道有更好的中文音色，也不知道是"没装包"而不是"没有"
        const attach = catalog?.engine === e.engine ? localUp : !localUp
        return {
          id: e.engine,
          label: e.label,
          available: true,
          realAudio: e.engine !== 'browser-native',
          voices,
          voiceCatalog: attach ? [...voices, ...missingZh] : voices,
        }
      })

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
    // 服务端不可达：直接用浏览器原生，不打扰用户。
    // 这条路更要等嗓音 —— 浏览器原生是唯一选项，列表空着的话读者连音色都换不了
    await whenBrowserVoicesReady()
    const browser = BROWSER_OPTION()
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
