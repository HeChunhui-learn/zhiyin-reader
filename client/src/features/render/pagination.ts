import type { WindowGeometry } from './virtualWindow'

/**
 * 横向分页的页边界计算（阅读版面 = 横向分页时用）。
 *
 * 化用自一个开源 TXT 阅读器的"按屏高切页"思路，但改了关键的一步：
 * **它按像素切、用 overflow:hidden 裁；这里让页边界对齐到段落**。
 *
 * 为什么不能按像素切：`[i*pageH, (i+1)*pageH)` 这种切法会把页底那一行汉字
 * 拦腰截断 —— 屏幕上就是一行缺了下半边的字。这是看得见的缺陷，不是可接受的
 * 误差，靠"重叠几像素"也救不了（重叠只对滚动有用，对裁切没用）。
 *
 * 对齐段落之后：
 *   · 页与页之间落在自然的段间空白上，不会出现半行字
 *   · 页内段落走正常文档流，不需要"负偏移 + 撑高块"那套，实测高度天然正确
 *   · 代价是页底可能留一点空白（中文段落短，通常只差一两行）
 *
 * ── 长段落怎么办（这是必须处理的，不是边角情况）──
 * 实测：一篇 1030 段的小说里有 **133 段超过一页、占总高度 75%**
 * （网文常见"一章就是一整段"）。这种段落若独占一页再裁掉溢出，
 * 读者就永远读不到后半截 —— 等于丢正文，不能接受。
 *
 * 解法利用了一个排版事实：**一个段落内部的行高是均匀的**。
 * 所以把裁切高度取成行高的**整数倍**，切点就正好落在自然行边界上 ——
 * 既不用做字符级二分测量，也不会切出半行字。于是一段长文会被切成连续的几页，
 * 每页显示整数行，翻页时接着读。
 *
 * 纯函数、不碰 DOM —— 和 virtualWindow.ts 一样单独拎出来便于对拍。
 */

export interface PageLayout {
  /** 每页的第一个段号 */
  starts: number[]
  /** 每页的最后一个段号。整段页里 ends[i] >= starts[i]；切片页里两者相等 */
  ends: number[]
  /**
   * -1 = 整段页；`k >= 0` = 这一页是 `starts[i]` 那一段的**第 k 片**。
   * 切片页按整行裁切（见 sliceHeight）。
   */
  slice: number[]
}

/**
 * 页高留出的安全余量（半行）。
 *
 * 几何表的高度**先估后测**：估算偏小的段落在首帧渲染出来会比预期高，可能撑破页底。
 * 留半行余量能让这种情况少见得多；真溢出了也有 slot 的 overflow:hidden 兜底，
 * 下一帧实测回写后重排就收敛了。
 */
export const PAGE_SAFETY = 15

const EMPTY: PageLayout = { starts: [], ends: [], slice: [] }

/** 空页表。纵向滚动版面下用它，免得各处判空写法不一致 */
export const NO_PAGES: PageLayout = EMPTY

/**
 * 切片页的裁切高度：**行高的整数倍**，且不超过一页能装的内容高度。
 *
 * 取整数倍是这里唯一的要点 —— 段落内行高均匀，所以整数倍的切点必然落在
 * 两条文字行之间，切出来的是整行。
 */
export function sliceHeight(pageH: number, lineHeight: number): number {
  if (lineHeight <= 0) return Math.max(1, pageH - PAGE_SAFETY)
  const usable = pageH - PAGE_SAFETY
  if (usable < lineHeight) return lineHeight
  return Math.floor(usable / lineHeight) * lineHeight
}

/**
 * 把文档切成页。
 *
 * @param geom       几何表（heights[i] 是第 i 段的高度，offsets 为累计）
 * @param pageH      一页能用的内容高度（已扣掉版心上下内边距）
 * @param lineHeight 正文行高，用于把长段落切成整行
 */
export function paginate(geom: WindowGeometry, pageH: number, lineHeight: number): PageLayout {
  const n = geom.heights.length
  const limit = pageH - PAGE_SAFETY
  if (n === 0 || limit <= 0) return EMPTY

  const starts: number[] = []
  const ends: number[] = []
  const slice: number[] = []
  const cut = sliceHeight(pageH, lineHeight)

  let start = 0
  while (start < n) {
    // 单段自身就高于一页：切成连续的几片，每片按整行裁。
    // 注意判据用的是"文本高度"和 limit 比 —— heights 里含段间距，
    // 实测回写之后又只剩文本高度（offsetHeight 不含 margin），单位并不严格一致；
    // 但偏差有界（半个行高上下），且切片点始终落在整行上，不会切出半行字
    if (geom.heights[start] > limit) {
      const count = Math.max(1, Math.ceil(geom.heights[start] / cut))
      for (let k = 0; k < count; k++) {
        starts.push(start)
        ends.push(start)
        slice.push(k)
      }
      start++
      continue
    }

    // 普通页：从 start 起尽量多装**整段**。
    // 直接累加 heights 而不是拿 offsets[end+1]-offsets[start] 比 ——
    // 后者少算一段就会把下一页的段落无条件吞进来（曾经这么错过一次，单测 PG-03 抓到了）
    let end = start
    let acc = geom.heights[start]
    while (end + 1 < n && acc + geom.heights[end + 1] <= limit) {
      end++
      acc += geom.heights[end]
    }
    starts.push(start)
    ends.push(end)
    slice.push(-1)
    start = end + 1
  }

  return { starts, ends, slice }
}

/** 段号 → 页号（二分）。页表还没算出来（pageH 未就绪）时返回 -1 */
export function pageOfPara(pages: PageLayout, paraIndex: number): number {
  const n = pages.starts.length
  if (n === 0 || paraIndex < pages.starts[0]) return -1

  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pages.starts[mid] <= paraIndex) lo = mid
    else hi = mid - 1
  }
  return lo
}
