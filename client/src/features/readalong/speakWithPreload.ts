import type { SpeakOptions, TtsEngine } from './engines/types'

/** 当前句先进入加载队列，后续预取与播放并行，完成仍以真实音频事件为准。 */
export async function speakWithPreload(engine: TtsEngine, text: string, following: string[], options: SpeakOptions, signal: AbortSignal): Promise<void> {
  const playing = engine.speak(text, options, signal)
  try { engine.preload(following, options) }
  catch { /* 预取失败不影响当前句 */ }
  await playing
}
