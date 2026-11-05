import { describe, expect, it } from 'vitest'
import { isBrowserTtsSupported } from '../src/features/readalong/engines/browserTts'
import { loadNativeVoices } from '../src/features/readalong/engines/nativeTts'

/**
 * 降级引擎的环境判定。
 *
 * 这两个函数决定「浏览器原生」与「设备原生」到底能不能出现在引擎列表里：
 *   - 普通 node/browser 环境没有 speechSynthesis，不能谎报浏览器原生可用；
 *   - 非 Capacitor 环境没有系统 TTS，不应去调插件。
 *
 * 真正的 Android WebView 行为要在真机上验证，这里守住的是「不要误报」。
 */
describe('TTS 降级引擎的环境判定', () => {
  it('node 环境没有 speechSynthesis', () => {
    expect(isBrowserTtsSupported()).toBe(false)
  })

  it('非原生环境不返回设备音色', async () => {
    await expect(loadNativeVoices()).resolves.toEqual([])
  })
})
