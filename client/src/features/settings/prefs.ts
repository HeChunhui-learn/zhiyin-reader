/**
 * 阅读偏好（主题 / 字号 / 阅读版面 / 翻页方式 / 背景图）。
 *
 * 纯 TS、无 React 依赖 —— 和 api/device.ts 一样直接读写 localStorage，
 * provider 只是套在外面的一层壳。
 *
 * 只用一个键存整份偏好：写的时候是一次原子的 setItem，不会出现
 * "字号写进去了、主题没写进去"这种半截状态。
 *
 * 读的时候必须逐字段校验 —— 里面可能是旧版本写的、也可能被手改坏，
 * 任何一项不合法就退回默认值，**绝不能把异常抛进渲染**（CLAUDE.md §七.4 不许白屏）。
 */

const KEY = 'zhiyin.readerPrefs'

export type ReaderTheme = 'light' | 'dark'
/** 阅读版面：纵向长滚动 / 按屏高切成页横向翻 */
export type Layout = 'scroll' | 'paged'
/** 翻页方式：左右平移（带过渡）/ 整屏跳转（无过渡）。只在 layout === 'paged' 时生效 */
export type PageTurn = 'snap' | 'slide'

export interface ReaderPrefs {
  theme: ReaderTheme
  fontSize: number
  layout: Layout
  pageTurn: PageTurn
  /** 背景图在 IndexedDB 里的记录键；null = 没设背景 */
  bgImageId: string | null
}

/**
 * 可选的几档字号。
 *
 * 刻意做成**离散档位**而不是滑杆：字号一变就要重建整张几何表
 * （见 features/render/virtualWindow.ts 与 ReaderView 的重锚定 effect），
 * 滑杆拖动会把 2000 段的几何表重算到卡死。
 */
export const FONT_SIZES = [14, 16, 18, 20, 22, 24] as const

export const MIN_FONT_SIZE = FONT_SIZES[0]
export const MAX_FONT_SIZE = FONT_SIZES[FONT_SIZES.length - 1]

/** 与 app.css 的 .reader-content 默认值一致，所以默认档位是视觉上的零变化 */
export const DEFAULT_FONT_SIZE = 16

export const DEFAULT_PREFS: ReaderPrefs = {
  theme: 'light',
  fontSize: DEFAULT_FONT_SIZE,
  layout: 'scroll',
  // 默认给带过渡的那档：新功能的观感直接可见，不用读者再进设置里翻一次
  pageTurn: 'slide',
  bgImageId: null,
}

function readOne(raw: unknown): ReaderPrefs {
  // 用 Record 读而不是 Partial<ReaderPrefs>：旧版本的版面存在 `pageMode` 键上，
  // 它已经不是新类型的字段了，用 Partial<ReaderPrefs> 根本读不到，迁移会断在这儿
  const o = (raw ?? {}) as Record<string, unknown>

  const theme: ReaderTheme = o.theme === 'dark' ? 'dark' : 'light'

  // 版面：优先认新键 layout；只有旧键 pageMode 时才把旧值搬过来。
  // **必须显式迁移** —— 否则老用户升级后原来的"分页"选择会被静默吞掉、变回滚动
  const layout: Layout =
    o.layout === 'paged' || o.layout === 'scroll'
      ? o.layout
      : o.pageMode === 'paged'
        ? 'paged'
        : 'scroll'

  const pageTurn: PageTurn = o.pageTurn === 'snap' ? 'snap' : 'slide'

  // 只认档位表里的值：手改出来的 37px 会让几何表按一个荒唐的比例缩放
  const fontSize =
    typeof o.fontSize === 'number' && (FONT_SIZES as readonly number[]).includes(o.fontSize)
      ? o.fontSize
      : DEFAULT_FONT_SIZE

  const bgImageId = typeof o.bgImageId === 'string' && o.bgImageId ? o.bgImageId : null

  return { theme, fontSize, layout, pageTurn, bgImageId }
}

export function readPrefs(): ReaderPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_PREFS
    return readOne(JSON.parse(raw))
  } catch {
    // 值被改坏了、或者 localStorage 本身不可用
    return DEFAULT_PREFS
  }
}

export function writePrefs(p: ReaderPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // 隐私模式下可能直接抛。记不住偏好不影响阅读，静默放过
  }
}

/**
 * 把主题写到 <html> 上。
 *
 * 顺带设 color-scheme：不设的话原生控件（下拉框、滚动条）在夜晚模式下
 * 仍然是白的，跟周围对不上。
 */
export function applyTheme(theme: ReaderTheme): void {
  const el = document.documentElement
  el.dataset.theme = theme
  el.style.colorScheme = theme
}
