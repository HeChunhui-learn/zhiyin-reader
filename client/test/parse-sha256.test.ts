import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { sha256Hex } from '../src/features/parse/sha256'

/**
 * PA-15 内容哈希：纯 JS 实现必须与 node:crypto 逐字节一致。
 *
 * 为什么值得单独测：这个文件存在的唯一理由就是"不能用 crypto.subtle"
 * （局域网 http 下它是 undefined），所以它自己算得对不对是导入去重的全部依据。
 * 一旦算错，同一本书每次导入都会产生新文档，而且**不会报错**。
 */
describe('PA-15 内容哈希 sha256', () => {
  const cases = [
    '',
    'a',
    'abc',
    'hello world',
    '知音漫卷',
    '知音漫卷 —— 阅读应用',
    'a'.repeat(55), // padding 边界：55 → 64
    'a'.repeat(56), // 55+1 恰好填满，需要再加一块
    'a'.repeat(64),
    'a'.repeat(119),
    'a'.repeat(1000),
    // 代理对：UTF-16 里占 2 个 code unit，编码成 UTF-8 是 4 字节
    '😀🎉',
    '中文混排 emoji 😀 与 ASCII mix',
    '　全角空格　与制表\t符',
  ]

  it.each(cases)('与 node:crypto 对拍：%j', (input) => {
    const expected = createHash('sha256').update(input, 'utf8').digest('hex')
    expect(sha256Hex(input)).toBe(expected)
  })

  it('输出恒为 64 位小写十六进制', () => {
    for (const c of cases) {
      expect(sha256Hex(c)).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('同一输入重复调用结果稳定（R10 纯函数）', () => {
    const a = sha256Hex('知音漫卷')
    const b = sha256Hex('知音漫卷')
    const c = sha256Hex('知音漫卷')
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('内容变一个字符，哈希完全不同（导入去重的前提）', () => {
    expect(sha256Hex('人间词话')).not.toBe(sha256Hex('人间词话 '))
    expect(sha256Hex('第一回')).not.toBe(sha256Hex('第二回'))
  })
})
