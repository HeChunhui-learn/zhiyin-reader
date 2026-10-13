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
 *   · 永远不会出现半行字，页与页之间落在自然的段间空白上
 *   · 页内段落走正常文档流，不需要"负偏移 + 撑高块"那套，实测高度天然正确
 *   · 代价是页底可能留一点空白（中文段落短，通常只差一两行）
 *
 * 纯函数、不碰 DOM —— 和 virtualWindow.ts 一样单独拎出来便于对拍。
 */

export interface PageLayout {
  /** starts[i] = 第 i 页的第一段；与 ends[i] 一一对应，且 ends[i] + 1 === starts[i+1] */
  starts: number[]
  ends: number[]
}

/**
 * 页高留出的安全余量（半行）。
 *
 * 几何表的高度**先估后测**：估算偏小的段落在首帧渲染出来会比预期高，可能撑破页底。
 * 留半行余量能让这种情况少见得多；真溢出了也有 slot 的 overflow:hidden 兜底，
 * 下一帧实测回写后重排就收敛了。
 */
export const PAGE_SAFETY = 15

const EMPTY: PageLayout = { starts: [], ends: [] }

/**
 * 把文档切成页，每页装"完整装得下"的段落。
 *
 * @param geom    几何表（offsets[i] 是第 i 段顶部 y）
 * @param pageH   一页能用的内容高度（已扣掉版心上下内边距）
 */
export function paginate(geom: WindowGeometry, pageH: number): PageLayout {
  const n = geom.heights.length
  const limit = pageH - PAGE_SAFETY
  if (n === 0 || limit <= 0) return EMPTY

  const starts: number[] = []
  const ends: number[] = []

  let start = 0
  while (start < n) {
    const top = geom.offsets[start]
    let end = start
    // 本页若含 [start, end]，高度就是 offsets[end+1] - top。
    // 所以"能不能再收下 end+1"要拿 offsets[end+2] 去比 —— 比 offsets[end+1] 就晚了一步，
    // 会把 end+1 无条件吞进来、页高超限（这正是单测 PG-03 抓到的那个 off-by-one）。
    //
    // 单段自身就高于一页时循环一次都不进，end 停在 start —— 让它独占一页，
    // 溢出的部分由 slot 裁掉，不串到下一页去
    while (end + 1 < n && geom.offsets[end + 2] - top <= limit) end++
    starts.push(start)
    ends.push(end)
    start = end + 1
  }

  return { starts, ends }
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

/** 空页表。纵向滚动版面下用它，免得各处判空写法不一致 */
export const NO_PAGES: PageLayout = EMPTY
