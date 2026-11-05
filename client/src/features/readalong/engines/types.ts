export interface VoiceOption {
  voice: string
  label: string
  lang: string
  gender?: 'female' | 'male'
  /** 是否中文音色；undefined 表示未知（浏览器原生那条路拿不到这个信息） */
  chinese?: boolean
  /**
   * 本机装了没有。undefined / true = 可选。
   * false 的是"音色目录里有、但这台机器没装离线包"的，界面上置灰不可选
   * （契约 §9.4）。它们**不会**进 engine.voices，只出现在给界面看的 voiceCatalog 里。
   */
  available?: boolean
  /** 置灰原因，界面上挂成 option 的后缀 */
  note?: string
}

export interface SpeakOptions {
  voice: string
  rate: number
}

/**
 * 语音合成引擎的统一接口。
 *
 * 两个实现差别很大 —— 服务端引擎拿到的是音频二进制、靠 <audio> 的 ended 事件推进；
 * 浏览器原生引擎直接说话、靠 SpeechSynthesisUtterance 的 onend 推进 ——
 * 但对外都收敛成"朗读一句，念完 resolve"，这样上层的游标推进逻辑只用写一份。
 */
export interface TtsEngine {
  readonly id: string
  readonly label: string
  /**
   * 是否有真实音频事件。
   * false 表示这是降级路径（浏览器原生），docs/system-design.md §6.3 要求它明确只支持句子级高亮。
   */
  readonly realAudio: boolean
  readonly voices: VoiceOption[]
  /** 朗读一句；被 signal 打断时 reject 一个 name 为 AbortError 的错误 */
  speak(text: string, opts: SpeakOptions, signal: AbortSignal): Promise<void>
  /** 预取后续句子，减少句间停顿；不支持的引擎是空实现 */
  preload(texts: string[], opts: SpeakOptions): void
  /** 立即停止当前朗读 */
  stop(): void
}

/** 打断用的错误，调用方据此区分"被停止"与"真失败" */
export function abortError(): Error {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

export function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}
