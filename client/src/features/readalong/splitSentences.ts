/**
 * 句子切分 —— 按 .context/08b-句子切分补充.md §1.1 实现 R1–R10。
 *
 *   R1 句末标点切分（。！？… 及其组合），标点归属前一句
 *   R2 分号冒号不切分（不在 TERMINAL 里，天然满足）
 *   R3 配对收尾符号（” ) 』等）归属前一句，下一句不以收尾符号开头
 *   R4 连续句末标点只算一次边界（……、．．．．．．）
 *   R5 句点（. ．）落在小数/编号/缩写语境时不作边界
 *   R6 段内换行、制表符、连续空白归一为单个空格
 *   R7 切分前剔除零宽字符与首尾空白，偏移量以归一化后的文本为准
 *   R8 单句超过 200 字时在最近的 ，/、 处强制切分，无标点则硬切
 *   R9 纯空白、纯标点、长度为零的片段一律不入表
 *   R10 纯函数：同一输入重复切分结果逐字节相同
 *
 * ── C1 定下的四个决定（规范留白，摊在这里备查，另见提交信息）──
 *
 * 1. R5 的保护范围 = 小数/编号（句点两侧均为数字，覆盖 3.14、1.2.3、
 *    "第 3.14 节"）+ 下面的 ABBREVIATIONS 白名单。
 *    规范举的例子用的是 ASCII 句点，故 ASCII `.` 与全角 `．` 都按句点处理。
 *    已知代价：URL / 域名（example.com）不在这两条保护内，会被切断。
 *
 * 2. R8 的回溯起点：从「起点 + 200」处**往回**找最近的 ，/、，
 *    切点落在标点之后（标点归前句，与 R1 的口径一致）；回溯范围内没有
 *    可切标点则按 200 字硬切。长度按 UTF-16 code unit 计，
 *    与 startOffset / endOffset 同口径。
 *
 * 3. R10 的保证方式：本文件是纯函数 —— 不依赖时间、随机数、正则的
 *    lastIndex、以及 Map/Set 的迭代顺序，同一输入重复切分逐字节相同。
 *
 * 4. 切分规则变更视为"内容升级"：旧文档的句子表不会自动重建
 *    （导入按 content_hash 去重），详见提交信息。
 *
 * ── 事后补的两处修正（材料审查）──
 *
 * 5. **偏移量与文本必须一致**：`emit` 原先只对文本 trim、不动偏移量，
 *    凡「句末边界后紧跟一个空格」，下一句的 `text` 与
 *    `s.slice(startOffset, endOffset)` 就差一个前导空格。
 *    实测一本真实英文句 "The end. Next one." 第二句区间切出来是 " Next one."。
 *    现在改成先把区间收窄到非空白再取文本。
 *
 * 6. **R9 原先只挡了空片段**（`if (!text) return`），纯标点片段照收。
 *    真实网文里 `------------` 分隔线、对话里的 `……` 都会被当成合法句子，
 *    跟读会停下来"念"它们。现在按"无字母、无数字、无表意文字"丢弃。
 *
 *    代价：正文渲染取的是句子的 text（ReaderView 里按句子铺 span），
 *    所以被丢弃的纯标点片段**在页面上也不再显示**。当前两份种子文档没有
 *    这类片段，不受影响；网文里的分隔线会变成空行。
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

/** R1 句末标点：本身即边界，标点归属前一句 */
const TERMINAL = new Set(['。', '！', '？', '…'])
/** R5 句点：需先判断是否落在小数/编号/缩写语境里，不能直接当边界 */
const DOT = new Set(['.', '．'])
/** R3 配对收尾符号：紧跟在句末标点后面时并入前一句 */
const CLOSERS = new Set(['”', '』', '」', '）', ')', '】', '》', '〉', '"', "'"])
/** R7 零宽字符（含 BOM 与词连接符），与 features/parse/types.ts 的口径对齐 */
const ZERO_WIDTH = /[​-‏⁠﻿]/g
/** R6 段内空白：换行、制表符、连续空格、全角空格 → 单个半角空格 */
const WHITESPACE = /[\s　]+/g

/** R8 单句长度上限 */
export const MAX_SENTENCE_LEN = 200
/** R8 硬切时认可的回溯标点 */
const SOFT_BREAK = new Set(['，', '、'])

/** R9 判定"这句话有没有实际内容"：字母、数字、表意文字都算，纯标点不算 */
const HAS_WORD = /[\p{L}\p{N}]/u

/**
 * R5 缩写白名单（比较时统一转小写、含点号）。
 *
 * 中文文档里真正高频的是上面那条"两侧均为数字"的规则，这张表主要服务于
 * 中英混排。收词口径：**几乎不会出现在句末**的缩写才收 —— 否则会把真实
 * 的断句吞掉。因此 `etc.`（"……等等。"这类句末用法极常见）刻意不在表内，
 * `No.` 则必须收（"No. 5 is ready." 不能在 No 后面断开）。
 */
const ABBREVIATIONS = new Set([
  'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'st.', 'jr.', 'sr.',
  'no.', 'fig.', 'eq.', 'ref.', 'vs.', 'e.g.', 'i.e.',
])

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

/** R5：s[i] 处的句点是否算句末边界 */
function isDotBoundary(s: string, i: number): boolean {
  // 小数与编号：句点两侧均为数字（3.14、1.2.3、"第 3.14 节"）
  if (isDigit(s[i - 1]) && isDigit(s[i + 1])) return false
  // 缩写：取句点前连续的字母，连同点号一起查白名单
  let j = i
  while (j > 0 && /[A-Za-z]/.test(s[j - 1])) j--
  if (j < i && ABBREVIATIONS.has(s.slice(j, i).toLowerCase() + '.')) return false
  return true
}

/** 若 s[i] 处是一个句末边界，返回该边界的结束位置（不含）；否则返回 null */
function boundaryEndAt(s: string, i: number): number | null {
  const ch = s[i]
  const hit = TERMINAL.has(ch) || (DOT.has(ch) && isDotBoundary(s, i))
  if (!hit) return null

  let end = i + 1
  // R1 + R4：连续句末标点只算一次边界（……、．．．．．．）
  while (end < s.length && TERMINAL.has(s[end])) end++
  while (end < s.length && DOT.has(s[end]) && isDotBoundary(s, end)) end++
  // R3：紧跟的配对收尾符号并入本句
  while (end < s.length && CLOSERS.has(s[end])) end++
  return end
}

/** R7 + R6：切分前归一化。偏移量以本函数的结果为准 */
export function normalize(text: string): string {
  return text.replace(ZERO_WIDTH, '').replace(WHITESPACE, ' ').trim()
}

/**
 * 追加一个句子。R9：纯空白、纯标点、长度为零的片段一律不入表。
 *
 * 区间必须**先收窄到非空白再取文本**。调用方给的 [start, end) 是
 * 「上一句边界之后」到「本句边界」，中间那段空白会落在区间里。
 * 只 trim 文本、不动偏移量的话，`text` 与 `s.slice(startOffset, endOffset)`
 * 就对不上（英文正文里句号后面跟一个空格，几乎句句如此），
 * 锚点的 charOffset 与高亮范围都会偏一位。两者必须逐字节一致。
 */
function emit(
  out: Omit<Sentence, 'sentenceIndex'>[],
  s: string,
  start: number,
  end: number,
  paraIndex: number,
): void {
  let a = start
  let b = end
  while (a < b && s[a] === ' ') a++
  while (b > a && s[b - 1] === ' ') b--
  if (a >= b) return

  const text = s.slice(a, b)
  // R9：纯标点不入表。网文里的 "------------" 分隔线、对话里的 "……" 都属于这一类，
  // 留着的话跟读会停下来"念"它们、高亮也会停在上面。
  if (!HAS_WORD.test(text)) return

  out.push({ paraIndex, startOffset: a, endOffset: b, text })
}

/** R8：把 [start, end) 按 200 字上限切开后逐段追加 */
function emitWithOverflowSplit(
  out: Omit<Sentence, 'sentenceIndex'>[],
  s: string,
  start: number,
  end: number,
  paraIndex: number,
): void {
  let from = start
  while (end - from > MAX_SENTENCE_LEN) {
    // 从「起点 + 上限」处往回找最近的 ，/、，切点落在标点之后
    let cut = -1
    for (let k = from + MAX_SENTENCE_LEN; k > from; k--) {
      if (SOFT_BREAK.has(s[k - 1])) {
        cut = k
        break
      }
    }
    // 回溯范围内没有可切标点 → 按上限硬切（保证每轮必进，不会死循环）
    if (cut <= from) cut = from + MAX_SENTENCE_LEN
    emit(out, s, from, cut, paraIndex)
    from = cut
  }
  emit(out, s, from, end, paraIndex)
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
    const end = boundaryEndAt(s, i)
    if (end === null) {
      i++
      continue
    }
    emitWithOverflowSplit(out, s, start, end, paraIndex)
    start = end
    i = end
  }

  // 段末没有句末标点的残余部分，整段作为最后一句
  if (start < s.length) emitWithOverflowSplit(out, s, start, s.length, paraIndex)
  return out
}

/**
 * 这一段参不参与跟读。
 *
 * 标题（h1/h2）与图片段不跟读。这条口径**必须**由导入侧和阅读侧共用：
 * 导入时按它决定要不要切句存表，阅读时按它决定要不要铺句子。
 * 两边各写一套的话，库里会存下阅读器永远用不到的句子 —— 实测一本把整章误判成
 * 标题的书，入库 117,423 句，阅读器只用得上 21 句。
 */
export function speaksInReadAlong(type: string): boolean {
  return type !== 'h1' && type !== 'h2' && type !== 'img'
}

/** 切分整篇文档，编号全局句序 */
export function splitSentences(
  paragraphs: { paraIndex: number; type: string; text: string }[],
): Sentence[] {
  const all: Sentence[] = []
  for (const p of paragraphs) {
    // 标题与图片不参与跟读
    if (!speaksInReadAlong(p.type)) continue
    for (const s of splitParagraph(p.text, p.paraIndex)) {
      all.push({ ...s, sentenceIndex: all.length })
    }
  }
  return all
}
