import type { Paragraph } from '../../models/types'

/**
 * 长文档的窗口化渲染（技术选型 §5.3 说的"虚拟滚动"）。
 *
 * 依据：03 §3.1 5) 要求"页面 DOM 节点总数不超过当前渲染窗口上限（视口窗口量的 3 倍以内）"。
 * 一次性把 2000 个段落全渲染出来，这条就不成立。
 *
 * 做法：
 *   1. 按文本长度估算每段高度，算出累计偏移
 *   2. 滚动时只渲染视口上下各一屏以内的段落，其余用上下两个撑高块占位
 *   3. 渲染出来的段落实测高度回写进几何表，修正累计偏移
 *
 * **只对超过阈值的文档启用**（见 ReaderView 的 VIRTUAL_THRESHOLD）。
 * 短文档走原来的"全部渲染"路径，行为与之前完全一致 —— 演示书只有 17 段，
 * 不该为了这个把已经跑通的阅读体验换掉。
 */

/* -------------------------------------------------------------- 估算 */

/** 正文排版是 max-width 720px / font-size 16px，中文一行大约 42 个字 */
const CHARS_PER_LINE = 42
const LINE_HEIGHT = 30.4 // font-size 16px × line-height 1.9
const PARA_GAP = 18

export function estimateHeight(p: Paragraph): number {
  switch (p.type) {
    case 'h1':
      return 24 * 1.4 + 48 // 大标题 + 上下外边距
    case 'h2':
      return 18 * 1.4 + 46
    case 'img':
      return 200 + 30 // 图片占位 + 图注
    default: {
      const len = p.text.length
      const lines = Math.max(1, Math.ceil(len / CHARS_PER_LINE))
      return lines * LINE_HEIGHT + PARA_GAP
    }
  }
}

/* ------------------------------------------------------------ 几何表 */

export interface WindowGeometry {
  heights: number[]
  /** offsets[i] 是第 i 段顶部的 y；offsets[n] 是总高度 */
  offsets: number[]
}

export function buildGeometry(paragraphs: Paragraph[]): WindowGeometry {
  const heights = paragraphs.map(estimateHeight)
  return { heights, offsets: cumulative(heights) }
}

function cumulative(heights: number[]): number[] {
  const offsets = new Array<number>(heights.length + 1)
  offsets[0] = 0
  for (let i = 0; i < heights.length; i++) offsets[i + 1] = offsets[i] + heights[i]
  return offsets
}

/** 从第 index 段起重算累计偏移（实测高度回写后用） */
export function recomputeFrom(geom: WindowGeometry, index: number): void {
  for (let i = Math.max(0, index); i < geom.heights.length; i++) {
    geom.offsets[i + 1] = geom.offsets[i] + geom.heights[i]
  }
}

export function totalHeight(geom: WindowGeometry): number {
  return geom.offsets[geom.heights.length] ?? 0
}

/* -------------------------------------------------------------- 窗口 */

/** 二分找出 y 落在第几段 */
export function paragraphAt(geom: WindowGeometry, y: number): number {
  const n = geom.heights.length
  if (n === 0) return 0
  if (y <= 0) return 0
  if (y >= geom.offsets[n]) return n - 1

  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (geom.offsets[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

export interface WindowRange {
  start: number
  end: number
}

/**
 * 算出要渲染的段落区间 [start, end]。
 *
 * 上下各留一屏的余量，所以同时挂载的段落大约是 3 屏的量 ——
 * 正好对应"视口窗口量的 3 倍以内"。
 */
export function computeWindow(
  geom: WindowGeometry,
  scrollTop: number,
  viewportHeight: number,
  forceInclude = -1,
): WindowRange {
  const n = geom.heights.length
  if (n === 0) return { start: 0, end: -1 }

  const overscan = Math.max(200, viewportHeight)

  let start = paragraphAt(geom, scrollTop - overscan)
  let end = paragraphAt(geom, scrollTop + viewportHeight + overscan)

  // 跟读高亮所在的段落必须留在渲染范围内，哪怕它已经滚出视口
  // （技术选型 §5.3：「跟读高亮所在的句子强制保留在渲染范围之内」）
  if (forceInclude >= 0 && forceInclude < n) {
    if (forceInclude < start) start = forceInclude
    if (forceInclude > end) end = forceInclude
  }

  return { start: Math.max(0, start), end: Math.min(n - 1, end) }
}

/** 跳转到某一段时，滚动容器应该滚到哪 */
export function offsetOf(geom: WindowGeometry, index: number): number {
  const i = Math.max(0, Math.min(geom.heights.length - 1, index))
  return geom.offsets[i] ?? 0
}
