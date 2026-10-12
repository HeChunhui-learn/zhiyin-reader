/**
 * 目录与当前段落之间的换算。
 *
 * 纯 TS、无框架依赖 —— 和 virtualWindow.ts 一样，好单独验证也方便复用。
 */

export interface TocAnchor {
  paraIndex: number
}

/**
 * 当前段落落在哪一章。
 *
 * `items` 按 paraIndex 升序（它就是 paragraphs 过滤出来的），所以二分就够。
 * 返回 items 里的下标；当前段落还在**第一个标题之前**时返回 -1 ——
 * 那种情况下确实没有"当前章节"，硬指到第 0 章反而是错的。
 */
export function tocIndexAt(items: TocAnchor[], paraIndex: number): number {
  let lo = 0
  let hi = items.length - 1
  let found = -1

  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const item = items[mid]
    if (item && item.paraIndex <= paraIndex) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return found
}
