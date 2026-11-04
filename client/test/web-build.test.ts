import { describe, expect, it } from 'vitest'
import { isPhoneOrTablet, parseBuildId } from '../src/features/app/webBuild'

/**
 * 网页版更新提示的底座：从 index.html 里取构建号。
 *
 * 这个解析必须对 meta 的属性顺序不敏感 —— vite 注入的格式以后可能变，
 * 手写模板、其他插件、压缩器也可能重排属性；取错了就会误报「有新版本」，
 * 或者永远不提示。
 */
describe('网页构建号解析（webBuild/parseBuildId）', () => {
  it('name 在前、content 在后', () => {
    const html = `<head><meta name="zhiyin-build" content="abc123" /></head>`
    expect(parseBuildId(html)).toBe('abc123')
  })

  it('content 在前、name 在后', () => {
    const html = `<head><meta content="def456" name="zhiyin-build"></head>`
    expect(parseBuildId(html)).toBe('def456')
  })

  it('单引号与混合大小写', () => {
    const html = `<META NAME='zhiyin-build' CONTENT='ghi789'>`
    expect(parseBuildId(html)).toBe('ghi789')
  })

  it('忽略其他 meta，只取构建号', () => {
    const html = `
      <meta name="viewport" content="width=device-width">
      <meta name="zhiyin-build" content="build-42">
      <meta name="theme-color" content="#1a2f63">
    `
    expect(parseBuildId(html)).toBe('build-42')
  })

  it('没有构建号时返回空串，调用方据此不做比较', () => {
    expect(parseBuildId('<meta name="viewport" content="width=device-width">')).toBe('')
    expect(parseBuildId('')).toBe('')
  })
})

/**
 * 网页更新横幅只在手机 / 平板上出现。
 *
 * 不能用 `maxTouchPoints > 0` 判断：带触摸屏的 Windows 笔记本也有触摸点，
 * 但它仍然配鼠标、有 hover，是桌面。用「主指针是粗的」+「没有 hover」才准确。
 */
describe('手机 / 平板判断（webBuild/isPhoneOrTablet）', () => {
  function env(opts: { coarse: boolean; noHover: boolean; width?: number; touchPoints?: number }) {
    const win = {
      innerWidth: opts.width ?? 1440,
      matchMedia(query: string) {
        if (query.includes('pointer: coarse')) return { matches: opts.coarse }
        if (query.includes('hover: none')) return { matches: opts.noHover }
        return { matches: false }
      },
    }
    const nav = { maxTouchPoints: opts.touchPoints ?? 0 }
    return { win, nav }
  }

  it('手机 / 平板：粗指针且没有 hover', () => {
    const { win, nav } = env({ coarse: true, noHover: true, width: 390, touchPoints: 5 })
    expect(isPhoneOrTablet(win, nav)).toBe(true)
  })

  it('带触摸屏的桌面：有触摸点但有 hover，不当成手机', () => {
    const { win, nav } = env({ coarse: false, noHover: false, width: 1440, touchPoints: 10 })
    expect(isPhoneOrTablet(win, nav)).toBe(false)
  })

  it('被拖窄的桌面窗口：宽度 ≤ 1024 也不算手机', () => {
    const { win, nav } = env({ coarse: false, noHover: false, width: 1000, touchPoints: 0 })
    expect(isPhoneOrTablet(win, nav)).toBe(false)
  })

  it('没有 matchMedia 的环境一律按桌面处理', () => {
    expect(isPhoneOrTablet({ innerWidth: 390 } as never, { maxTouchPoints: 5 })).toBe(false)
  })

  it('没有 window / navigator 时返回 false，不抛错', () => {
    expect(isPhoneOrTablet(null, null)).toBe(false)
  })
})
