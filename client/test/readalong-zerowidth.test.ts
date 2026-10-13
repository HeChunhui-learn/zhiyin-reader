import { describe, expect, it } from 'vitest'
import { normalizeText } from '../src/features/parse/types'
import { normalize, splitParagraph } from '../src/features/readalong/splitSentences'

/**
 * R7 零宽字符的两处实现**并不一致**（测试过程中发现的）。
 *
 * `.context/02` 的 R7 要求"切分前剔除零宽字符"，两个模块各实现了一份：
 *   · `client/src/features/parse/types.ts:63` 的 `normalizeText`
 *   · `client/src/features/readalong/splitSentences.ts:67` 的 `ZERO_WIDTH`
 * 后者的注释写着"与 features/parse/types.ts 的口径对齐"，**实际没有对齐** ——
 * 它多收了 U+2060（词连接符 WORD JOINER）。
 *
 * 后果：导入时 `normalizeText` 保留 U+2060，切句时 `normalize` 把它删掉，
 * 于是句子的 `startOffset` / `endOffset` 是相对**短了一个字符**的串算出来的。
 * 段落文本与句子偏移量对不上，锚点的 `charOffset` 与高亮范围会偏移。
 *
 * 这份用例把现状**如实钉住**（断言写成当前的实际行为，不改产品代码），
 * 差异本身登记在测试报告里，交回项目组决定以哪一侧为准。
 */
describe('R7 零宽字符：两处实现的口径差异（发现的缺陷）', () => {
  it('两处都剔除 U+200B / U+200C / U+200D / U+FEFF', () => {
    for (const zw of ['\u200b', '\u200c', '\u200d', '\ufeff']) {
      expect(normalizeText(`甲${zw}乙`), `parse/types ${zw}`).toBe('甲乙')
      expect(normalize(`甲${zw}乙`), `splitSentences ${zw}`).toBe('甲乙')
    }
  })

  it('★ 差异：U+2060（词连接符）只有 splitSentences 剔除', () => {
    expect(normalizeText('甲\u2060乙')).toBe('甲\u2060乙') // 保留 —— parse/types.ts 没收
    expect(normalize('甲\u2060乙')).toBe('甲乙') // 剔除 —— splitSentences.ts 收了
  })

  it('★ 差异的后果：含 U+2060 的段落，句子偏移量与段落文本对不上', () => {
    const para = '甲\u2060乙。丙。' // 甲 U+2060 乙 。 丙 。 = 6 个 code unit
    const sentences = splitParagraph(para, 0) // 切句时先 normalize 掉 U+2060（5 个）

    expect(para.length).toBe(6)
    expect(normalize(para).length).toBe(5)

    // 第二句的偏移量是相对剔除后的串算的，直接拿去切原段落会错位
    const second = sentences[1]
    expect(para.slice(second.startOffset, second.endOffset)).not.toBe(second.text)
    // 用归一化后的串切才对得上
    expect(normalize(para).slice(second.startOffset, second.endOffset)).toBe(second.text)
  })

  it('不含 U+2060 时两处一致，偏移量也对得上（多数真实文本属于这一类）', () => {
    const para = '甲。乙。'
    expect(normalizeText(para)).toBe(para)
    expect(normalize(para)).toBe(para)
    for (const s of splitParagraph(para, 0)) {
      expect(para.slice(s.startOffset, s.endOffset)).toBe(s.text)
    }
  })
})

describe('R7 零宽字符的常规口径（两处一致的部分）', () => {
  it('剔除 U+200E / U+200F（方向标记）', () => {
    expect(normalizeText('甲\u200e乙')).toBe('甲乙')
    expect(normalize('甲\u200e乙')).toBe('甲乙')
    expect(normalizeText('甲\u200f乙')).toBe('甲乙')
    expect(normalize('甲\u200f乙')).toBe('甲乙')
  })

  it('BOM 在段首与段中都剔除', () => {
    expect(normalizeText('\ufeff甲')).toBe('甲')
    expect(normalize('\ufeff甲')).toBe('甲')
    expect(normalizeText('甲\ufeff乙')).toBe('甲乙')
  })
})
