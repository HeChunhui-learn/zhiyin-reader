import { describe, expect, it } from 'vitest'
import { headingLevel, joinLines, normalizeText, stripExt } from '../src/features/parse/types'

/**
 * PA-01 ~ PA-08 的公共底座：段落与标题的判定规则。
 *
 * `joinLines` 那条"中文之间不补空格"是这个文件里最容易写错的一处 ——
 * 补了空格的话，「知音」会被拆成「知 音」，逐句跟读念出来就是断的。
 */
describe('段落与标题判定（parse/types）', () => {
  describe('headingLevel', () => {
    it('第 X 章 / 卷 / 部 / 篇 / 回 判一级标题', () => {
      for (const t of ['第一章', '第 1 章', '第三卷', '第二部', '第五篇', '第十二回']) {
        expect(headingLevel(t), t).toBe(1)
      }
    })

    it('第 X 节 判二级标题', () => {
      for (const t of ['第一节', '第 2 节']) {
        expect(headingLevel(t), t).toBe(2)
      }
    })

    it('中文数字与阿拉伯数字都认', () => {
      expect(headingLevel('第九章')).toBe(1)
      expect(headingLevel('第9章')).toBe(1)
      expect(headingLevel('第一百零八章')).toBe(1)
    })

    it('# 开头按井号数量：一个 h1，两个以上 h2', () => {
      expect(headingLevel('# 标题')).toBe(1)
      expect(headingLevel('## 标题')).toBe(2)
      expect(headingLevel('### 标题')).toBe(2)
      expect(headingLevel('###### 标题')).toBe(2)
    })

    it('井号后必须有内容，`#` 单独一行不算标题', () => {
      expect(headingLevel('#')).toBe(0)
      expect(headingLevel('# ')).toBe(0)
    })

    it('普通正文不是标题', () => {
      expect(headingLevel('这是一段正文。')).toBe(0)
      expect(headingLevel('第一章的读后感')).toBe(1) // 前缀匹配，属已知口径
    })
  })

  describe('joinLines —— PA-04 段内换行合并', () => {
    it('中文之间不补空格', () => {
      expect(joinLines(['知音', '漫卷'])).toBe('知音漫卷')
    })

    it('英文之间补一个空格', () => {
      expect(joinLines(['hello', 'world'])).toBe('hello world')
    })

    it('中英交界补空格（中文后接英文）', () => {
      expect(joinLines(['中文', 'English'])).toBe('中文 English')
    })

    it('英中交界补空格（英文后接中文）', () => {
      expect(joinLines(['English', '中文'])).toBe('English 中文')
    })

    it('空行被跳过，不会产生连续空格', () => {
      expect(joinLines(['甲', '', '   ', '乙'])).toBe('甲乙')
    })

    it('每行两侧空白先 trim', () => {
      expect(joinLines(['  甲  ', '  乙  '])).toBe('甲乙')
    })

    it('单行原样返回', () => {
      expect(joinLines(['就这一行'])).toBe('就这一行')
    })

    it('空数组返回空串', () => {
      expect(joinLines([])).toBe('')
    })
  })

  describe('normalizeText —— R7 剔除零宽字符', () => {
    it('去掉零宽空格与 BOM', () => {
      expect(normalizeText('知\u200b音\ufeff漫卷')).toBe('知音漫卷')
    })

    it('★ 词连接符 U+2060 这里**不**剔除（与 splitSentences 口径不一致，见 readalong-zerowidth.test.ts）', () => {
      expect(normalizeText('a\u2060b')).toBe('a\u2060b')
    })

    it('CRLF 与 CR 统一成 LF', () => {
      expect(normalizeText('甲\r\n乙\r丙\n丁')).toBe('甲\n乙\n丙\n丁')
    })

    it('普通换行保持不动', () => {
      expect(normalizeText('甲\n乙')).toBe('甲\n乙')
    })
  })

  describe('stripExt', () => {
    it('去掉最后一个扩展名', () => {
      expect(stripExt('人间词话.txt')).toBe('人间词话')
      expect(stripExt('book.epub')).toBe('book')
    })

    it('没有扩展名时原样返回', () => {
      expect(stripExt('人间词话')).toBe('人间词话')
    })

    it('多个点只去掉最后一段', () => {
      expect(stripExt('a.b.txt')).toBe('a.b')
    })
  })
})
