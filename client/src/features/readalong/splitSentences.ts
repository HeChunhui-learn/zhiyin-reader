/**
 * 句子切分（R0 占位版）。
 *
 * 已实现《软件设计规格说明书》表4-1 的这几条：
 *   R1 句末标点切分（。！？… 及其组合）
 *   R3 引号与括号内的句末标点同样切分，配对收尾符号归属前一句
 *   R4 连续省略号只算一次边界
 *   R7 切分前先归一化（剔除首尾空白与零宽字符）
 *   R9 空句不得入表
 *
 * 尚未实现：R2（分号冒号不切分——已天然满足）、R5（缩写与小数白名单）、
 * R6（段内换行归一）、R8（超长句兜底，200 字）、R10（索引稳定性）。
 * R4 轮次会按完整规则表重做，届时本文件被替换。
 */

export interface Sentence {
  /** 在整篇文档内的全局序号，0 基 —— 高亮游标用的就是它 */
  sentenceIndex: number
  paraIndex: number
  /** 段内字符偏移，0 基，UTF-16 code unit */
  startOffset: number
  endOffset: number
  text: string
}

const TERMINAL = new Set(['。', '！', '？', '…', '．'])
/** 配对收尾符号：跟在句末标点后面的这些要算进前一句 */
const CLOSERS = new Set(['”', '』', '」', '）', ')', '】', '》', '〉', '"', "'"])
const ZERO_WIDTH = /[​-‍﻿]/g

export function normalize(text: string): string {
  return text.replace(ZERO_WIDTH, '').trim()
}

/** 切分单个段落，返回段内句子（不含全局序号） */
export function splitParagraph(
  text: string,
  paraIndex: number,
): Omit<Sentence, 'sentenceIndex'>[] {
  const s = normalize(text)
  if (!s) return []

  const out: Omit<Sentence, 'sentenceIndex'>[] = []
  let start = 0
  let i = 0

  while (i < s.length) {
    if (!TERMINAL.has(s[i])) {
      i++
      continue
    }
    // R1 + R4：把连续的句末标点吃成一个边界（…… 只算一次）
    let end = i + 1
    while (end < s.length && TERMINAL.has(s[end])) end++
    // R3：把紧跟的配对收尾符号并入本句
    while (end < s.length && CLOSERS.has(s[end])) end++

    const piece = s.slice(start, end).trim()
    // R9：空句不入表
    if (piece) {
      out.push({
        paraIndex,
        startOffset: start,
        endOffset: end,
        text: piece,
      })
    }
    start = end
    i = end
  }

  // 段落末尾没有句末标点的残余部分，整段作为最后一句
  const tail = s.slice(start).trim()
  if (tail && !(out.length > 0 && out[out.length - 1].endOffset === s.length)) {
    out.push({
      paraIndex,
      startOffset: start,
      endOffset: s.length,
      text: tail,
    })
  }
  return out
}

/** 切分整篇文档，编号全局句序 */
export function splitSentences(
  paragraphs: { paraIndex: number; type: string; text: string }[],
): Sentence[] {
  const all: Sentence[] = []
  for (const p of paragraphs) {
    // 标题与图片不参与跟读
    if (p.type === 'h1' || p.type === 'h2' || p.type === 'img') continue
    for (const s of splitParagraph(p.text, p.paraIndex)) {
      all.push({ ...s, sentenceIndex: all.length })
    }
  }
  return all
}
