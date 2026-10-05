import type { Anchor } from '../../api/client'
import type { Paragraph } from '../../models/types'

export type { Anchor }

export const DEFAULT_ANCHOR: Anchor = {
  chapterIndex: 0,
  paragraphIndex: 0,
  sentenceIndex: 0,
  charOffset: 0,
  scrollOffset: 0,
}

/**
 * 比较阅读位置先后（不含 scrollOffset —— 滚动微调不影响"读到哪了"）。
 * 与服务端 server/src/sync/anchor.ts 的 compareAnchor 必须一致。
 */
export function compareAnchor(a: Anchor, b: Anchor): number {
  const keys = ['chapterIndex', 'paragraphIndex', 'sentenceIndex', 'charOffset'] as const
  for (const k of keys) {
    const av = a[k] ?? 0
    const bv = b[k] ?? 0
    if (av !== bv) return av - bv
  }
  return 0
}

export function samePosition(a: Anchor, b: Anchor): boolean {
  return compareAnchor(a, b) === 0
}

/** 由段落序号造一个锚点（本项目目前是单章文档，chapterIndex 恒为 0） */
export function anchorAt(paragraphIndex: number, sentenceIndex = 0, scrollOffset = 0): Anchor {
  return { chapterIndex: 0, paragraphIndex, sentenceIndex, charOffset: 0, scrollOffset }
}

/**
 * 在段落数组里找离锚点最近、且**确实存在**的段落序号。
 * 文档变过之后锚点可能越界，这里做降级，避免定位到空白。
 */
export function clampToParagraphs(anchor: Anchor, paragraphs: Paragraph[]): number {
  if (paragraphs.length === 0) return 0
  const max = paragraphs.length - 1
  const idx = Math.max(0, Math.min(max, anchor.paragraphIndex))
  if (paragraphs[idx]) return idx
  return 0
}
