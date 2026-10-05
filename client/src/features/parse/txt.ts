import {
  headingLevel,
  joinLines,
  normalizeText,
  stripExt,
  type ParseResult,
  type ParsedParagraph,
} from './types'

/**
 * 纯文本解析。
 *
 * 分段规则：
 *   1. 文件里有空行 → 按空行分段（这是最常见的中文电子书排版）
 *   2. 没有空行     → 按单行分段
 *   3. 段内多行     → 按 R6「段落内换行按句内空白处理」合并；中文之间不补空格
 * 标题识别：第 X 章 / 卷 / 部 / 篇 / 回 → h1；第 X 节 → h2；# 开头按井号数量。
 */
export function parseTxt(raw: string, fileName: string, author = '未知'): ParseResult {
  const text = normalizeText(raw)
  const hasBlankLine = /\n[ \t　]*\n/.test(text)

  const blocks = text
    .split(hasBlankLine ? /\n[ \t　]*\n+/ : /\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)

  const paragraphs: ParsedParagraph[] = []
  let title = stripExt(fileName)
  let titleLocked = false

  blocks.forEach((block) => {
    const lines = block.split('\n')
    const level = headingLevel(lines[0])
    const body = joinLines(lines)

    if (!body) return

    // 第一个一级标题兼作书名
    if (level === 1 && !titleLocked) {
      title = body.replace(/^#{1,6}\s*/, '').trim()
      titleLocked = true
    }

    paragraphs.push({
      paraIndex: paragraphs.length,
      type: level === 1 ? 'h1' : level === 2 ? 'h2' : 'p',
      text: body.replace(/^#{1,6}\s*/, '').trim(),
    })
  })

  return { paragraphs, imageRefs: [], title, author }
}
