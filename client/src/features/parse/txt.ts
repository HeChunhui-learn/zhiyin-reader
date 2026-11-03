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
/**
 * 正文单段的软上限与硬上限。
 *
 * 网文 TXT 有大量「一章一整行」的排版：整章没有换行、也没有空行，
 * 解析出来就是一个七千字上下的巨型段落（实测《剑来》1-500 章：
 * 502 段、平均 7282 字、最长 27394 字）。这种书在阅读器里是一堵墙：
 * 段落留白、跟读高亮、切段闪动全都退化成「一整块」，看不出节奏。
 *
 * 所以正文超过硬上限时按句末标点切开，尽量在软上限附近断行。
 * 只拆正文，不碰标题段；也没超限的段落原样返回，短文本不受影响。
 */
const SOFT_PARAGRAPH = 220
const HARD_PARAGRAPH = 420

/** 句末标点（切完之后标点留在前一句里） */
const SENTENCE_END = /(?<=[。！？…；!?])/

/** 下载站常见的占位文件名，这类才退回第一个标题当书名 */
const GENERIC_FILE_NAME = /^(未命名|无标题|新建|文本|全文|小说|book|document|download|untitled|new|txt|\d{1,8})$/i

function splitLongBody(text: string): string[] {
  if (text.length <= HARD_PARAGRAPH) return [text]

  const out: string[] = []
  let buf = ''
  for (const part of text.split(SENTENCE_END)) {
    buf += part
    if (buf.length >= SOFT_PARAGRAPH) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf) {
    // 尾巴太短就并回上一段，免得最后孤零零一个「了。」
    if (out.length > 0 && buf.length < 80) out[out.length - 1] += buf
    else out.push(buf)
  }

  // 一段里要是几十句都不带句末标点（对话、排比），上面的切法切不开，这里硬切兜底
  const capped: string[] = []
  for (const piece of out) {
    if (piece.length <= HARD_PARAGRAPH + 100) {
      capped.push(piece)
      continue
    }
    for (let i = 0; i < piece.length; i += SOFT_PARAGRAPH) {
      capped.push(piece.slice(i, i + SOFT_PARAGRAPH))
    }
  }
  return capped
}

export function parseTxt(raw: string, fileName: string, author = '未知'): ParseResult {
  const text = normalizeText(raw)
  const hasBlankLine = /\n[ \t　]*\n/.test(text)

  const blocks = text
    .split(hasBlankLine ? /\n[ \t　]*\n+/ : /\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)

  const paragraphs: ParsedParagraph[] = []
  let title = stripExt(fileName).trim()
  // 文件名像样的就直接当书名；只有下载站那种占位名（数字、untitled）才退回第一个标题。
  // 反面案例：《剑来(1-500章).txt》原先把「第一章 惊蛰」当成书名，书架上摆着一本书叫「第一章 惊蛰」。
  let titleLocked = title.length >= 2 && !GENERIC_FILE_NAME.test(title)

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
        // 一章一整行的书，这里的 rest 就是整章正文，超长要拆开
        for (const piece of splitLongBody(rest)) {
          paragraphs.push({ paraIndex: paragraphs.length, type: 'p', text: piece })
        }
      }
      return
    }

    const body = joinLines(lines)
    if (!body) return

    for (const piece of splitLongBody(body)) {
      paragraphs.push({
        paraIndex: paragraphs.length,
        type: 'p',
        text: piece,
      })
    }
  })

  return { paragraphs, imageRefs: [], title, author }
}
