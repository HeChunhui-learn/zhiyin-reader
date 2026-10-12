/**
 * 导入文件的文本解码。
 *
 * **不能用 `file.text()`**：`Blob.text()` 按规范只按 UTF-8 解码，遇到 GBK 编码的
 * 中文 TXT（网文很常见）会把汉字逐字节变成 U+FFFD，而且**不报错** —— 导入看着
 * "成功"，入库的却是满屏乱码，阅读器照常渲染，跟读还会去念它。
 *
 * 实测一本 1.27MB 的 GBK 小说：按 UTF-8 解出 720,397 个替换字符，按 GBK 解 0 个。
 *
 * 解码顺序：
 *   1. BOM 说了算（UTF-8 / UTF-16LE / UTF-16BE）
 *   2. 试 UTF-8，带 `fatal` —— 字节序列非法就抛错，不会静默塞替换字符
 *   3. 试 GBK
 *   4. 都失败才退回 UTF-8 的宽松模式，至少读出个大概，并在界面上说明
 *
 * 只覆盖简中常见的 GBK/GB18030。Big5（繁中）不在本期范围内 —— 那类文件会走到
 * 第 4 步并带上"可能有乱码"的提示，不会静默出错。
 */

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk'

export interface DecodedText {
  text: string
  /** 实际用的编码 */
  encoding: TextEncoding
  /** true = 没能确定编码，走了宽松兜底，文本里可能仍有替换字符 */
  uncertain: boolean
}

/** BOM 优先：文件自己声明了编码，不必猜 */
function sniffBom(b: Uint8Array): TextEncoding | null {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8'
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return 'utf-16le'
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return 'utf-16be'
  return null
}

/** 严格解码；字节序列非法则返回 null（不产生替换字符） */
function strictDecode(bytes: Uint8Array, encoding: TextEncoding): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** 宽松解码：非法处塞 U+FFFD，用于最后兜底 */
function looseDecode(bytes: Uint8Array, encoding: TextEncoding): string {
  return new TextDecoder(encoding).decode(bytes)
}

export async function decodeFileText(file: File): Promise<DecodedText> {
  const bytes = new Uint8Array(await file.arrayBuffer())

  const bom = sniffBom(bytes)
  if (bom) return { text: looseDecode(bytes, bom), encoding: bom, uncertain: false }

  const utf8 = strictDecode(bytes, 'utf-8')
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8', uncertain: false }

  const gbk = strictDecode(bytes, 'gbk')
  if (gbk !== null) return { text: gbk, encoding: 'gbk', uncertain: false }

  return { text: looseDecode(bytes, 'utf-8'), encoding: 'utf-8', uncertain: true }
}

/** 给界面显示用的一句话说明；正常情况（UTF-8）返回空串 */
export function encodingNote(d: DecodedText): string {
  if (d.uncertain) return ' · 编码未识别，正文可能有乱码'
  if (d.encoding === 'gbk') return ' · 按 GBK 解码'
  if (d.encoding !== 'utf-8') return ` · 按 ${d.encoding.toUpperCase()} 解码`
  return ''
}
