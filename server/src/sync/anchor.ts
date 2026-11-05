/**
 * 阅读位置锚点。
 *
 * 字段名以 docs/system-design.md 第 4 节为准（见 §7 裁决 2）。
 * 服务端与客户端各有一份等价实现，两边必须保持一致。
 */

export interface Anchor {
  chapterIndex: number
  paragraphIndex: number
  sentenceIndex: number
  charOffset: number
  scrollOffset: number
  /** 可选：文档内容哈希。文档变了之后锚点可能失效，用于降级判定 */
  docVersion?: string
}

export const DEFAULT_ANCHOR: Anchor = {
  chapterIndex: 0,
  paragraphIndex: 0,
  sentenceIndex: 0,
  charOffset: 0,
  scrollOffset: 0,
}

/** 把外部传进来的东西整理成合法锚点，缺字段补 0 */
export function normalizeAnchor(raw: unknown): Anchor {
  const o = (raw ?? {}) as Partial<Anchor>
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0
  return {
    chapterIndex: num(o.chapterIndex),
    paragraphIndex: num(o.paragraphIndex),
    sentenceIndex: num(o.sentenceIndex),
    charOffset: num(o.charOffset),
    scrollOffset: num(o.scrollOffset),
    ...(typeof o.docVersion === 'string' ? { docVersion: o.docVersion } : {}),
  }
}

/**
 * 比较两个锚点的"阅读位置先后"。
 *
 * 注意：**不含 scrollOffset 与 docVersion** —— 滚动微调不影响"读到哪了"，
 * 文档哈希更不是位置。逐级比较，先比章节，再比段落，再比句子，最后比段内偏移。
 * 返回 >0 表示 a 更靠后（读得更多）。
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

/** 锚点相等（同样只看位置，不看滚动微调） */
export function samePosition(a: Anchor, b: Anchor): boolean {
  return compareAnchor(a, b) === 0
}
