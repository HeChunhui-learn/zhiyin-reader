/** 解析产物。与 docs/system-design.md §5.3 的 paragraphs / imageRefs 对齐。 */

export type ParaType = 'h1' | 'h2' | 'p' | 'img'

export interface ParsedParagraph {
  paraIndex: number
  type: ParaType
  text: string
}

export interface ParsedImageRef {
  imageId: string
  paraIndex: number
  src: string
  alt: string
}

export interface ParseResult {
  paragraphs: ParsedParagraph[]
  imageRefs: ParsedImageRef[]
  title: string
  author: string
}

/** 表格里第 X 章 / 第 X 卷 / 第 X 部 这类当一级标题 */
const H1_RE = /^第\s*[一二三四五六七八九十百零〇0-9]+\s*[章卷部篇回]/
/** 第 X 节 / 小节 当二级标题 */
const H2_RE = /^第\s*[一二三四五六七八九十百零〇0-9]+\s*[节]/

export function headingLevel(line: string): 1 | 2 | 0 {
  const s = line.trim()
  if (H1_RE.test(s)) return 1
  if (H2_RE.test(s)) return 2
  const hashes = /^(#{1,6})\s+\S/.exec(s)
  if (hashes) return hashes[1].length === 1 ? 1 : 2
  return 0
}

/** 中英混排时，行间补空格的规则：两侧都是中日韩字符就不补 */
export function joinLines(lines: string[]): string {
  let out = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (!out) {
      out = line
      continue
    }
    const prev = out[out.length - 1]
    const next = line[0]
    const cjk = /[　-鿿＀-￯]/
    out += cjk.test(prev) && cjk.test(next) ? line : ' ' + line
  }
  return out
}

export function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/** R7：剔除零宽字符与首尾空白 */
export function normalizeText(s: string): string {
  return s.replace(/[​-‏﻿]/g, '').replace(/\r\n?/g, '\n')
}
