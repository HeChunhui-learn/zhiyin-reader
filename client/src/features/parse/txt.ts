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
 *
 * 标题的粒度：判定的依据是**块的第一行**，但只有那一行成为标题段，
 * 剩下的行另起一个正文段。不这么切的话，章节标题与正文之间没有空行的书
 * （盗版站导出的 TXT 很常见）会把整章吃成一个标题段 —— 见下面 forEach 里的注释。
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

    if (level) {
      // 标题行单独成段，**剩下的行是正文**。
      //
      // 原先是把「整块」标成 h1/h2。对章节标题与正文之间没有空行的电子书
      // （盗版站导出的 TXT 很常见）来说，一整章会被判成一个标题段，后果有三：
      //   · 标题段不参与跟读 —— 整本书一句都读不了
      //   · h1 按标题样式渲染 —— 几千字的"标题"在页面上糊成一片
      //   · 书名取"第一个一级标题" —— 取到整个第一章
      const head = lines[0].replace(/^#{1,6}\s*/, '').trim()
      if (head) {
        // 第一个一级标题兼作书名
        if (level === 1 && !titleLocked) {
          title = head
          titleLocked = true
        }
        paragraphs.push({
          paraIndex: paragraphs.length,
          type: level === 1 ? 'h1' : 'h2',
          text: head,
        })
      }
      const rest = joinLines(lines.slice(1))
      if (rest) {
        paragraphs.push({ paraIndex: paragraphs.length, type: 'p', text: rest })
      }
      return
    }

    const body = joinLines(lines)
    if (!body) return

    paragraphs.push({
      paraIndex: paragraphs.length,
      type: 'p',
      text: body,
    })
  })

  return { paragraphs, imageRefs: [], title, author }
}
